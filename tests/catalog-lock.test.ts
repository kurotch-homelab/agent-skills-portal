import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lockedPackages, syncRegistry } from "../scripts/sync.ts";
import {
  temporary,
  registry,
  packageFixture,
  lockedFixture,
} from "./helpers.ts";

test("npm-generated lock + npm ci keep selection frozen until npm update, without lifecycle execution", async (t) => {
  const tmp = await temporary();
  const reg = await registry(false);
  t.after(async () => {
    await reg.close();
    await tmp.cleanup();
  });
  const fixture = await packageFixture(tmp.path);
  const raw = {
    ...fixture.manifest,
    scripts: {
      postinstall:
        "node -e \"require('fs').writeFileSync('lifecycle-ran', 'bad')\"",
    },
  };
  reg.versions["1.0.0"] = (
    await packageFixture(tmp.path, "1.0.0", {
      "package.json": JSON.stringify(raw),
    })
  ).bytes;
  reg.setTags({ latest: "1.0.0" });
  await writeFile(
    join(tmp.path, "package.json"),
    JSON.stringify({
      name: "test-catalog",
      private: true,
      dependencies: { "@test/guide": "^1.0.0" },
    }),
  );
  const npm = async (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        process.env.npm_execpath!,
        ...args,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry",
        reg.url,
        "--cache",
        join(tmp.path, "cache"),
      ],
      { cwd: tmp.path },
    );
  await npm("install", "--package-lock-only");
  const manifest = JSON.parse(
    await readFile(join(tmp.path, "package.json"), "utf8"),
  );
  const readLock = async () =>
    JSON.parse(await readFile(join(tmp.path, "package-lock.json"), "utf8"));
  const lock = await readLock();
  const options = {
    registry: reg.url,
    manifest,
    lock,
    output: join(tmp.path, "out"),
    now: "2026-09-08T00:00:00Z",
  };
  const first = await syncRegistry(options);
  assert.equal(first.packages[0].repository, "https://github.com/test/source");
  await npm("ci", "--no-bin-links");
  await assert.rejects(
    access(join(tmp.path, "node_modules/@test/guide/lifecycle-ran")),
  );
  reg.versions["1.1.0"] = (await packageFixture(tmp.path, "1.1.0")).bytes;
  reg.setTags({ latest: "1.1.0" });
  const frozen = await syncRegistry({ ...options, previous: first });
  assert.deepEqual(frozen, first);
  assert(!frozen.packages[0].versions["1.1.0"]);
  await npm("update", "--package-lock-only");
  const nextLock = await readLock();
  assert.equal(nextLock.packages["node_modules/@test/guide"].version, "1.1.0");
  const next = await syncRegistry({
    ...options,
    lock: nextLock,
    previous: first,
  });
  assert.deepEqual(Object.keys(next.packages[0].versions), ["1.0.0", "1.1.0"]);
  const rollback = await syncRegistry({ ...options, previous: next });
  assert.equal(rollback.packages[0].distTags.latest, "1.0.0");
  assert(rollback.packages[0].versions["1.1.0"]);
});

test("lock validation rejects mismatches, remote/git/file sources, missing integrity and extra dependencies", async (t) => {
  const tmp = await temporary();
  t.after(tmp.cleanup);
  const fixture = await packageFixture(tmp.path);
  const original = lockedFixture("https://registry.test/", fixture.bytes);
  for (const mutate of [
    (x: any) => {
      x.manifest.dependencies["@test/guide"] = "2.0.0";
    },
    (x: any) => {
      x.lock.packages["node_modules/@test/guide"].version = "2.0.0";
    },
    (x: any) => {
      x.lock.packages["node_modules/@test/guide"].resolved =
        "https://other.test/pkg.tgz";
    },
    (x: any) => {
      x.lock.packages["node_modules/@test/guide"].resolved = "file:../pkg";
    },
    (x: any) => {
      x.lock.packages["node_modules/@test/guide"].integrity = undefined;
    },
    (x: any) => {
      x.lock.packages["node_modules/evil"] = { version: "1.0.0" };
    },
    (x: any) => {
      x.lock.packages["node_modules/@test/guide"].link = true;
    },
    (x: any) => {
      x.manifest.dependencies["@test/guide"] =
        "git+https://registry.test/a.git";
      x.lock.packages[""].dependencies = x.manifest.dependencies;
    },
  ]) {
    const input = structuredClone(original);
    mutate(input);
    assert.throws(() =>
      lockedPackages(input.manifest, input.lock, "https://registry.test/"),
    );
  }
});

test("withdrawals and removal preserve history and re-registration requires an explicit policy change", async (t) => {
  const tmp = await temporary();
  const reg = await registry(false);
  t.after(async () => {
    await reg.close();
    await tmp.cleanup();
  });
  reg.versions["1.0.0"] = (await packageFixture(tmp.path)).bytes;
  const opts = {
    registry: reg.url,
    ...lockedFixture(reg.url, reg.versions["1.0.0"]),
    output: join(tmp.path, "out"),
  };
  const first = await syncRegistry(opts);
  const policy = {
    packages: {
      "@test/guide": { withdrawn: true, withdrawnVersions: ["1.0.0"] },
    },
  };
  const stopped = await syncRegistry({
    ...opts,
    previous: first,
    withdrawals: policy,
  });
  assert(stopped.packages[0].withdrawn);
  assert(stopped.packages[0].versions["1.0.0"].withdrawn);
  const removed = await syncRegistry({
    ...opts,
    manifest: { private: true, dependencies: {} },
    lock: { lockfileVersion: 3, packages: { "": { dependencies: {} } } },
    previous: stopped,
    withdrawals: policy,
  });
  assert(removed.packages[0].withdrawn);
  assert(removed.packages[0].versions["1.0.0"].withdrawn);
  const restored = await syncRegistry({
    ...opts,
    previous: removed,
    withdrawals: policy,
  });
  assert(restored.packages[0].withdrawn);
  const enabled = await syncRegistry({ ...opts, previous: restored });
  assert(!enabled.packages[0].withdrawn);
  assert(!enabled.packages[0].versions["1.0.0"].withdrawn);
});
