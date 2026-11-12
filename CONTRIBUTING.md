# Contributing a plugin

A plugin gets into the Vestra Player store through a pull request that adds
its source to `plugins/<name>/` in this repository. This file is the
checklist for that pull request. Writing the plugin itself is covered by the
[SDK documentation](https://vestrasys.github.io/vestra-player-sdk/documents/Getting_started.html);
how the repository works inside is in [MAINTAINING.md](MAINTAINING.md).

Each item says who checks it: **CI** fails the pull request, **Review** is
what the maintainer who reads your source looks for.

A maintainer has to agree to host a new plugin. The pull request is where
that happens; open an issue first if you want an answer before you write the
plugin.

## Checklist

### Id and owner

- [ ] The plugin is in `plugins/<name>/`, and
      [`plugins/owners.toml`](plugins/owners.toml) has the line
      `<name> = "<owner>"`. The owner is the GitHub user or organization that
      maintains the plugin: you. (CI)
- [ ] `id` in `manifest.json` is `<owner>.<name>`, for example
      `zysilm.vestratube` for `plugins/vestratube/` owned by `zysilm`. The
      owner is compared without case; no other plugin has the same id, even
      with different case. (CI)
- [ ] Neither the id nor the owner uses `vestra`: it is reserved for the
      player's built-in plugins. (CI)

### Files

- [ ] The directory holds `manifest.json`, the sources (`.ts`, `.slint`),
      `tests/`, `README.md` and `CHANGELOG.md`. (Review; CI for the tests)
- [ ] No `tsconfig*.json` or `jsconfig.json`, no symbolic links, no
      submodules, no `node_modules` (the repository's `tsconfig.json` applies
      to every plugin). `dist/` and `*.vxp` are ignored by git. (CI)
- [ ] No `package.json`, unless the plugin bundles npm packages
      ([npm dependencies](#npm-dependencies)). The SDK, TypeScript and
      esbuild come from the repository root, so a `package.json` with
      `devDependencies` is refused. (CI)

### Manifest

- [ ] `vestra-plugin check` accepts it: `id`, `apiVersion` (`vestra/1`),
      `entry`, `capabilities`, no unknown fields, and every display field
      within the player's limits (`name` and `author` 64 characters,
      `punchline` 120, `description` 2000, at most 8 `tags` of 24 characters,
      `license` 64, `sourceUrl` an `https:` address, `icon` a PNG or JPEG of
      at most 512 KiB and 1024 pixels a side). (CI)
- [ ] `version` is `MAJOR.MINOR.PATCH`. (CI)
- [ ] The display fields the store shows are filled in: `name`, `author`,
      `punchline`, `description`, `tags`, `license`, `sourceUrl`; `icon` is
      optional. (Review)
- [ ] `minPlayerVersion` is set when the plugin needs a newer player than
      0.1. (Review)
- [ ] Optional: translations. `npx vestra-plugin i18n extract`, then
      `locales/<lang>.po`; the store lists the plugin in those languages too.

### README and CHANGELOG

- [ ] `README.md` is short and for users: what the plugin does, how to use
      it, requirements, limits. The store shows it on the plugin's page.
      (Review)
- [ ] `CHANGELOG.md` has an entry for the version. The store shows it too.
      (Review)
- [ ] Each is at most 256 KiB. (CI)

### Tests

- [ ] There is at least one `tests/*.test.ts` or `tests/*.test.mjs`, and
      `vestra-plugin test` passes on macOS, Windows and Linux with Node.js
      26. (CI)

### Capabilities

- [ ] Every capability the code uses is declared: `vestra-plugin check`
      fails on a use of an API member whose capability the manifest lacks.
      (CI)
- [ ] No capability that only built-in plugins may declare (`commands.run`,
      `palette.lead`). (CI)
- [ ] No capability the plugin does not use. The store lists them on the
      plugin's page. (Review)

Capabilities limit the player API only, not file or network access: plugins
run as ordinary Node.js processes without a sandbox. That is why a
maintainer reads every plugin's source.

### Imports

- [ ] Code imports only Node built-ins, `@vestra-player/sdk`, the plugin's
      own files and its own npm `dependencies`; tests may also import
      `@vestra-player/sdk/testing`. Nothing from another plugin or from
      outside the plugin's directory, and runtime code never imports from
      `tests/`. (CI: `npm run boundaries`)

### Portability

- [ ] The plugin works on macOS and Windows. A plugin that needs one system
      or particular hardware says so in its README and does nothing
      elsewhere. (Review; the tests run on both in CI)
- [ ] No system commands: no string that names a system path (`/usr/bin/`,
      `/bin/`, `/opt/homebrew`, `/System/`, `/Library/`, `/Applications/`,
      …) and no macOS-only program (`open`, `osascript`, `pbcopy`, …) passed
      to `spawn` or `exec`. Ask the player for a capability or use plain Node
      instead. (CI: `npm run portability`; it also lists every
      `process.platform` branch for the reviewer, without failing)

### License and size

- [ ] The plugin's own code is under a permissive license, named in the
      manifest's `license`. The plugins here are Apache-2.0, like the
      repository. (Review)
- [ ] No file carries a GPL, AGPL or LGPL notice. The one exception is an
      unmodified LGPL-3.0 mpv shader shipped as a separate file
      ([Third-party files and licenses](#third-party-files-and-licenses)).
      (CI)
- [ ] The package is at most 4 MiB as a `.vxp` and 16 MiB unpacked, and
      holds no native code (`.node`, `.dll`, `.dylib`, `.so`, `.exe`, …).
      (CI)

### Security review

- [ ] If the plugin runs programs, downloads or runs code, uses hard-coded
      hosts, or touches files outside its own directories, the pull request
      description says why. A scan labels such code `security-review` for
      the maintainer to read; the label is not a failure, and the
      explanation makes the review fast. (Review;
      [details](MAINTAINING.md#security-review))

## Run the checks

Node.js 26 or later. From the repository root:

```sh
npm ci
npm run check && npm run format:check && npm run boundaries && npm run portability && npm run registry && npm run build && npm test
```

That is what CI runs, apart from a spelling check
([typos](https://github.com/crate-ci/typos)) and the three operating
systems. One plugin at a time:

```sh
npm run plugin -- check <name>   # also: test, build, pack
```

## Open the pull request

Title it `Add <id>` and fill in the checklist of the pull request template.
CI must pass (`ci-ok`), and a maintainer reviews the source.

Merging publishes: CI packs the plugin, releases it as `<id>-v<version>`,
adds it to the signed index, and the plugin appears in the store. There is
no testing channel.

## Update your plugin

- [ ] `version` in `manifest.json` is bumped and `CHANGELOG.md` has an entry
      for it. A version is released once and never rebuilt, so a change
      without a new version passes CI but is not published. Never reuse or
      lower a version. (Review)
- [ ] The title is `Update <id> to <version>`.
- [ ] The id is unchanged. A changed id is a new plugin to the store, without
      the old one's history.

To have a broken or harmful version disabled on users' machines, ask a
maintainer to revoke it. To report a vulnerability privately, see
[SECURITY.md](.github/SECURITY.md).

## npm dependencies

Only for a plugin that uses packages from npm. They are bundled into the
plugin's entry file, so the package has no `node_modules` and users install
nothing. CI enforces all of this:

- [ ] `plugins/<name>/package.json` has only `name`, `version`, `private`,
      `type`, `description`, `license`, `dependencies`, `scripts` and
      `vestra`, with `"vestra": { "bundle": true, "assets": ["licenses"] }`.
      No `devDependencies`, no optional, peer or bundled dependencies, no
      `overrides` or `workspaces`, no install scripts (`preinstall`,
      `install`, `postinstall`, `prepare`, …).
- [ ] `package-lock.json` is committed and matches `package.json`. Every
      locked package comes from `https://registry.npmjs.org/` with a sha512
      `integrity`: no git, file, link or URL sources.
- [ ] No native code: no package with an install script, a `binding.gyp`,
      an `os`/`cpu`/`libc` restriction or binary files.
- [ ] Every package's license is one of `MIT`, `MIT-0`, `ISC`, `0BSD`,
      `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `Zlib`, `BlueOak-1.0.0`,
      `BSL-1.0`, `CC0-1.0`, `Unlicense`. GPL, AGPL, LGPL, MPL and anything
      unlisted are refused.
- [ ] No known vulnerability in a locked package (osv-scanner), and none of
      high or critical severity in a package the pull request adds
      (dependency review).
- [ ] `dependency-inventory.json` and `licenses/` are committed: the license
      texts ship in the package. The command below writes both. For a
      package that ships no license file, put its license text from its
      source repository into `licenses/<name>/LICENSE` yourself.

Adding or updating a dependency:

```sh
cd plugins/<name>
npm install --ignore-scripts --save-exact <package>@<version>   # writes package.json and package-lock.json
cd ../..
npm run deps -- licenses <name> --write   # npm ci --ignore-scripts, then dependency-inventory.json and licenses/
npm run registry && npm run plugin -- pack <name>
```

Commit `package.json`, `package-lock.json`, `dependency-inventory.json` and
`licenses/`, never `node_modules/`. The reviewer reads the lockfile diff like
code: new packages, their maintainers and what they do. The rules in full:
[MAINTAINING.md](MAINTAINING.md#npm-dependencies).

## Third-party files and licenses

Only for a plugin that ships files it did not write and that are not npm
packages, such as mpv GLSL shaders. They ship as separate files with their
license texts and a source note.

- [ ] Permissive files (MIT, BSD, the Unlicense, …) follow
      [`plugins/shaderupscale/shaders/SOURCES.txt`](plugins/shaderupscale/shaders/SOURCES.txt).
      (Review)
- [ ] An LGPL file is an mpv shader (`.glsl`, `.hook`) under the plugin's
      `shaders/`, licensed `LGPL-3.0-only` or `LGPL-3.0-or-later`, and the
      upstream file byte for byte: never modified, never concatenated into
      or embedded in the plugin's code. (CI)
- [ ] `shaders/SOURCES.txt` has a record for it (below). CI downloads the
      upstream file and compares its SHA256 with the record's. (CI)
- [ ] The FSF's `COPYING.LESSER` (LGPL-3.0) and `COPYING` (GPL-3.0) lie in
      the same directory, unchanged. (CI)
- [ ] The plugin's README names the bundled LGPL shaders; the manifest's
      `license` stays the license of the plugin's own code. (Review)

LGPL code and LGPL npm packages are not accepted; GPL and AGPL are refused
everywhere.

A record in `shaders/SOURCES.txt` (the rest of the file is free text;
`File:` starts a line, a blank line ends the record):

```text
File: ravu/ravu-lite-ar-r4.hook
Repository: https://github.com/bjin/mpv-prescalers
Commit: <full 40-character commit id>
Path: gather/ravu-lite-ar-r4.hook
SHA256: <sha256 of the file, lowercase hex>
License: LGPL-3.0-or-later
```

`File` is relative to `shaders/`; `Path` is the file's path in the upstream
repository at `Commit`. Copy the file as downloaded, not through an editor
that rewrites line endings. Gists, release assets and every other detail:
[MAINTAINING.md](MAINTAINING.md#third-party-files-and-licenses).
