## What this changes

<!-- One of: a hosted plugin (plugins/), a third-party registration, a revocation.
     Title: "Add <id>", "Update <id> to <version>", or a short summary. -->

## Checklist

Third-party registration (`registry/<id>.toml`), see [Contributing a plugin](https://github.com/vestrasys/vestra-player-plugins/blob/main/README.md#contributing-a-plugin):

- [ ] the id is `<GitHub owner of the repository>.<plugin name>` and equals the manifest's `id`
- [ ] the repository is public and `commit` is the full commit id of the version to publish
- [ ] `version` in `manifest.json` is new (bumped for an update)
- [ ] the manifest has the display fields (`name`, `author`, `punchline`, `description`, `tags`, `license`, `sourceUrl`) and asks only for the capabilities it uses
- [ ] `README.md` and `CHANGELOG.md` sit next to the manifest
- [ ] `vestra-plugin check`, `vestra-plugin test` and `vestra-plugin pack` pass at that commit
- [ ] I am listed in `owners` (new registration) or already an owner (change)
- [ ] `npm run registry` passes

Hosted third-party plugin (`plugins/<name>/`), see [CONTRIBUTING.md](https://github.com/vestrasys/vestra-player-plugins/blob/main/CONTRIBUTING.md#hosted-third-party-plugins-pluginsname):

- [ ] the id is `<owner>.<name>` with the owner from `plugins/owners.toml` (never `vestra.`)
- [ ] `version` in `manifest.json` bumped and a `CHANGELOG.md` entry added
- [ ] `npm run check`, `npm run boundaries`, `npm run portability`, `npm test` pass

Revocation (`revoked.json`):

- [ ] the entry is appended at the end; `versions` and `reason` follow [CONTRIBUTING.md](https://github.com/vestrasys/vestra-player-plugins/blob/main/CONTRIBUTING.md#revoking-a-version)
