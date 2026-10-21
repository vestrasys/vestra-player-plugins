## What this changes

<!-- One of: an official plugin, a third-party registration, a revocation. -->

## Checklist

Official plugin (`plugins/<name>/`):

- [ ] `version` in `manifest.json` bumped and a `CHANGELOG.md` entry added
- [ ] `npm run check`, `npm run boundaries`, `npm run portability`, `npm test` pass

Third-party registration (`registry/<id>.toml`), see CONTRIBUTING.md:

- [ ] the id is `<GitHub owner of the repository>.<plugin name>` and equals the manifest's `id`
- [ ] the repository is public and `commit` is the full commit id of the version to publish
- [ ] I am listed in `owners` (new registration) or already an owner (change)
- [ ] `npm run registry` passes

Revocation (`revoked.json`):

- [ ] `versions` and `reason` follow CONTRIBUTING.md#revoking-a-version
