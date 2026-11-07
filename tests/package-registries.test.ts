import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadPackageRegistries } from "../scripts/registries.ts";
import {
  lockedPackages,
  syncRegistry,
  combineCatalogs,
} from "../scripts/sync.ts";
import { integrity, download } from "../packages/core/src/index.ts";
import {
  temporary,
  registry,
  packageFixture,
  lockedFixture,
  server,
} from "./helpers.ts";

const config = (registry: string) => ({
  packages: { "@test/guide": { registry, tokenEnv: "TEST_REGISTRY_TOKEN" } },
});

test("registry config accepts only credential names and validates URLs before use", () => {
  const parsed = loadPackageRegistries(
    config("https://packages.example.test/npm"),
    { TEST_REGISTRY_TOKEN: "secret" },
  );
  assert.equal(
    parsed["@test/guide"].registry,
    "https://packages.example.test/npm/",
  );
  assert.equal(parsed["@test/guide"].token, "secret");
  assert.throws(
    () => loadPackageRegistries(config("https://packages.example.test"), {}),
    /TEST_REGISTRY_TOKEN/,
  );
  for (const url of [
    "https://user:secret@example.test",
    "https://example.test/#fragment",
    "https://example.test/?token=secret",
    "http://example.test/",
  ]) {
    assert.throws(() =>
      loadPackageRegistries(config(url), { TEST_REGISTRY_TOKEN: "secret" }),
    );
  }
  assert.throws(() =>
    loadPackageRegistries({
      packages: {
        "@test/guide": { registry: "https://example.test", token: "secret" },
      },
    }),
  );
});

test("mixed registries isolate credentials, enforce each package source and keep catalog free of tokens", async (t) => {
  const tmp = await temporary();
  const privateRegistry = await registry();
  const fixture = await packageFixture(tmp.path);
  const other = await packageFixture(tmp.path, "1.0.0", {
    "package.json": JSON.stringify({
      ...fixture.manifest,
      name: "@test/other",
    }),
    "SKILL.md":
      "---\nname: other-guide\ndescription: Another guide\n---\nGuide",
  });
  const anonymousRegistry = await server((_req, res) => {
    res.end(other.bytes);
  });
  t.after(async () => {
    await privateRegistry.close();
    await anonymousRegistry.close();
    await tmp.cleanup();
  });
  privateRegistry.versions["1.0.0"] = fixture.bytes;
  const input = lockedFixture(privateRegistry.url, fixture.bytes);
  Object.assign(input.manifest.dependencies, { "@test/other": "^1.0.0" });
  input.lock.packages[""].dependencies = input.manifest.dependencies;
  Object.assign(input.lock.packages, {
    "node_modules/@test/other": {
      version: "1.0.0",
      resolved: anonymousRegistry.url + "tar/other",
      integrity: integrity(other.bytes),
    },
  });
  const packageRegistries = loadPackageRegistries(config(privateRegistry.url), {
    TEST_REGISTRY_TOKEN: "test-token",
  });
  assert.throws(() =>
    lockedPackages(input.manifest, input.lock, anonymousRegistry.url),
  );
  assert.throws(() =>
    lockedPackages(input.manifest, input.lock, anonymousRegistry.url, {
      ...packageRegistries,
      "@test/missing": { registry: privateRegistry.url },
    }),
  );
  const options = {
    ...input,
    registry: anonymousRegistry.url,
    packageRegistries,
    output: join(tmp.path, "out"),
  };
  const result = await syncRegistry(options);
  assert.equal(result.packages.length, 2);
  assert.deepEqual(
    privateRegistry.requests.map((r) => r.authorization),
    ["Bearer test-token"],
  );
  assert.deepEqual(
    anonymousRegistry.requests.map((r) => r.authorization),
    [undefined],
  );
  const catalog = await readFile(join(tmp.path, "out/catalog.json"), "utf8");
  assert(!catalog.includes("test-token"));
  assert(!catalog.includes("tokenEnv"));
  const wrong = structuredClone(input.lock);
  wrong.packages["node_modules/@test/guide"].resolved =
    anonymousRegistry.url + "stolen";
  await assert.rejects(syncRegistry({ ...options, lock: wrong }));
  assert.equal(anonymousRegistry.requests.length, 1);
});

test("prepare CLI uses registry configuration and never publishes credentials", async (t) => {
  const tmp = await temporary();
  const reg = await registry();
  t.after(async () => {
    await reg.close();
    await tmp.cleanup();
  });
  reg.versions["1.0.0"] = (await packageFixture(tmp.path)).bytes;
  const fixture = lockedFixture(reg.url, reg.versions["1.0.0"]);
  const catalogDir = join(tmp.path, "catalog");
  await mkdir(catalogDir);
  const files = {
    "site.json": {
      portalUrl: "https://portal.example.test",
      registryUrl: "https://default.example.test",
    },
    "sources.json": config(reg.url),
    "previous.json": {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      packages: [],
    },
    "catalog/package.json": fixture.manifest,
    "catalog/package-lock.json": fixture.lock,
  };
  for (const [name, data] of Object.entries(files))
    await writeFile(join(tmp.path, name), JSON.stringify(data));
  const cli = join(process.cwd(), "packages/portal/dist/cli.js");
  await promisify(execFile)(
    process.execPath,
    [
      cli,
      "prepare",
      "--config",
      "site.json",
      "--catalog",
      "catalog",
      "--registries",
      "sources.json",
      "--previous",
      "previous.json",
      "--output",
      "prepared",
    ],
    {
      cwd: tmp.path,
      env: { ...process.env, TEST_REGISTRY_TOKEN: "test-token" },
    },
  );
  assert.equal(reg.requests[0].authorization, "Bearer test-token");
  for (const name of [
    "prepared/assets/site-config.json",
    "prepared/catalog/catalog.json",
  ]) {
    const text = await readFile(join(tmp.path, name), "utf8");
    assert(!text.includes("test-token"));
    assert(!text.includes("TEST_REGISTRY_TOKEN"));
  }
});

test("independent catalogs retain lock validation and reject duplicate names", async (t) => {
  const tmp = await temporary();
  t.after(tmp.cleanup);
  const one = lockedFixture(
    "https://internal.example.test/",
    (await packageFixture(tmp.path)).bytes,
  );
  const two = structuredClone(one);
  two.manifest.dependencies = { "@test/second": "^1.0.0" } as any;
  two.lock.packages = {
    "": { dependencies: two.manifest.dependencies },
    "node_modules/@test/second": {
      ...one.lock.packages["node_modules/@test/guide"],
      resolved: "https://npm.pkg.github.com/tar/second",
    },
  } as any;
  const overrides = {
    "@test/second": { registry: "https://npm.pkg.github.com/" },
  };
  const combined = combineCatalogs(
    [one, two],
    "https://internal.example.test/",
    overrides,
  );
  assert.equal(
    lockedPackages(
      combined.manifest,
      combined.lock,
      "https://internal.example.test/",
      overrides,
    ).length,
    2,
  );
  assert.throws(
    () => combineCatalogs([one, one], "https://internal.example.test/"),
    /Duplicate/,
  );
  const bad = structuredClone(two);
  bad.lock.packages[""].dependencies = { "@test/guide": "1.0.0" };
  assert.throws(() =>
    combineCatalogs([one, bad], "https://internal.example.test/", overrides),
  );
});

test("GitHub archive redirects use only the known blob host without forwarding credentials", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  let destination = "https://pkg-npm.githubusercontent.com/blob?signature=test";
  globalThis.fetch = (async (input: any, options?: RequestInit) => {
    requests.push({ url: String(input), options });
    if (requests.length % 2 === 1)
      return new Response(null, {
        status: 302,
        headers: { location: destination },
      });
    return new Response("archive");
  }) as typeof fetch;
  const url = new URL(
    "https://npm.pkg.github.com/download/@test/guide/1.0.0/hash",
  );
  const bytes = await download(url, {
    token: "registry-secret",
    githubPackages: true,
  });
  assert.equal(bytes?.toString(), "archive");
  assert.equal(
    new Headers(requests[0].options?.headers).get("authorization"),
    "Bearer registry-secret",
  );
  assert.equal(
    new Headers(requests[1].options?.headers).get("authorization"),
    null,
  );
  assert.equal(requests[1].options?.redirect, "error");
  for (const bad of [
    "https://evil.example.test/blob",
    "http://pkg-npm.githubusercontent.com/blob",
    "https://user:secret@pkg-npm.githubusercontent.com/blob",
  ]) {
    requests.length = 0;
    destination = bad;
    await assert.rejects(
      download(url, { token: "registry-secret", githubPackages: true }),
    );
    assert.equal(requests.length, 1);
  }
  requests.length = 0;
  destination = "https://pkg-npm.githubusercontent.com/blob";
  await assert.rejects(
    download(new URL("https://other.example.test/download/x"), {
      token: "registry-secret",
      githubPackages: true,
    }),
  );
  assert.equal(requests.length, 1);
});
