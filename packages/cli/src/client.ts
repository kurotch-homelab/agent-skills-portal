import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  catalogSchema,
  checkedUrl,
  download,
  parseSpec,
  resolveVersion,
  inspectPackage,
  assertIntegrity,
  sha256,
  type Agent,
  type Catalog,
} from "../../core/src/index.ts";
import { Store, type Installed } from "./store.ts";

export function targetRoot(agent: Agent, project?: string, home = homedir()) {
  return resolve(
    project ?? home,
    agent === "codex" ? ".agents/skills" : ".claude/skills",
  );
}
export class Client {
  readonly portal: URL;
  constructor(portal: string) {
    this.portal = checkedUrl(portal.endsWith("/") ? portal : `${portal}/`);
  }
  async catalog(): Promise<Catalog> {
    const bytes = (await download(new URL("catalog.json", this.portal), {
      maxBytes: 32 * 1024 * 1024,
    }))!;
    return catalogSchema.parse(JSON.parse(bytes.toString("utf8")));
  }
  async install(
    spec: string,
    agent: Agent,
    store: Store,
    catalog?: Catalog,
    pinnedOverride?: boolean,
  ) {
    const parsed = parseSpec(spec);
    const pkg = (catalog ?? (await this.catalog())).packages.find(
      (p) => p.name === parsed.name,
    );
    if (!pkg) throw new Error(`${parsed.name} は登録されていません`);
    const version = resolveVersion(pkg, parsed.selector);
    if (!version.metadata.compatibleAgents.includes(agent))
      throw new Error(`${pkg.name} は ${agent} に対応していません`);
    const bytes = (await download(new URL(version.artifact, this.portal)))!;
    assertIntegrity(bytes, version.integrity);
    const inspected = await inspectPackage(bytes);
    if (
      inspected.manifest.name !== pkg.name ||
      inspected.manifest.version !== version.version ||
      inspected.frontmatter.name !== version.skillName ||
      !inspected.manifest.agentSkill.compatibleAgents.includes(agent)
    )
      throw new Error("カタログとパッケージの情報が一致しません");
    const record: Installed = {
      name: pkg.name,
      version: version.version,
      selector: parsed.selector,
      pinned: pinnedOverride ?? parsed.pinned,
      slug: version.skillName,
      agent,
      portal: this.portal.href,
      hashes: Object.fromEntries(
        [...inspected.files].map(([p, b]) => [p, sha256(b)]),
      ),
      integrity: version.integrity,
    };
    await store.locked(async () => {
      const old = (await store.state()).installed.find(
        (r) => r.name === pkg.name,
      );
      if (old && old.portal !== this.portal.href)
        throw new Error("配布元の変更はアンインストール後に実行してください");
      await store.replace(record, inspected.files);
    });
    return record;
  }
  async update(name: string, store: Store, catalog?: Catalog) {
    // Hold a lock across resolution and download so a concurrent pin cannot be lost.
    return store.locked(async () => {
      const old = (await store.state()).installed.find((r) => r.name === name);
      if (!old) throw new Error(`${name} はインストールされていません`);
      if (old.portal !== this.portal.href)
        throw new Error("導入時の --portal を指定してください");
      if (old.pinned) return { ...old, skipped: true };
      const pkg = (catalog ?? (await this.catalog())).packages.find(
        (p) => p.name === name,
      );
      if (!pkg) throw new Error(`${name} は配布カタログにありません`);
      const version = resolveVersion(pkg, old.selector);
      if (version.version === old.version) {
        await store.assertUnmodified(old);
        return { ...old, skipped: true };
      }
      const bytes = (await download(new URL(version.artifact, this.portal)))!;
      assertIntegrity(bytes, version.integrity);
      const inspected = await inspectPackage(bytes);
      if (
        inspected.manifest.name !== name ||
        inspected.manifest.version !== version.version ||
        inspected.frontmatter.name !== version.skillName ||
        !inspected.manifest.agentSkill.compatibleAgents.includes(old.agent)
      )
        throw new Error("更新パッケージが対応していません");
      const next: Installed = {
        ...old,
        version: version.version,
        integrity: version.integrity,
        slug: version.skillName,
        hashes: Object.fromEntries(
          [...inspected.files].map(([p, b]) => [p, sha256(b)]),
        ),
      };
      await store.replace(next, inspected.files);
      return { ...next, skipped: false };
    });
  }
}
