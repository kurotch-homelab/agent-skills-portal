# Agent Skills Portal

A static skill catalogue and cross-platform CLI. Source repositories publish one npm package per skill; portal operators select versions with npm package.json and package-lock.json. Users install the skill without cloning its source repository.

- **@kurotch-homelab/agent-skills-cli**: the sv-skills user command. [User guide](packages/cli/README.md).
- **@kurotch-homelab/agent-skills-portal**: catalogue preparation, archive validation, deployment verification and a prebuilt web UI. [Operator guide](packages/portal/README.md).

Both packages are distributed through GitHub Packages. Configure npm authentication as described in the user guide. Registry credentials are used by npm; the static portal and CLI do not provide an authentication gateway. Host private skills behind your own network/access controls.

The portal repository contains configuration and npm lockfiles. It does not need React, TypeScript, or this source checkout. Publish assets first and catalog.json last; clients verify archive integrity before extracting files. Existing versions are retained, and withdrawn versions are blocked for new installations.

## Development

Requires Node.js 24 or later.

```sh
npm ci
npm run check
npm run smoke
```

Smoke tests install the actual tarballs into a separate directory, generate a fixture portal, and exercise skill installation, removal and integrity checks. Ordinary CI runs on Linux; release builds are made once and the same tarballs are tested on Windows and macOS.

## Release

Update both package versions together, run checks, and push a matching vX.Y.Z tag. Tag releases publish the tested archives using GITHUB_TOKEN only when the repository is public. Manual workflow runs exercise packaging and compatibility without publishing. Re-running a release accepts an already published version only when its tarball has identical integrity.

After first publication, configure each GitHub package's visibility and Actions access as needed. A public source repository does not by itself guarantee anonymous npm access. Configure any registry mirror separately and verify package resolution before switching downstream lockfiles.

MIT licensed. Distributed packages include third-party license notices.
