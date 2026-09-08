import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import { parseDocument } from "yaml";
import semver from "semver";
import { z } from "zod";
import {
  metadataSchema,
  packageName,
  skillName,
  type CatalogPackage,
  type SkillVersion,
} from "./schema.ts";
export * from "./schema.ts";

export const MAX_ARCHIVE = 32 * 1024 * 1024;
export const MAX_EXPANDED = 128 * 1024 * 1024;
export const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
export const integrity = (data: Buffer) =>
  `sha512-${createHash("sha512").update(data).digest("base64")}`;
export function assertIntegrity(data: Buffer, expected: string) {
  if (integrity(data) !== expected)
    throw new Error("配布ファイルの integrity が一致しません");
}

export function safePath(value: string): string {
  const parts = value.split("/");
  if (
    !value ||
    value.length > 220 ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[\\<>:"|?*\x00-\x1f]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error(`安全でないパス: ${value}`);
  return value;
}

export async function readArchive(
  archive: Buffer,
): Promise<Map<string, Buffer>> {
  if (archive.length > MAX_ARCHIVE)
    throw new Error("アーカイブが 32 MiB を超えています");
  const raw = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED });
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        try {
          if (++count > 4096) throw new Error("ファイル数が上限を超えています");
          const full = entry.path.replace(/\/$/, "");
          safePath(full);
          if (full !== "package" && !full.startsWith("package/"))
            throw new Error("npm package/ 以外のファイルがあります");
          if (entry.type !== "File" && entry.type !== "Directory")
            throw new Error("リンク・特殊ファイルは配布できません");
          if (entry.type === "Directory") {
            entry.resume();
            return;
          }
          const path = full.slice(8);
          safePath(path);
          if (seen.has(path.toLowerCase()))
            throw new Error(`重複パス: ${path}`);
          seen.add(path.toLowerCase());
          if (
            path
              .split("/")
              .some((p) =>
                /^(\.git|\.npmrc|\.env(?:\..*)?|node_modules|\.sv-skills)$/i.test(
                  p,
                ),
              ) ||
            /\.(pem|key)$/i.test(path)
          )
            throw new Error(`配布禁止ファイル: ${path}`);
          const chunks: Buffer[] = [];
          entry.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          entry.on("end", () => files.set(path, Buffer.concat(chunks)));
        } catch (error) {
          failure = error as Error;
          entry.resume();
        }
      },
    });
    parser.on("error", reject);
    parser.on("end", () => (failure ? reject(failure) : resolve()));
    parser.end(raw);
  });
  if (!files.size) throw new Error("空のパッケージです");
  for (const key of files.keys()) {
    const parts = key.toLowerCase().split("/");
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/")))
        throw new Error("ファイルとディレクトリが衝突しています");
      parts.pop();
    }
  }
  return files;
}

const manifestSchema = z.object({
  name: packageName,
  version: z.string().refine((v) => semver.valid(v) === v, "SemVer が必要です"),
  description: z.string().default(""),
  keywords: z.array(z.string()).default([]),
  agentSkill: metadataSchema,
  dependencies: z.record(z.string(), z.unknown()).optional(),
  optionalDependencies: z.record(z.string(), z.unknown()).optional(),
  peerDependencies: z.record(z.string(), z.unknown()).optional(),
});
export async function inspectPackage(archive: Buffer) {
  const files = await readArchive(archive);
  const manifest = manifestSchema.parse(
    JSON.parse(files.get("package.json")?.toString("utf8") ?? "null"),
  );
  if (
    [
      manifest.dependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ].some((v) => v && Object.keys(v).length)
  )
    throw new Error("skill の実行時 npm 依存はバンドルしてください");
  const markdown = files.get("SKILL.md")?.toString("utf8");
  if (!markdown || Buffer.byteLength(markdown) > 256 * 1024)
    throw new Error("SKILL.md がないか 256 KiB を超えています");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("SKILL.md の YAML frontmatter が必要です");
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error("SKILL.md の YAML が不正です");
  const frontmatter = z
    .object({ name: skillName, description: z.string().min(1).max(4096) })
    .parse(doc.toJS({ maxAliasCount: 0 }));
  return { files, manifest, markdown, frontmatter };
}

export function resolveVersion(
  pkg: CatalogPackage,
  selector = "latest",
): SkillVersion {
  if (pkg.withdrawn) throw new Error(`${pkg.name} は配布停止中です`);
  const version =
    semver.valid(selector) === selector ? selector : pkg.distTags[selector];
  const result = version && pkg.versions[version];
  if (!result || result.withdrawn)
    throw new Error(`${pkg.name}@${selector} は取得できません`);
  return result;
}

export function parseSpec(spec: string) {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const selector = at > 0 ? spec.slice(at + 1) : "latest";
  packageName.parse(name);
  if (!selector || !/^[a-zA-Z0-9._+-]+$/.test(selector))
    throw new Error("バージョンまたは dist-tag を指定してください");
  return { name, selector, pinned: semver.valid(selector) === selector };
}

export function checkedUrl(input: string, base?: string): URL {
  const url = new URL(input, base);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("HTTPS URL が必要です（ローカル検証のみ HTTP 可）");
  return url;
}

export async function download(
  url: URL,
  options: { token?: string; maxBytes?: number; allow404?: boolean } = {},
): Promise<Buffer | null> {
  checkedUrl(url.href);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
  if (options.allow404 && response.status === 404) return null;
  if (!response.ok)
    throw new Error(`${url.origin}${url.pathname}: HTTP ${response.status}`);
  const limit = options.maxBytes ?? MAX_ARCHIVE;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body!) {
    size += chunk.length;
    if (size > limit) throw new Error("応答サイズが上限を超えています");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
