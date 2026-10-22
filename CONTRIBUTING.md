# Contributing

This repository publishes the official Vestra Player plugin index. It
accepts three kinds of change, each through a pull request to `main`:

- changes to an official plugin in `plugins/`;
- a third-party plugin registration in `registry/<plugin id>.toml`;
- a revocation in `revoked.json`.

Merging to `main` publishes (see [README.md](README.md#publishing)). There is
no testing channel: CI tests, user rollback and revocation are the safety net.

## Official plugins (`plugins/<name>/`)

- The id is `vestra.<name>`. `vestra.` is reserved for the plugins in this
  directory.
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
- Run the checks in [README.md](README.md#build-and-test) before opening the
  pull request.

## CI on pull requests

Every pull request runs [`ci.yml`](.github/workflows/ci.yml)
([README.md](README.md#ci) has the details):

```text
changes ─────────────────────┐
                             ▼
static ──┬──────────▶ plugin × N ──┬──▶ ci-ok
         └──▶ index-dryrun ────────┘
```

- **static**: type check, formatting, plugin boundaries, portability,
  registry and `revoked.json` rules, script tests, typos, actionlint, zizmor.
- **plugin × N**: each changed plugin (all of them when shared files
  change) is type checked, tested and packed on Ubuntu (Node 22.18 and 24),
  Windows and macOS, and the `.vxp` is checked.
- **index-dryrun**: builds and signs the index with a throwaway key.
- **ci-ok** is the required check. It passes when nothing failed.

Pull requests from forks get no secrets and a read-only token. A pull
request that changes `registry/` or `revoked.json` also runs
`registry.yml` (owner rule), which never runs the pull request's code.

## Third-party plugins (`registry/<plugin id>.toml`)

The official repository builds third-party plugins from source, like
Flathub: you register your source repository and a commit; CI builds the
package; a maintainer reviews the source. So only plugins with public source
are accepted.

> **Status:** registrations are validated (format, id prefix, owners), but
> building and publishing third-party plugins is not implemented yet. CI
> refuses to publish while a registration exists, so registrations are not
> merged until the third-party build job lands. The rules below are final.

### The registration file

```toml
# registry/someone.cool-visualizer.toml
repository = "https://github.com/someone/cool-visualizer"
commit = "3f2a9c1d4b5e6f708192a3b4c5d6e7f8091a2b3c"
path = "."            # the plugin's directory in that repository (default ".")
owners = ["someone"]
```

| Key | Rule |
| --- | --- |
| file name | the plugin id plus `.toml`; the id is the manifest's `id` |
| `repository` | `https://github.com/<owner>/<repo>`, public, no trailing `/` or `.git` |
| `commit` | the full 40-digit commit id to build |
| `path` | optional; a relative directory without `..`, the one with `manifest.json` |
| `owners` | GitHub logins allowed to change this registration (at least one) |

No other keys (there is no `channel`). The file is a small subset of TOML:
top-level `key = "string"` or `key = ["strings"]`, with `#` comments.

### The id

- The id is `<owner>.<plugin name>`, where `<owner>` is the GitHub user or
  organization that owns `repository` (compared without case). For
  `https://github.com/someone/cool-visualizer`, the id must start with
  `someone.`. Letters, digits, `.`, `-` and `_` only.
- `vestra.` is reserved for the official plugins, and an id cannot repeat an
  existing one (even with different case).
- The player does not treat ids specially: being official comes from where a
  plugin is installed from, not from its id. The prefix rule only keeps ids
  unique in this repository.

### Owners

- A new registration must list the pull request author in `owners`.
- After that, only an owner listed on `main` may change the file (a new
  `commit`, a new `path`, adding or removing owners) or remove it. A
  maintainer can step in for an abandoned registration.
- The [`Registry owners`](.github/workflows/registry.yml) check enforces this
  from the base branch's copy of the script, so a pull request cannot change
  the check that judges it.

### Releasing a new version

Bump `version` in your plugin's `manifest.json`, commit it in your
repository, and open a pull request that changes `commit` (usually a one-line
change). A maintainer reviews the source between the old and the new commit.
After the merge, CI builds the package, releases it and adds it to the
signed index.

### Check locally

```sh
npm ci
npm run registry     # format, id, owners syntax, revoked.json
```

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

- `id`: the plugin id. `reason`: 1–500 characters, shown to users.
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
- Owners of a third-party plugin can ask for a revocation; maintainers can
  revoke any version.

## The signing key

The index is signed in the `release-and-sign` job of
[`publish.yml`](.github/workflows/publish.yml) with an Ed25519 key held in the
`VESTRA_INDEX_SIGNING_KEY` secret of the `plugins-index` environment (and a
second one in `VESTRA_INDEX_SIGNING_KEY_NEXT` during a rotation). The public
key is [`keys/index-signing.pub.pem`](keys/index-signing.pub.pem); the
player and the store plugin embed it, so replacing the key needs a player
release ([key rotation](README.md#key-rotation)). `node scripts/generate-signing-key.mjs <private> <public>` makes a
new pair (the private key file gets mode 600 and is never printed).
