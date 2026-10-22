# Vestra Player plugins

The official plugin repository of
[Vestra Player](https://github.com/vestrasys/vestra-player): the source of the
official plugins that are **not** bundled with the installer, the registry of
third-party plugins, and the CI that publishes them as the signed index the
plugin store reads. Plugins use only the public plugin API from
[`@vestra-player/sdk`](https://github.com/vestrasys/vestra-player-sdk).

The built-in plugins (playback, playlist, subtitles, …) ship with the player
and live in the player repository under
[`src/plugins/`](https://github.com/vestrasys/vestra-player/tree/main/src/plugins),
not here.

## Layout

```text
plugins/<name>/   official plugins (id vestra.<name>): manifest.json, main.ts, .slint UI,
                  tests/, README.md, CHANGELOG.md (youtube, bilibili)
registry/         third-party registrations, registry/<id>.toml (see CONTRIBUTING.md)
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
                  _static.yml, _plugin.yml, _index-dryrun.yml (see "CI")
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
      "id": "vestra.youtube",
      "name": "YouTube", "author": "Vestra Player", "punchline": "…", "description": "…",
      "tags": ["…"], "license": "Apache-2.0",
      "iconUrl": null, "iconSha256": null, "iconSize": null,
      "readmeUrl": "https://…/README.md", "readmeSha256": "…", "readmeSize": 812,
      "changelogUrl": "https://…/CHANGELOG.md", "changelogSha256": "…", "changelogSize": 240,
      "sourceUrl": "https://github.com/vestrasys/vestra-player-plugins/tree/main/plugins/youtube",
      "versions": [
        { "version": "0.2.0", "apiVersion": "vestra/1", "minPlayerVersion": "0.2.0",
          "capabilities": ["…"], "downloadUrl": "https://…/vestra.youtube-0.2.0.vxp",
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

### Revocation

`revoked.json` lists versions the store must disable:

```json
[{ "id": "vestra.youtube", "versions": ">=0.2.0 <0.2.3", "reason": "…" }]
```

It is copied into the index's `revoked` unchanged on the next publish. It is
**append-only**: published entries are never removed, changed or reordered
(CI and the signing job refuse), because the store treats an index that lacks
a revocation it has seen as a replayed old index. See
[CONTRIBUTING.md](CONTRIBUTING.md#revoking-a-version) for the range syntax.

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

## Contributing

Official plugin changes, third-party registrations and revocations:
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
