<p align="center"><img src="https://raw.githubusercontent.com/vestrasys/vestra-player-plugins/main/.github/assets/logo.png" width="96" height="96" alt="Vestra Player logo"></p>
<h1 align="center">Vestra Player Plugins</h1>
<p align="center"><b>The official plugin repository of Vestra Player: plugin sources, third-party registrations and the signed index the in-player store reads.</b></p>
<p align="center">
  <a href="https://github.com/vestrasys/vestra-player-plugins/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/vestrasys/vestra-player-plugins/ci.yml?branch=main&label=CI&logo=github" alt="CI"></a>
  <a href="https://github.com/vestrasys/vestra-player-plugins/actions/workflows/publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/vestrasys/vestra-player-plugins/publish.yml?branch=main&label=publish&logo=github" alt="Publish"></a>
  <a href="https://vestrasys.github.io/vestra-player-plugins/index.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fvestrasys.github.io%2Fvestra-player-plugins%2Findex.json&query=%24.plugins.length&label=plugins&color=6f42c1" alt="Plugins in the index"></a>
  <a href="https://www.npmjs.com/package/@vestra-player/sdk"><img src="https://img.shields.io/npm/v/@vestra-player/sdk?label=SDK&logo=npm&color=cb3837" alt="SDK on npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>
<p align="center">
  <a href="#contributing-a-plugin">Contribute a plugin</a> ·
  <a href="https://vestrasys.github.io/vestra-player-sdk/">SDK documentation</a> ·
  <a href="https://github.com/vestrasys/vestra-player">Vestra Player</a> ·
  <a href="CONTRIBUTING.md">Maintainer guide</a>
</p>

## What's here

| Plugin | Id | What it does |
| --- | --- | --- |
| [YouTube](plugins/youtube) | `vestra.youtube` | Plays a public YouTube video from its link, or downloads it as MKV (needs yt-dlp; ffmpeg for downloads). |
| [Bilibili](plugins/bilibili) | `vestra.bilibili` | Plays a Bilibili video from its link: BV or av number, or a b23.tv short link (needs yt-dlp). |

Every merge to `main` publishes the signed index at **https://vestrasys.github.io/vestra-player-plugins/index.json**, which the player's store reads. The plugins that ship with the player (playback, playlist, subtitles, …) live in the [player repository](https://github.com/vestrasys/vestra-player/tree/main/src/plugins), not here.

## Contributing a plugin

Third-party plugins are **built from source** (as on Flathub): you register your public repository and a commit, CI builds the package, a maintainer reviews the source, and the merge publishes it.

> [!IMPORTANT]
> **Status today.** The registration format, the id rule and the owner check are final and enforced by CI. Building third-party plugins from source is **not implemented yet**: the publish job refuses to run while any `registry/*.toml` exists, so registrations cannot be merged until it lands. Steps 1–4 below are ready to use now; steps 5–6 describe the flow as it will work.

### 1. Write your plugin with the SDK

Plugins are TypeScript on the public API `vestra/1` from [`@vestra-player/sdk`](https://www.npmjs.com/package/@vestra-player/sdk) (Node.js 26, the version the player ships). Start here:

- [Getting started](https://vestrasys.github.io/vestra-player-sdk/documents/Getting_started.html): a first plugin with a window, tests and a package.
- [Concepts](https://vestrasys.github.io/vestra-player-sdk/documents/Concepts.html), [How-to guides](https://vestrasys.github.io/vestra-player-sdk/documents/How-to_guides.html) and [Examples](https://vestrasys.github.io/vestra-player-sdk/documents/Examples.html) (complete, tested plugins).
- [API reference](https://vestrasys.github.io/vestra-player-sdk/modules.html), and this repository's [`plugins/`](plugins) as real-world examples.

The SDK's `vestra-plugin` command does the rest; try the plugin in the player with `--plugin <folder>`:

```sh
npx vestra-plugin check    # validate manifest.json, strict type check
npx vestra-plugin test     # node --test on tests/*.test.{ts,mjs}
npx vestra-plugin pack     # build dist/ and pack <id>-<version>.vxp
```

### 2. Meet the requirements

- **Id** `<github-owner>.<name>`: the owner is the GitHub user or organization that owns your source repository (compared without case); letters, digits, `.`, `-`, `_`. `vestra.` is reserved for the plugins in this repository.
- **A valid manifest**: `vestra-plugin check` and `pack` pass. Fill in the display fields the store shows: `name`, `author`, `punchline`, `description`, `tags`, `license`, `sourceUrl`, optionally `icon`, and `minPlayerVersion` if you need a newer player.
- **`README.md` and `CHANGELOG.md`** next to the manifest (at most 256 KiB each): the store shows both on the plugin's page.
- **Tests** under `tests/` that pass with `vestra-plugin test`.
- **Only the capabilities you use.** The store lists them on the plugin's page. They limit the player API only, not file or network access, which is why every plugin's source is reviewed.
- **macOS and Windows.** Prefer player capabilities and plain Node over system commands (the official plugins are checked with `npm run portability`).
- **Public source** under a license that allows us to build and distribute it.

### 3. Publish your source

Push the plugin to your own **public** GitHub repository (it can live in a subdirectory) and note the full 40-character commit id of the version to publish. A matching tag (`v1.0.0`) is good practice, but the registration always pins the commit.

### 4. Add `registry/<id>.toml`

Fork this repository and add one file named after your plugin id:

```toml
# registry/someone.cool-visualizer.toml
repository = "https://github.com/someone/cool-visualizer"
commit = "3f2a9c1d4b5e6f708192a3b4c5d6e7f8091a2b3c"
path = "."            # optional, default "."
owners = ["someone"]
```

| Key | Rule |
| --- | --- |
| file name | your plugin id plus `.toml`; equals `id` in the manifest |
| `repository` | `https://github.com/<owner>/<repo>`, no trailing `/` or `.git`; `<owner>` must be the id's prefix |
| `commit` | the full 40-digit lowercase commit id to build |
| `path` | the directory that holds `manifest.json`, relative, no `..` |
| `owners` | GitHub logins allowed to change or remove this file later; must include you |

No other keys (there is no `channel`). Check it with `npm ci && npm run registry`.

### 5. Open the pull request

Title it `Add someone.cool-visualizer` (or `Update someone.cool-visualizer to 1.2.0`) and fill in the [pull request checklist](.github/pull_request_template.md). On the pull request:

- **Registry owners** ([`registry.yml`](.github/workflows/registry.yml)) checks that you are in `owners` of a new registration, or already an owner of one you change. It runs from the base branch and never runs your code.
- **CI** ([`ci.yml`](.github/workflows/ci.yml)) validates the file (`npm run registry`) and dry-runs the publish flow. Today that dry run fails on any registration (third-party builds are not implemented), which is what keeps registrations from being merged; once they are, it builds and tests your plugin from the registered commit.
- **Review**: a maintainer reads the source at the commit (for an update, the diff since the previous one): that it does what its README says, that the capabilities match, and how it uses files, the network and child processes.

### 6. After the merge

[`publish.yml`](.github/workflows/publish.yml) builds the package at your commit without secrets, releases it as `<id>-v<version>` with a build provenance attestation, signs the index in a separate job that never runs plugin code, and deploys it. Your plugin then appears in the player's store.

- **Update**: bump `version` in your manifest, commit, and open a pull request that changes `commit`. A version is published once and never rebuilt, so always bump it.
- **Withdraw**: an owner opens a pull request that deletes the file.
- **Revoke**: owners can ask a maintainer to add a broken or harmful version to [`revoked.json`](CONTRIBUTING.md#revoking-a-version); the store disables it on users' machines and shows the reason.

There are no beta channels and no download counts: a merge is a release, and CI, user rollback and revocation are the safety net.

## Developing the official plugins

Node.js 22.18 or later. A name is a directory under `plugins/`; `--all` runs every plugin.

```sh
npm ci
npm run plugin -- check youtube    # also: test, build, pack
npm ci && npm run check && npm run format:check && npm run boundaries \
  && npm run portability && npm run registry && npm run build && npm test   # all of CI
```

Every change that should reach users bumps `version` and adds a `CHANGELOG.md` entry. Rules, CI and the publish pipeline: [CONTRIBUTING.md](CONTRIBUTING.md).

## Security and signing

`index.json` is signed with Ed25519 (`index.json.sig` next to it); the player's store embeds the public key ([`keys/`](keys)) and rejects an unsigned, tampered or replayed index. Every package carries its sha256 in the index, and building and signing run in separate jobs, so plugin code never runs where the signing key is. Details: [CONTRIBUTING.md](CONTRIBUTING.md#publishing).

## License

The repository and the official plugins are [Apache-2.0](LICENSE). Third-party plugins keep their own licenses.
