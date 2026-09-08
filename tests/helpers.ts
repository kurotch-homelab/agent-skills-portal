import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { c, Header } from "tar";
import { gzipSync } from "node:zlib";
import { integrity } from "../packages/core/src/index.ts";

export async function temporary() {
  const root = resolve(".cache/tests");
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "case-"));
  return {
    path,
    async cleanup() {
      if (!path.startsWith(root + "\\") && !path.startsWith(root + "/"))
        throw new Error("test cleanup escaped");
      await rm(path, { recursive: true, force: true });
    },
  };
}
export async function packageFixture(
  root: string,
  version = "1.0.0",
  extra: Record<string, string> = {},
) {
  const cwd = join(
    root,
    `fixture-${version}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(join(cwd, "package"), { recursive: true });
  const manifest = {
    name: "@test/guide",
    version,
    repository: { type: "git", url: "git+https://github.com/test/source.git" },
    files: ["SKILL.md", "references"],
    agentSkill: {
      compatibleAgents: ["codex", "claude"],
      dataMode: "hybrid",
      requirements: {
        environment: [
          { name: "SERVICE_TOKEN", description: "利用者の環境で設定" },
        ],
        endpoints: ["https://service.example.test/"],
        commands: [],
      },
    },
    keywords: ["knowledge"],
  };
  const content = {
    "package.json": JSON.stringify(manifest),
    "SKILL.md": `---\nname: test-guide\ndescription: テスト用の資料を参照する skill\n---\n# 資料を参照\nreferences/data.md を参照。実行時は SERVICE_TOKEN を利用。\n`,
    "references/data.md": `snapshot ${version}`,
    ...extra,
  };
  for (const [p, body] of Object.entries(content)) {
    await mkdir(dirname(join(cwd, "package", p)), { recursive: true });
    await writeFile(join(cwd, "package", p), body);
  }
  const file = join(cwd, "result.tgz");
  await c({ cwd, file, gzip: true, portable: true }, ["package"]);
  return {
    bytes: await readFile(file),
    manifest,
    directory: join(cwd, "package"),
  };
}
export function maliciousArchive(
  path: string,
  type: "File" | "SymbolicLink" = "File",
  linkpath?: string,
) {
  const header = new Header({
    path,
    type,
    size: type === "File" ? 1 : 0,
    mode: 0o644,
    uid: 0,
    gid: 0,
    linkpath,
  });
  header.encode();
  return gzipSync(
    Buffer.concat([
      header.block!,
      ...(type === "File"
        ? [Buffer.concat([Buffer.from("x"), Buffer.alloc(511)])]
        : []),
      Buffer.alloc(1024),
    ]),
  );
}
export async function server(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const requests: { path: string; authorization?: string }[] = [];
  const http = createServer((req, res) => {
    requests.push({ path: req.url!, authorization: req.headers.authorization });
    Promise.resolve(handler(req, res)).catch((e) => {
      res.statusCode = 500;
      res.end(e.message);
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () =>
      new Promise<void>((r, j) => {
        http.closeAllConnections();
        http.close((e) => (e ? j(e) : r()));
      }),
  };
}
export async function registry(requireAuthentication = true) {
  const versions: Record<string, Buffer> = {};
  let tags: Record<string, string> = {};
  let corrupt = false;
  const app = await server(async (req, res) => {
    if (
      requireAuthentication &&
      req.headers.authorization !== "Bearer test-token"
    ) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      for (const [v, data] of Object.entries(body.versions) as [
        string,
        any,
      ][]) {
        const attachment = Object.values(body._attachments)[0] as {
          data: string;
        };
        versions[v] = Buffer.from(attachment.data, "base64");
      }
      tags = { ...tags, ...body["dist-tags"] };
      res.statusCode = 201;
      res.end("{}");
      return;
    }
    if (req.url?.startsWith("/tar/")) {
      const v = req.url.slice(5);
      const bytes = versions[v];
      if (!bytes) {
        res.statusCode = 404;
        res.end();
      } else res.end(corrupt ? Buffer.from("corrupt") : bytes);
      return;
    }
    if (decodeURIComponent(req.url!) !== "/@test/guide") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: "@test/guide",
        "dist-tags": tags,
        versions: Object.fromEntries(
          Object.entries(versions).map(([v, b]) => [
            v,
            {
              name: "@test/guide",
              version: v,
              dist: { tarball: `${app.url}tar/${v}`, integrity: integrity(b) },
            },
          ]),
        ),
        time: {},
      }),
    );
  });
  return {
    ...app,
    versions,
    setTags(t: Record<string, string>) {
      tags = t;
    },
    corrupt(value = true) {
      corrupt = value;
    },
  };
}

export function lockedFixture(
  registry: string,
  bytes: Buffer,
  version = "1.0.0",
) {
  const dependencies = { "@test/guide": version };
  return {
    manifest: { private: true, dependencies },
    lock: {
      lockfileVersion: 3,
      packages: {
        "": { dependencies },
        "node_modules/@test/guide": {
          version,
          resolved: `${registry}tar/${version}`,
          integrity: integrity(bytes),
        },
      },
    },
  };
}
