import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const npm =
  process.env.npm_execpath ||
  join(
    dirname(process.execPath),
    process.platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "../lib/node_modules/npm/bin/npm-cli.js",
  );
await mkdir(".cache", { recursive: true });
const root = await mkdtemp(resolve(".cache/smoke-"));
const env = {
  ...process.env,
  APPDATA: join(root, "settings"),
  XDG_CONFIG_HOME: join(root, "settings"),
  SV_SKILLS_PORTAL: "",
  NPM_CONFIG_CACHE: join(root, "npm-cache"),
};
const runNpm = (args, opts = {}) =>
  exec(
    process.execPath,
    [npm, ...args, "--ignore-scripts", "--no-audit", "--no-fund"],
    { env, ...opts },
  );
const version = JSON.parse(
  await readFile("packages/cli/package.json", "utf8"),
).version;
if (!process.argv.includes("--packed"))
  await runNpm([
    "pack",
    "--workspace",
    "@kurotch-homelab/agent-skills-cli",
    "--workspace",
    "@kurotch-homelab/agent-skills-portal",
    "--pack-destination",
    ".cache",
  ]);
const archives = ["cli", "portal"].map((n) =>
  resolve(`.cache/kurotch-homelab-agent-skills-${n}-${version}.tgz`),
);
await runNpm(["install", "--prefix", join(root, "installed"), ...archives]);
const binary = (n) =>
  join(
    root,
    "installed/node_modules/@kurotch-homelab/agent-skills-" +
      n +
      "/dist/cli.js",
  );
const run = (name, ...args) =>
  exec(process.execPath, [binary(name), ...args], { env });
for (const name of ["cli", "portal"])
  assert.equal((await run(name, "--version")).stdout.trim(), version);
await run("cli", "list", "--project", join(root, "project"));
await assert.rejects(run("cli", "search"), /config set portal/);
const fixture = join(root, "fixture");
await mkdir(fixture);
await writeFile(
  join(fixture, "package.json"),
  JSON.stringify({
    name: "@example/guide",
    version: "1.0.0",
    repository: "https://github.com/example/source",
    files: ["SKILL.md"],
    agentSkill: { compatibleAgents: ["codex", "claude"], dataMode: "bundled" },
  }),
);
await writeFile(
  join(fixture, "SKILL.md"),
  "---\nname: example-guide\ndescription: Test skill\n---\n# Example\n",
);
const packed = JSON.parse(
  (await runNpm(["pack", "--json"], { cwd: fixture })).stdout,
)[0];
const bytes = await readFile(join(fixture, packed.filename));
const integrity =
  "sha512-" + createHash("sha512").update(bytes).digest("base64");
let corrupt = false;
const output = join(root, "site");
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/fixture.tgz") {
      res.end(bytes);
      return;
    }
    if (req.url?.startsWith("/artifacts/") && corrupt) {
      res.end("corrupt");
      return;
    }
    const path = req.url === "/" ? "index.html" : req.url.slice(1);
    res.end(
      await readFile(
        join(output, path === "catalog.json" ? "catalog" : "assets", path),
      ),
    );
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
try {
  await run("cli", "config", "set", "portal", base);
  assert.equal(
    (await run("cli", "config", "get", "portal")).stdout.trim(),
    base,
  );
  const catalog = join(root, "catalog");
  await mkdir(catalog);
  const deps = { "@example/guide": "1.0.0" };
  await writeFile(
    join(catalog, "package.json"),
    JSON.stringify({ private: true, dependencies: deps }),
  );
  await writeFile(
    join(catalog, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: deps },
        "node_modules/@example/guide": {
          version: "1.0.0",
          resolved: base + "fixture.tgz",
          integrity,
        },
      },
    }),
  );
  const config = join(root, "site.json");
  await writeFile(
    config,
    JSON.stringify({
      title: "Packaged smoke portal",
      portalUrl: base,
      registryUrl: base,
    }),
  );
  const previous = join(root, "previous.json");
  await writeFile(
    previous,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      packages: [],
    }),
  );
  await run("portal", "validate", join(fixture, packed.filename));
  await run(
    "portal",
    "prepare",
    "--config",
    config,
    "--catalog",
    catalog,
    "--previous",
    previous,
    "--output",
    output,
  );
  await assert.rejects(
    run(
      "portal",
      "prepare",
      "--config",
      config,
      "--catalog",
      catalog,
      "--previous",
      previous,
      "--output",
      output,
    ),
    /already exists/,
  );
  await run("portal", "verify", "--portal", base);
  assert((await run("cli", "search")).stdout.includes("@example/guide"));
  await run(
    "cli",
    "install",
    "@example/guide",
    "--agent",
    "all",
    "--project",
    join(root, "project"),
  );
  for (const dir of [".agents", ".claude"])
    await access(join(root, "project", dir, "skills/example-guide/SKILL.md"));
  await run(
    "cli",
    "uninstall",
    "@example/guide",
    "--agent",
    "all",
    "--project",
    join(root, "project"),
  );
  corrupt = true;
  await assert.rejects(run("portal", "verify", "--portal", base));
  await run("cli", "config", "unset", "portal");
  await assert.rejects(run("cli", "search"), /config set portal/);
  console.log(
    "Installed package smoke passed: configuration, prepare, verify, install/uninstall and corruption refusal",
  );
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
