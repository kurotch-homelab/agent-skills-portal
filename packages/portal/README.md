# Agent Skills Portal

Build a static portal from locked npm skill packages without building application source. Requires Node.js 24 or later. Install @kurotch-homelab/agent-skills-portal using the GitHub Packages configuration in the [CLI guide](../cli/README.md).

Copy the example site-config.json, catalog directory and withdrawals.json from the repository's examples directory into your deployment repository. Set portalUrl and registryUrl to your own services; title, description, networkLabel, installCommand, registryHelp, docsUrl and footer customize the UI.

```sh
npm install --prefix catalog @kurotch-homelab/example@^1.0.0 --package-lock-only --ignore-scripts
agent-skills-portal prepare --config site-config.json --catalog catalog --withdrawals withdrawals.json --output .cache/release-1
```

Commit both catalog/package.json and catalog/package-lock.json. The registry must serve readable skill archives at the lockfile's URLs; the builder does not forward npm credentials to arbitrary archive URLs. The root npm project contains the portal tool dependency, separately from skill dependencies.

Prepare downloads the previous catalog from portalUrl, preserving earlier versions. Only HTTP 404 means a new portal; other errors stop preparation. For offline initialization, pass --previous with a valid local catalogue. The output must be a new directory within the current directory.

Deploy output/assets first (including artifacts and site-config.json), then output/catalog/catalog.json to the same site's root. Keep historical archive objects. Do not deploy output/sync, which is staging data. Finally run:

```sh
agent-skills-portal verify --portal https://skills.example.test/
```

The verifier checks the site, runtime config, catalogue schema and every published archive's integrity. Your hosting provider owns atomic publication and access control.

## Updates and withdrawals

Run npm update --package-lock-only --ignore-scripts in the root and catalog projects. If neither lockfile changes, stop the update job before installation and validation. Otherwise validate the new catalogue and open one reviewable PR. Merging that PR selects the new versions; a scheduled deploy alone never upgrades dependencies. The portal latest tag is the version selected by its lockfile, not an automatically copied registry dist-tag.

Removing a catalogue dependency withdraws it while retaining history. withdrawals.json can also set packages[packageName].withdrawn or withdrawnVersions. Withdrawal blocks CLI installation; it does not revoke a direct archive URL or remove users' existing files.

## Publishing a skill

One npm package contains one SKILL.md with name and description frontmatter. Include scripts and references through the package's files allowlist; use relative paths so source checkouts are unnecessary. package.json requires name, version, description, repository and agentSkill metadata. See the [publishing guide](../../docs/publishing.md).

```sh
npm pack --ignore-scripts
agent-skills-portal validate ./kurotch-homelab-example-1.0.0.tgz
npm publish --ignore-scripts
```

The CLI never executes npm lifecycle scripts. Skill runtime dependencies must be bundled; dependencies, optionalDependencies and peerDependencies must be empty. Package versions are immutable and archive integrity must remain unchanged.
