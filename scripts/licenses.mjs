import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
const paths = execFileSync(
  process.execPath,
  [process.env.npm_execpath, "ls", "--all", "--parseable"],
  { encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/)
  .filter((p) => p.includes("node_modules"));
const notices = [];
for (const path of [...new Set(paths)].sort()) {
  const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  const files = (await readdir(path)).filter((p) =>
    /^(licen[cs]e|copying|notice)(\.|$)/i.test(p),
  );
  let text = `${pkg.name}@${pkg.version}\nDeclared license: ${JSON.stringify(pkg.license ?? pkg.licenses ?? "See package source")}\n`;
  for (const file of files)
    text += "\n" + (await readFile(join(path, file), "utf8"));
  notices.push(text);
}
for (const folder of ["cli", "portal"]) {
  await writeFile(
    `packages/${folder}/THIRD_PARTY_NOTICES.txt`,
    notices.join("\n\n" + "=".repeat(72) + "\n\n"),
  );
  await copyFile("LICENSE", `packages/${folder}/LICENSE`);
}
