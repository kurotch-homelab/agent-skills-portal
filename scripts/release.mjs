import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
const npm =
  process.env.npm_execpath ||
  join(
    dirname(process.execPath),
    process.platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "../lib/node_modules/npm/bin/npm-cli.js",
  );
for (const folder of ["cli", "portal"]) {
  const pkg = JSON.parse(
    await readFile(`packages/${folder}/package.json`, "utf8"),
  );
  if (process.env.GITHUB_REF_NAME !== `v${pkg.version}`)
    throw new Error("Tag/version mismatch");
  const file = `.cache/${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
  const bytes = await readFile(file);
  const metadata = await fetch(
    "https://npm.pkg.github.com/" + encodeURIComponent(pkg.name),
    { headers: { Authorization: `Bearer ${process.env.NODE_AUTH_TOKEN}` } },
  );
  if (metadata.ok) {
    const existing = (await metadata.json()).versions?.[pkg.version];
    if (existing) {
      if (
        existing.dist.integrity !==
        "sha512-" + createHash("sha512").update(bytes).digest("base64")
      )
        throw new Error("Existing version differs");
      console.log(`${pkg.name}@${pkg.version} already published`);
      continue;
    }
  } else if (metadata.status !== 404)
    throw new Error(`Registry metadata failed: ${metadata.status}`);
  execFileSync(
    process.execPath,
    [
      npm,
      "publish",
      file,
      "--ignore-scripts",
      "--registry=https://npm.pkg.github.com",
    ],
    { stdio: "inherit" },
  );
}
