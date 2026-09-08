import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  symlink,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { syncRegistry } from "../scripts/sync.ts";
import { Client, targetRoot } from "../packages/cli/src/client.ts";
import { Store } from "../packages/cli/src/store.ts";
import {
  emptyCatalog,
  inspectPackage,
  parseSpec,
  checkedUrl,
  download,
  type Catalog,
} from "../packages/core/src/index.ts";
import {
  temporary,
  packageFixture,
  registry,
  server,
  maliciousArchive,
  lockedFixture,
} from "./helpers.ts";

test("npm publish → authenticated registry → mirror → install / update / pin / rollback / offline uninstall", async (t) => {
  const tmp = await temporary();
  const reg = await registry();
  t.after(async () => {
    await reg.close();
    await tmp.cleanup();
  });
  const fixture = await packageFixture(tmp.path);
  const config = join(tmp.path, ".npmrc");
  await writeFile(
    config,
    `registry=${reg.url}\n//${new URL(reg.url).host}/:_authToken=test-token\n`,
  );
  const npm = process.env.npm_execpath!;
  assert.ok(npm, "Run via npm test");
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [npm, "publish", "--ignore-scripts", "--registry", reg.url],
      {
        cwd: fixture.directory,
        env: {
          ...process.env,
          NPM_CONFIG_USERCONFIG: config,
          NPM_CONFIG_CACHE: join(tmp.path, "npm-cache"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? done() : reject(new Error(output)),
    );
  });
  assert.ok(reg.versions["1.0.0"]);
  const output = join(tmp.path, "portal");
  let catalog = await syncRegistry({
    registry: reg.url,
    token: "test-token",
    ...lockedFixture(reg.url, reg.versions["1.0.0"]),
    output,
  });
  const portal = await server(async (req, res) => {
    try {
      res.end(
        await readFile(join(output, decodeURIComponent(req.url!.slice(1)))),
      );
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  t.after(() => portal.close());
  const client = new Client(portal.url);
  for (const agent of ["codex", "claude"] as const) {
    const store = new Store(targetRoot(agent, tmp.path));
    await client.install("@test/guide", agent, store);
    assert.match(
      await readFile(
        join(store.root, "test-guide", "references/data.md"),
        "utf8",
      ),
      /1.0.0/,
    );
  }
  const store = new Store(targetRoot("codex", tmp.path));
  reg.versions["1.1.0"] = (await packageFixture(tmp.path, "1.1.0")).bytes;
  reg.versions["2.0.0-beta.1"] = (
    await packageFixture(tmp.path, "2.0.0-beta.1")
  ).bytes;
  reg.setTags({ latest: "1.1.0", beta: "2.0.0-beta.1" });
  catalog = await syncRegistry({
    registry: reg.url,
    token: "test-token",
    ...lockedFixture(reg.url, reg.versions["1.1.0"], "1.1.0"),
    output,
    previous: catalog,
  });
  await store.locked(() => store.pin("@test/guide", true));
  assert.equal((await client.update("@test/guide", store)).version, "1.0.0");
  await store.locked(() => store.pin("@test/guide", false));
  assert.equal((await client.update("@test/guide", store)).version, "1.1.0");
  catalog = await syncRegistry({
    registry: reg.url,
    token: "test-token",
    ...lockedFixture(reg.url, reg.versions["2.0.0-beta.1"], "2.0.0-beta.1"),
    output,
    previous: catalog,
  });
  await client.install("@test/guide@2.0.0-beta.1", "codex", store);
  assert.equal((await store.state()).installed[0].version, "2.0.0-beta.1");
  await client.install("@test/guide@1.0.0", "codex", store);
  assert.equal((await store.state()).installed[0].pinned, true);
  assert.ok(
    portal.requests.every((r) => !r.authorization),
    "portal reads require no registry credentials",
  );
  const before = await readFile(join(store.meta, "state.json"), "utf8");
  await writeFile(
    join(store.root, "test-guide", "references/data.md"),
    "my changes",
  );
  await assert.rejects(
    client.install("@test/guide@1.1.0", "codex", store),
    /手動変更/,
  );
  assert.equal(await readFile(join(store.meta, "state.json"), "utf8"), before);
  await writeFile(
    join(store.root, "test-guide", "references/data.md"),
    "snapshot 1.0.0",
  );
  const networkReads = portal.requests.length;
  await store.locked(async () =>
    store.replace((await store.state()).installed[0], null),
  );
  assert.equal(portal.requests.length, networkReads);
  assert.equal((await store.state()).installed.length, 0);
  await assert.rejects(lstat(join(store.root, "test-guide")), {
    code: "ENOENT",
  });
});

test("reconciliation is idempotent, preserves history and rejects version replacement without publishing", async (t) => {
  const tmp = await temporary();
  const reg = await registry();
  t.after(async () => {
    await reg.close();
    await tmp.cleanup();
  });
  reg.versions["1.0.0"] = (await packageFixture(tmp.path)).bytes;
  reg.setTags({ latest: "1.0.0" });
  const output = join(tmp.path, "out");
  const options = {
    registry: reg.url,
    token: "test-token",
    ...lockedFixture(reg.url, reg.versions["1.0.0"]),
    output,
  };
  const first = await syncRegistry(options);
  const before = reg.requests.filter((r) => r.path.startsWith("/tar/")).length;
  const second = await syncRegistry({ ...options, previous: first });
  assert.deepEqual(second.packages, first.packages);
  assert.equal(
    reg.requests.filter((r) => r.path.startsWith("/tar/")).length,
    before,
  );
  delete reg.versions["1.0.0"];
  reg.setTags({});
  const retained = await syncRegistry({ ...options, previous: second });
  assert.ok(retained.packages[0].versions["1.0.0"]);
  reg.versions["1.0.0"] = (
    await packageFixture(tmp.path, "1.0.0", { "references/data.md": "changed" })
  ).bytes;
  const saved = await readFile(join(output, "catalog.json"), "utf8");
  await assert.rejects(
    syncRegistry({
      ...options,
      ...lockedFixture(reg.url, reg.versions["1.0.0"]),
      previous: retained,
    }),
    /変更されています/,
  );
  assert.equal(await readFile(join(output, "catalog.json"), "utf8"), saved);
  const withdrawn = await syncRegistry({
    ...options,
    manifest: { private: true, dependencies: {} },
    lock: { lockfileVersion: 3, packages: { "": { dependencies: {} } } },
    previous: retained,
  });
  assert.equal(withdrawn.packages[0].withdrawn, true);
});

test("bad integrity and bad manifests never publish a catalog", async (t) => {
  const tmp = await temporary();
  const reg = await registry();
  t.after(async () => {
    await reg.close();
    await tmp.cleanup();
  });
  reg.versions["1.0.0"] = (await packageFixture(tmp.path)).bytes;
  reg.setTags({ latest: "1.0.0" });
  reg.corrupt();
  const output = join(tmp.path, "out");
  await assert.rejects(
    syncRegistry({
      registry: reg.url,
      token: "test-token",
      ...lockedFixture(reg.url, reg.versions["1.0.0"]),
      output,
    }),
    /integrity/,
  );
  await assert.rejects(lstat(join(output, "catalog.json")), { code: "ENOENT" });
  const fixture = await packageFixture(tmp.path, "1.0.0", {
    "SKILL.md": "no frontmatter",
  });
  await assert.rejects(inspectPackage(fixture.bytes), /frontmatter/);
});

test("archives reject traversal, Windows aliases, symlinks, credential files and dependency installs", async (t) => {
  const tmp = await temporary();
  t.after(() => tmp.cleanup());
  for (const path of [
    "package/../escaped",
    "package/C:/escaped",
    "package/CON.txt",
    "package/a\\b",
    "package/.env",
    "outside/data",
  ])
    await assert.rejects(inspectPackage(maliciousArchive(path)));
  await assert.rejects(
    inspectPackage(
      maliciousArchive("package/link", "SymbolicLink", "../../outside"),
    ),
  );
  const dep = await packageFixture(tmp.path, "1.0.0", {
    "package.json": JSON.stringify({
      name: "@test/guide",
      version: "1.0.0",
      agentSkill: { compatibleAgents: ["codex"], dataMode: "bundled" },
      dependencies: { evil: "*" },
    }),
  });
  await assert.rejects(inspectPackage(dep.bytes), /依存/);
});

test("collision, live lock and interrupted replacement protect existing files", async (t) => {
  const tmp = await temporary();
  t.after(() => tmp.cleanup());
  const store = new Store(join(tmp.path, "skills"));
  const fixture = await packageFixture(tmp.path);
  const inspected = await inspectPackage(fixture.bytes);
  const { sha256, integrity } = await import("../packages/core/src/index.ts");
  const record = {
    name: "@test/guide",
    version: "1.0.0",
    selector: "latest",
    pinned: false,
    slug: "test-guide",
    agent: "codex" as const,
    portal: "https://portal.test/",
    hashes: Object.fromEntries(
      [...inspected.files].map(([p, b]) => [p, sha256(b)]),
    ),
    integrity: integrity(fixture.bytes),
  };
  await mkdir(join(store.root, "test-guide"), { recursive: true });
  await writeFile(join(store.root, "test-guide", "mine"), "keep");
  await assert.rejects(
    store.locked(() => store.replace(record, inspected.files)),
    /同名/,
  );
  const fresh = new Store(join(tmp.path, "fresh"));
  await fresh.locked(async () => {
    await assert.rejects(
      fresh.locked(async () => {}),
      /操作中/,
    );
    await fresh.replace(record, inspected.files);
  });
  const id = randomUUID();
  const dir = join(fresh.meta, id);
  await mkdir(dir);
  await rename(join(fresh.root, "test-guide"), join(dir, "backup"));
  await mkdir(join(fresh.root, "test-guide"));
  await writeFile(join(fresh.root, "test-guide", "partial"), "incomplete");
  await writeFile(
    join(fresh.meta, "transaction.json"),
    JSON.stringify({ id, slug: "test-guide", hadPrevious: true }),
  );
  await fresh.locked(async () => {});
  await fresh.assertUnmodified(record);
  assert.equal((await fresh.state()).installed[0].version, "1.0.0");
});

test("safe URLs, scoped spec parsing and separate agent roots", async () => {
  assert.deepEqual(parseSpec("@team/name@1.2.3"), {
    name: "@team/name",
    selector: "1.2.3",
    pinned: true,
  });
  assert.equal(parseSpec("@team/name").selector, "latest");
  assert.throws(() => parseSpec("@team/name@^1"));
  assert.throws(() => checkedUrl("http://internal.test/"));
  assert.throws(() => checkedUrl("https://user:secret@internal.test/"));
  assert.notEqual(
    targetRoot("codex", "project"),
    targetRoot("claude", "project"),
  );
});

test("registry authentication is never forwarded across a redirect", async (t) => {
  const other = await server((_req, res) => {
    res.end("no");
  });
  const original = await server((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", other.url);
    res.end();
  });
  t.after(async () => {
    await original.close();
    await other.close();
  });
  await assert.rejects(download(new URL(original.url), { token: "secret" }));
  assert.equal(other.requests.length, 0);
});
