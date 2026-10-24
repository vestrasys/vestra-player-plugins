# Contributing and maintaining

This repository publishes the official Vestra Player plugin index. Every
plugin in it is a **third-party** plugin. Vestra Player has three kinds:

- **Official plugins** are the player's built-in plugins. They live in the
  [player repository](https://github.com/vestrasys/vestra-player/tree/main/src/plugins),
  ship with the player and are not in this repository or its index. Only
  they use the `vestra.` id prefix.
- **Hosted third-party plugins** have their source in `plugins/` here. They
  get stricter review: every change is a pull request to this repository and
  runs its full CI (type checks, tests on macOS, Windows and Linux,
  boundaries, portability).
- **Registered third-party plugins** stay in their author's repository and
  are registered in `registry/`; CI is to build them from source (not
  implemented yet).

The repository accepts three kinds of change, each through a pull request
to `main`:

- changes to a hosted plugin in `plugins/` (below);
- a third-party plugin registration in `registry/<plugin id>.toml`: the
  step-by-step guide is [Contributing a plugin](README.md#contributing-a-plugin)
  in the README;
- a revocation in `revoked.json` ([below](#revoking-a-version)).

Merging to `main` publishes (see [Publishing](#publishing)). There is no
testing channel: CI tests, user rollback and revocation are the safety net.

This file holds the rules in full and the maintainer details: layout, CI,
the publish pipeline, the index format and the signing key.

## Hosted third-party plugins (`plugins/<name>/`)

- Every hosted plugin has an **owner**: the GitHub user or organization that
  maintains it, recorded in [`plugins/owners.toml`](plugins/owners.toml) as
  `<name> = "<owner>"` (`youtube = "zysilm"`). The owner is the plugin's
  author (the manifest's `author`); a maintainer reviews every change. A new
  hosted plugin, or a change of owner, needs a maintainer's agreement.
- The id is `<owner>.<name>`, where `<name>` is the directory name
  (`plugins/youtube/` owned by `zysilm` is `zysilm.youtube`); the owner is
  compared without case. This is the same `<github-owner>.<name>` rule as
  for registrations, with the owner from `plugins/owners.toml` instead of
  the source repository.
- `vestra.` is reserved for the player's built-in plugins: neither an id
  nor an owner here may use it. `npm run registry` and the publish build
  enforce these rules.
- A changed id is a new plugin to the store: the old id's history is not
  carried over. Bump the version (minor) and say so in the changelog.
- A plugin directory holds `manifest.json`, its sources (`.ts`, `.slint`),
  `tests/`, a short user-facing `README.md` (what it does, how to use it,
  requirements, limits; shown in the store) and `CHANGELOG.md`.
- The manifest carries the display fields (`name`, `author`, `punchline`,
  `description`, `tags`, optionally `icon`, `sourceUrl`, `license`) and
  `minPlayerVersion` when the plugin needs API newer than player 0.1.
- **Every change that should reach users bumps `version`** in
  `manifest.json` and adds a `CHANGELOG.md` entry. A version is released
  once: once `<id>-v<version>` exists, CI never rebuilds it, so a change
  without a version bump is not published. Never reuse or lower a version.
- Run the checks in [Build and test](#build-and-test) before opening the
  pull request.

## Layout

```text
plugins/<name>/   hosted third-party plugins (id <owner>.<name>): manifest.json, main.ts,
                  .slint UI, tests/, README.md, CHANGELOG.md (youtube, bilibili)
plugins/owners.toml  the owner of each hosted plugin
registry/         third-party registrations, registry/<id>.toml (see the README)
revoked.json      revoked plugin versions, copied into the index
keys/             the trusted public keys of the index signature (every *.pub.pem;
                  normally just index-signing.pub.pem)
scripts/          plugin.mjs (runs the SDK's vestra-plugin CLI), check-boundaries.mjs,
                  check-portability.mjs, check-registry.mjs, the CI helpers
                  ci-plugins.mjs and check-package.mjs, and the publishing scripts:
                  query-releases.mjs, build-index.mjs, publish-releases.mjs,
                  sign-index.mjs, verify-index.mjs, generate-signing-key.mjs
.github/workflows ci.yml (checks), publish.yml (Releases, index, Pages),
                  weekly.yml (plugins against the latest SDK), registry.yml
                  (owner check for registry pull requests), and the reusable
                  _static.yml, _plugin.yml, _index-dryrun.yml (see [CI](#ci))
```

Plugins are independent: a plugin never imports another plugin or anything
outside its own directory. Code imports only `@vestra-player/sdk` (types);
tests may also import `@vestra-player/sdk/testing`. `npm run boundaries`
enforces this.

## Build and test

Node 22.18 or later.

```sh
npm ci
npm run plugin -- check youtube     # strict type check
npm run plugin -- build youtube     # writes plugins/youtube/dist/
npm run plugin -- test youtube      # node --test on plugins/youtube/tests/
npm run plugin -- pack youtube      # dist/ as <id>-<version>.vxp
```

A name is a directory under `plugins/`; `--all` runs every plugin. The whole
repository, as CI runs it (see [CI](#ci)):

```sh
npm ci && npm run check && npm run format:check && npm run boundaries \
  && npm run portability && npm run registry && npm run build && npm test
```

CI also runs [typos](https://github.com/crate-ci/typos),
[actionlint](https://github.com/rhysd/actionlint) and
[zizmor](https://docs.zizmor.sh/) (configuration in `.github/zizmor.yml`);
with those installed, `typos && actionlint && zizmor .github/workflows` runs
the same checks locally.

`npm test` runs the plugin tests and the tests of the repository scripts
(`npm run test:scripts`). `format:check` covers the repository's own scripts
and configuration; plugin sources keep their authors' formatting.

## Run a plugin in the player

Load a plugin directory into a development build of the player. From the
player repository's `src/host/`, with this repository checked out next to it
as `vestra-player-plugins`:

```sh
cargo run --bin vestra-host -- --plugin ../plugins/playback \
  --plugin ../../../vestra-player-plugins/plugins/youtube
```

`--plugin` may be repeated; the player runs the plugin's `.ts` sources
directly. The built-in `playback` plugin provides the player controls.

## CI

The entry workflows only orchestrate; each check is written once, in a
reusable workflow:

- [`_static.yml`](.github/workflows/_static.yml) (Ubuntu): `tsc` over the
  repository, prettier, `boundaries`, `portability`, `registry` (with
  `revoked.json` append-only against the pull request's base or the commit
  before the push), the script tests, typos, actionlint and zizmor.
- [`_plugin.yml`](.github/workflows/_plugin.yml), one plugin: strict type
  check, tests, `vestra-plugin pack` (every CLI command validates
  `manifest.json`), then `scripts/check-package.mjs` reads the `.vxp` and
  checks its manifest and files. Ubuntu with Node 22.18 and 24, Windows and
  macOS with Node 24.
- [`_index-dryrun.yml`](.github/workflows/_index-dryrun.yml): the publish
  flow end to end with a key generated in the job: `build-index.mjs` packs
  every plugin, `publish-releases.mjs --dry-run` checks the artifact as the
  signing job does, then sign, verify, and check that the real keys in
  `keys/` do **not** verify it. The real signing key is never involved.

[`ci.yml`](.github/workflows/ci.yml) runs on every branch push, pull request
and manual run:

```text
changes ─────────────────────┐
                             ▼
static ──┬──────────▶ plugin × N ──┬──▶ ci-ok
         └──▶ index-dryrun ────────┘
```

`changes` (`scripts/ci-plugins.mjs`) lists the plugins with changed files,
or every plugin on `main`, on a manual run, for a new branch, and when a
shared file (package.json, the lock file, tsconfig.json, the plugin CLI
wrapper, the plugin workflows) changed. `ci-ok` is the one check to require
in branch protection: it fails when any job failed or was cancelled; a
skipped job (no plugin changed) counts as passed.

[`weekly.yml`](.github/workflows/weekly.yml) (Mondays and on demand) runs
`_plugin.yml` for every plugin with `@vestra-player/sdk@latest` installed
over the locked version in the job (never committed), to find SDK changes
that break a plugin early.

Hardening: every workflow has `permissions: {}` at the top and grants the
minimum per job; actions are pinned by commit SHA with the version in a
comment; every job has a timeout; publish.yml uses no npm cache. Pull
requests from forks run `ci.yml` without secrets (`pull_request`).
[`registry.yml`](.github/workflows/registry.yml) is the one
`pull_request_target` workflow: it runs the base branch's script, reads the
pull request's files as data (`git show`) and never checks out or runs its
code.

## Registered third-party plugins: ids and owners

The registration file, its keys and the pull request flow are in the
[README](README.md#contributing-a-plugin). The rules behind them:

> **Status:** registrations are validated (format, id prefix, owners), but
> building and publishing third-party plugins is not implemented yet.
> `build-index` refuses to publish while a registration exists (so the CI
> index dry run fails on a registration pull request), and registrations are
> not merged until the third-party build job lands. The rules below are final.

### The id

- The id is `<owner>.<plugin name>`, where `<owner>` is the GitHub user or
  organization that owns `repository` (compared without case). For
  `https://github.com/someone/cool-visualizer`, the id must start with
  `someone.`. Letters, digits, `.`, `-` and `_` only.
- `vestra.` is reserved for the player's built-in (official) plugins, and
  an id cannot repeat an existing one, a hosted plugin's included (even with
  different case).
- Only the player's built-ins are official. Every plugin in this
  repository's index, hosted or registered, is a third-party plugin; the
  index's `official: true` marks the repository the player trusts by
  default, not its plugins.

### Owners

- A new registration must list the pull request author in `owners`.
- After that, only an owner listed on `main` may change the file (a new
  `commit`, a new `path`, adding or removing owners) or remove it. A
  maintainer can step in for an abandoned registration.
- The [`Registry owners`](.github/workflows/registry.yml) check enforces this
  from the base branch's copy of the script, so a pull request cannot change
  the check that judges it.

## Revoking a version

`revoked.json` is maintained by hand. To revoke, add an entry in a pull
request:

```json
[
  {
    "id": "someone.cool-visualizer",
    "versions": ">=1.0.0 <1.2.0",
    "reason": "Deletes files outside its data directory. Update to 1.2.0."
  }
]
```

- `id`: the plugin id (not a `vestra.` id: the built-ins are not in this
  index). `reason`: 1–500 characters, shown to users.
- `versions`: an exact version (`1.2.0`) or a range: comparators `<`, `<=`,
  `>`, `>=`, `=` joined by spaces (all must hold), alternatives joined by
  `||`, or `*` for every version. Examples: `<1.2.3`, `>=1.0.0 <1.2.0`,
  `0.1.0 || >=0.3.0 <0.3.2`. No `^`, `~`, `x` or hyphen ranges.
- **Append-only.** Add new entries at the end. Never remove, edit or
  reorder an entry once it is on `main`: the store remembers every
  revocation it has seen and rejects an index that lacks one as a replayed
  old index, so a dropped entry would make every store ignore the official
  index. A wrong entry stays; publish a fixed version (and, if the range was
  too wide, say so in the plugin's changelog). CI (`npm run registry` against
  the pull request's base, and the `Registry owners` check from the base
  branch's script) and the signing job (against the previously signed index)
  refuse a change that breaks this.
- The entry is copied into the index's `revoked` unchanged on the next
  publish. The store disables an installed version that matches and tells
  the user why; the package stays downloadable for the record.
- Owners of a plugin (hosted or registered) can ask for a revocation;
  maintainers can revoke any version.

## Publishing

Every push to `main` runs [`publish.yml`](.github/workflows/publish.yml):

```text
plugins ──▶ static ──┬──▶ plugin × N ──┬──▶ build ──▶ release-and-sign ──┬──▶ attest
                     └─────────────────┘                                 └──▶ deploy
```

0. **plugins, static, plugin × N**: the same reusable checks as `ci.yml`,
   for every plugin, without the npm cache. Nothing is built for release
   unless they pass.
1. **build** (no secrets, no token while plugin code runs): `npm ci`, packs every plugin whose version has no Release yet with
   `vestra-plugin pack`; writes the unsigned `index.json` and the store
   assets. A version that is already released is never rebuilt; earlier
   versions come from the published index.
2. **release-and-sign** (environment `plugins-index`, secret
   `VESTRA_INDEX_SIGNING_KEY`, plus `VESTRA_INDEX_SIGNING_KEY_NEXT` during a
   [key rotation](#key-rotation)): runs no plugin code and no `npm ci`. It
   checks the build artifact as untrusted data (each package's and store
   asset's sha256 and size against the index; the version history, `revoked`
   (append-only) and `generated` (previous + 1) against the previously signed
   index; `revoked` against `revoked.json`; nothing on the site but
   `index.json` and the assets it references), creates the Releases with
   `gh release create`, and signs `index.json`.
3. **attest** (`id-token: write`, `attestations: write`, this job only; runs
   no repository code): a SLSA build provenance attestation
   (`actions/attest-build-provenance`) for each new `.vxp`, the same bytes
   that release-and-sign checked and released. Verify one with
   `gh attestation verify <file>.vxp --repo vestrasys/vestra-player-plugins`.
4. **deploy**: publishes the signed site to GitHub Pages.

Build and signing are separate jobs so that code from plugins (build
scripts, dependencies, tests, and later third-party sources) never runs where
the signing key is.

What gets published (the repository must be **public**; Releases downloads
and Pages of a private repository need authentication or a paid plan):

| What | Where |
| --- | --- |
| Package | Release `<id>-v<version>`, asset `<id>-<version>.vxp`: `https://github.com/vestrasys/vestra-player-plugins/releases/download/<id>-v<version>/<id>-<version>.vxp` |
| Index | `https://vestrasys.github.io/vestra-player-plugins/index.json` |
| Signature | `index.json.sig` next to it: one or more base64 Ed25519 signatures over the exact bytes of `index.json`, one per line (no final line break); valid when any of them verifies with a trusted key, [`keys/index-signing.pub.pem`](keys/index-signing.pub.pem) |
| Store assets | `assets/<id>/<version>/README.md`, `CHANGELOG.md`, `icon.<png\|jpg\|jpeg>` next to the index (newest version only) |

### `index.json`

```json
{
  "schema": 1,
  "generated": 7,
  "name": "Vestra Player 官方仓库",
  "official": true,
  "plugins": [
    {
      "id": "zysilm.youtube",
      "name": "YouTube", "author": "zysilm", "punchline": "…", "description": "…",
      "tags": ["…"], "license": "Apache-2.0",
      "iconUrl": null, "iconSha256": null, "iconSize": null,
      "readmeUrl": "https://…/README.md", "readmeSha256": "…", "readmeSize": 812,
      "changelogUrl": "https://…/CHANGELOG.md", "changelogSha256": "…", "changelogSize": 240,
      "sourceUrl": "https://github.com/vestrasys/vestra-player-plugins/tree/main/plugins/youtube",
      "versions": [
        { "version": "0.3.0", "apiVersion": "vestra/1", "minPlayerVersion": "0.2.0",
          "capabilities": ["…"], "downloadUrl": "https://…/zysilm.youtube-0.3.0.vxp",
          "sha256": "…", "size": 9370, "published": "2026-10-21T…Z" }
      ]
    }
  ],
  "revoked": [],
  "extensions": {}
}
```

- Plugin fields come from the newest version's `manifest.json`; a field the
  manifest leaves out is `null` (`tags`: `[]`, `name`: the id).
- A plugin no longer in `plugins/` (removed, or renamed to a new id) is
  dropped from the next index; its Releases stay. A renamed plugin starts a
  new version history under its new id. (When youtube and bilibili moved
  from `vestra.*` to `zysilm.*`, the old entries were dropped this way;
  `revoked.json` needed no entry, since the player had not been released.)
- `versions` is newest first. There are no release channels and no download
  counts (ecosystem plan 1.6 items 8 and 9).
- `published` is when CI built the version.
- `generated` is a sequence number: the previously signed index's
  `generated` + 1 on every publish (1 on the first publish, and when the
  previous index predates the field). `release-and-sign` refuses any other
  value. It is not a date and may skip numbers from a client's point of view
  (a client does not see every publish). **Clients** remember the highest
  `generated` they have accepted from this repository and reject a signed
  index whose `generated` is lower (a replayed old index); an index without
  `generated` counts as 0, so once a client has seen one with the field it
  rejects any without it. The same value again is fine (an unchanged index
  fetched twice).
- Each store asset has `<asset>Url`, `<asset>Sha256` (lowercase hex sha256 of
  the file) and `<asset>Size` (bytes) for `icon`, `readme` and `changelog`;
  all three are `null` when the plugin has no such file. They follow the
  flat `sha256`/`size` pair of a version entry. The signature covers them, so
  a client that checks the downloaded file against them gets the same
  guarantee for README, changelog and icon as for the package. Limits (the
  store's read limits; the build fails above them): icon 512 KiB, README and
  changelog 256 KiB each.
- Compatibility: `generated` and the asset fields were added within
  `schema` 1. Clients ignore unknown keys (the store does), so older clients
  read the new index unchanged; this repository's own scripts still read an
  index from before them as the previous index.

Try it locally (no network; writes to a temporary directory and prints the
index):

```sh
npm run index:dry-run
```

### Key rotation

The trusted public keys are every `keys/*.pub.pem`: they check the
previously published index and the signing keys (`sign-index` refuses a
private key that matches none of them). `index.json.sig` carries one
signature per signing key, and a client accepts the index when any signature
verifies with any key it trusts. That makes a planned rotation possible
without a flag day:

1. **New key, dual signing.** `node scripts/generate-signing-key.mjs
   <private file outside the repository> keys/index-signing-next.pub.pem`.
   Commit the public key; put the private key into the secret
   `VESTRA_INDEX_SIGNING_KEY_NEXT` of the `plugins-index` environment (then
   delete the file). From the next publish on, `index.json.sig` has two
   lines: old key, new key.
2. **Players learn the new key.** A player release embeds both public keys
   in the store (`src/plugins/store/keys/`). Old players keep verifying the
   old key's signature, new ones either.
3. **Drop the old key** once the players that only know the old key are no
   longer supported: move the new private key into
   `VESTRA_INDEX_SIGNING_KEY`, delete `VESTRA_INDEX_SIGNING_KEY_NEXT`,
   replace `keys/index-signing.pub.pem` with the new public key and delete
   `keys/index-signing-next.pub.pem`, in one commit. The previous index on
   Pages is signed with both keys, so it still verifies.
4. A later player release removes the old key from the store.

If the old private key leaked, skip the waiting: set the new key as
`VESTRA_INDEX_SIGNING_KEY` right away (no `_NEXT`), ship a player that trusts
only the new key, and keep the old public key in `keys/` until the first
index signed with the new key is live (the build checks the previous index
with `keys/`), then remove it. Players that only trust the old key cannot
tell an attacker's index signed with the leaked key from ours; see the
store design §6.3.

Check a published or local index with any set of keys:

```sh
node scripts/verify-index.mjs keys/*.pub.pem https://vestrasys.github.io/vestra-player-plugins/
```

### The signing key

The index is signed in the `release-and-sign` job of
[`publish.yml`](.github/workflows/publish.yml) with an Ed25519 key held in the
`VESTRA_INDEX_SIGNING_KEY` secret of the `plugins-index` environment (and a
second one in `VESTRA_INDEX_SIGNING_KEY_NEXT` during a rotation). The public
key is [`keys/index-signing.pub.pem`](keys/index-signing.pub.pem); the
player and the store plugin embed it, so replacing the key needs a player
release ([key rotation](#key-rotation)). `node scripts/generate-signing-key.mjs <private> <public>` makes a
new pair (the private key file gets mode 600 and is never printed).
