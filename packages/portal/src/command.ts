import { Command } from "commander";
import { readFile, writeFile, mkdir, cp, access } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { syncRegistry, lockedPackages } from "../../../scripts/sync.ts";
import { siteSchema } from "../../core/src/site.ts";
import {
  catalogSchema,
  emptyCatalog,
  download,
  checkedUrl,
  inspectPackage,
  assertIntegrity,
} from "../../core/src/index.ts";
import manifest from "../package.json";
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const program = new Command()
  .name("agent-skills-portal")
  .version(manifest.version);
program
  .command("validate <archive>")
  .description("Validate a skill npm archive")
  .action(async (archive) => {
    const result = await inspectPackage(await readFile(archive));
    console.log(`${result.manifest.name}@${result.manifest.version}: OK`);
  });
program
  .command("prepare")
  .description("Prepare assets and catalog from npm lockfiles")
  .requiredOption("--config <path>", "Site config JSON")
  .option("--catalog <path>", "Independent npm project", "catalog")
  .option("--withdrawals <path>", "Withdrawal policy JSON")
  .option(
    "--previous <path>",
    "Local previous catalog; otherwise download from portal",
  )
  .requiredOption(
    "--output <path>",
    "New output directory under current directory",
  )
  .action(async (options) => {
    const site = siteSchema.parse(await json(options.config));
    const npmManifest = await json(join(options.catalog, "package.json"));
    const lock = await json(join(options.catalog, "package-lock.json"));
    lockedPackages(npmManifest, lock, site.registryUrl);
    let previous = emptyCatalog();
    if (options.previous)
      previous = catalogSchema.parse(await json(options.previous));
    else {
      const bytes = await download(
        checkedUrl(
          "catalog.json",
          site.portalUrl.endsWith("/") ? site.portalUrl : site.portalUrl + "/",
        ),
        { allow404: true, maxBytes: 32 * 1024 * 1024 },
      );
      if (bytes)
        previous = catalogSchema.parse(JSON.parse(bytes.toString("utf8")));
    }
    const output = resolve(options.output);
    const local = relative(process.cwd(), output);
    if (!local || local.startsWith("..") || resolve(local) !== output)
      throw new Error(
        "output must be a new directory under the current directory",
      );
    try {
      await access(output);
      throw new Error("output already exists; choose a new output directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(output, { recursive: true });
    const catalog = await syncRegistry({
      registry: site.registryUrl,
      manifest: npmManifest,
      lock,
      withdrawals: options.withdrawals
        ? await json(options.withdrawals)
        : undefined,
      previous,
      output: join(output, "sync"),
    });
    await cp(
      fileURLToPath(new URL("./web/", import.meta.url)),
      join(output, "assets"),
      { recursive: true, filter: (p) => !p.endsWith("catalog.json") },
    );
    await cp(
      join(output, "sync", "artifacts"),
      join(output, "assets", "artifacts"),
      { recursive: true },
    );
    await writeFile(
      join(output, "assets", "site-config.json"),
      JSON.stringify(site) + "\n",
    );
    await mkdir(join(output, "catalog"));
    await writeFile(
      join(output, "catalog", "catalog.json"),
      JSON.stringify(catalog) + "\n",
    );
    console.log(`Prepared ${catalog.packages.length} packages in ${output}`);
  });
program
  .command("verify")
  .requiredOption("--portal <url>", "Portal URL")
  .action(async (options) => {
    const base = checkedUrl(
      options.portal.endsWith("/") ? options.portal : options.portal + "/",
    );
    await download(base);
    siteSchema.parse(
      JSON.parse(
        (await download(new URL("site-config.json", base)))!.toString("utf8"),
      ),
    );
    const catalog = catalogSchema.parse(
      JSON.parse(
        (await download(new URL("catalog.json", base), {
          maxBytes: 32 * 1024 * 1024,
        }))!.toString("utf8"),
      ),
    );
    for (const pkg of catalog.packages)
      for (const version of Object.values(pkg.versions))
        assertIntegrity(
          (await download(new URL(version.artifact, base)))!,
          version.integrity,
        );
    console.log(`Verified portal and ${catalog.packages.length} packages`);
  });
program.parseAsync().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
