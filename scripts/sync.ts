import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { z } from "zod";

import {
  catalogSchema,
  emptyCatalog,
  checkedUrl,
  download,
  inspectPackage,
  integrity,
  sha256,
  packageName,
  type Catalog,
  type CatalogPackage,
} from "../packages/core/src/index.ts";

const dependencies = z.record(packageName, z.string());
const manifestSchema = z.object({
  private: z.literal(true),
  dependencies: dependencies.default({}),
  devDependencies: dependencies.optional(),
  optionalDependencies: dependencies.optional(),
  peerDependencies: dependencies.optional(),
  workspaces: z.unknown().optional(),
});
const lockSchema = z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(
    z.string(),
    z.object({
      version: z.string().optional(),
      resolved: z.string().optional(),
      integrity: z.string().optional(),
      link: z.boolean().optional(),
      dependencies: dependencies.optional(),
      optionalDependencies: dependencies.optional(),
      peerDependencies: dependencies.optional(),
      devDependencies: dependencies.optional(),
    }),
  ),
});
const withdrawalSchema = z
  .object({
    packages: z.record(
      packageName,
      z
        .object({
          withdrawn: z.boolean().default(false),
          withdrawnVersions: z
            .array(z.string().refine((v) => semver.valid(v) === v))
            .default([]),
        })
        .strict(),
    ),
  })
  .strict();

/** npm generates the lock; validate the narrower registry-only, standalone-skill contract. */
export function lockedPackages(
  manifestInput: unknown,
  lockInput: unknown,
  registryInput: string,
) {
  const manifest = manifestSchema.parse(manifestInput);
  const lock = lockSchema.parse(lockInput);
  if (
    manifest.workspaces ||
    [
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ].some((d) => d && Object.keys(d).length)
  )
    throw new Error(
      "catalog は直接の skill dependencies だけを管理してください",
    );
  const root = lock.packages[""];
  if (
    !root ||
    JSON.stringify(Object.entries(root.dependencies ?? {}).sort()) !==
      JSON.stringify(Object.entries(manifest.dependencies).sort())
  )
    throw new Error(
      "package.json と lockfile が一致しません。npm install で更新してください",
    );
  const registry = checkedUrl(
    registryInput.endsWith("/") ? registryInput : registryInput + "/",
  );
  const result = Object.entries(manifest.dependencies).map(([name, range]) => {
    const entry = lock.packages[`node_modules/${name}`];
    if (
      !semver.validRange(range) ||
      !entry?.version ||
      semver.valid(entry.version) !== entry.version ||
      !semver.satisfies(entry.version, range)
    )
      throw new Error(`${name}: lockfile の版と SemVer 指定が一致しません`);
    if (
      entry.link ||
      [
        entry.dependencies,
        entry.optionalDependencies,
        entry.peerDependencies,
      ].some((d) => d && Object.keys(d).length)
    )
      throw new Error("skill のリンク・推移的な npm 依存は使用できません");
    if (
      !entry.resolved ||
      !entry.integrity ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
    )
      throw new Error("lockfile に resolved と SHA-512 integrity が必要です");
    const url = checkedUrl(entry.resolved);
    if (
      url.origin !== registry.origin ||
      !url.pathname.startsWith(registry.pathname)
    )
      throw new Error(
        "lockfile の tarball は設定した registry 内に配置してください",
      );
    return { name, version: entry.version, url, integrity: entry.integrity };
  });
  if (Object.keys(lock.packages).length !== result.length + 1)
    throw new Error("lockfile に未登録パッケージ・推移的依存があります");
  return result;
}

export async function syncRegistry(options: {
  registry: string;
  token?: string;
  manifest: unknown;
  lock: unknown;
  withdrawals?: unknown;
  previous?: Catalog;
  output: string;
  now?: string;
}): Promise<Catalog> {
  const selected = lockedPackages(
    options.manifest,
    options.lock,
    options.registry,
  );
  const withdrawals = withdrawalSchema.parse(
    options.withdrawals ?? { packages: {} },
  ).packages;
  const previous = catalogSchema.parse(options.previous ?? emptyCatalog());
  for (const name of Object.keys(withdrawals))
    if (
      !selected.some((p) => p.name === name) &&
      !previous.packages.some((p) => p.name === name)
    )
      throw new Error(`${name}: 配布停止設定のパッケージが見つかりません`);
  const packages: CatalogPackage[] = previous.packages
    .filter((p) => !selected.some((s) => s.name === p.name))
    .map((p) => ({ ...structuredClone(p), withdrawn: true }));
  await mkdir(join(options.output, "artifacts"), { recursive: true });
  for (const selection of selected) {
    const old = previous.packages.find((p) => p.name === selection.name);
    const cached = old?.versions[selection.version];
    if (cached && cached.integrity !== selection.integrity)
      throw new Error(
        `${selection.name}@${selection.version} の内容が変更されています`,
      );
    let pkg: CatalogPackage;
    if (cached) {
      pkg = structuredClone(old!);
    } else {
      const bytes = (await download(selection.url, { token: options.token }))!;
      if (integrity(bytes) !== selection.integrity)
        throw new Error("lockfile の integrity が一致しません");
      const inspected = await inspectPackage(bytes);
      if (
        inspected.manifest.name !== selection.name ||
        inspected.manifest.version !== selection.version
      )
        throw new Error("tarball の名前・バージョンが lockfile と一致しません");
      const raw = JSON.parse(
        inspected.files.get("package.json")!.toString("utf8"),
      );
      const repository =
        typeof raw.repository === "string"
          ? raw.repository
          : raw.repository?.url;
      if (typeof repository !== "string")
        throw new Error("skill の package.json に repository が必要です");
      const repositoryUrl = checkedUrl(
        repository.replace(/^git\+/, "").replace(/\.git$/, ""),
      );
      const artifact = `artifacts/${sha256(bytes)}.tgz`;
      await writeFile(join(options.output, artifact), bytes);
      pkg = {
        name: selection.name,
        repository: repositoryUrl.href,
        keywords: inspected.manifest.keywords,
        distTags: {},
        versions: structuredClone(old?.versions ?? {}),
        withdrawn: false,
      };
      pkg.versions[selection.version] = {
        version: selection.version,
        integrity: selection.integrity,
        artifact,
        skillName: inspected.frontmatter.name,
        description: inspected.frontmatter.description,
        markdown: inspected.markdown,
        metadata: inspected.manifest.agentSkill,
        publishedAt: options.now ?? new Date().toISOString(),
        withdrawn: false,
      };
    }
    // Portal latest is the reviewed lockfile selection, never the registry's mutable tag.
    pkg.distTags = { latest: selection.version };
    pkg.withdrawn = withdrawals[selection.name]?.withdrawn ?? false;
    packages.push(pkg);
  }
  for (const pkg of packages)
    for (const [version, info] of Object.entries(pkg.versions))
      info.withdrawn =
        withdrawals[pkg.name]?.withdrawnVersions.includes(version) ?? false;
  const catalog = catalogSchema.parse({
    schemaVersion: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
  });
  await writeFile(
    join(options.output, "catalog.json"),
    JSON.stringify(catalog, null, 2) + "\n",
  );
  return catalog;
}
