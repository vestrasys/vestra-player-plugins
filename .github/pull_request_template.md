## What this changes

<!-- One of: a new plugin or a plugin update (plugins/), a revocation.
     Title: "Add <id>", "Update <id> to <version>", or a short summary. -->

## Checklist

Plugin (`plugins/<name>/`), see [CONTRIBUTING.md](https://github.com/vestrasys/vestra-player-plugins/blob/main/CONTRIBUTING.md#checklist):

- [ ] the id is `<owner>.<name>` with the owner from `plugins/owners.toml` (never `vestra.`)
- [ ] `version` in `manifest.json` bumped and a `CHANGELOG.md` entry added
- [ ] the manifest has the display fields (`name`, `author`, `punchline`, `description`, `tags`, `license`, `sourceUrl`) and asks only for the capabilities it uses
- [ ] `npm run check`, `npm run boundaries`, `npm run portability`, `npm run registry`, `npm test` pass
- [ ] if the plugin runs programs, downloads or runs code, uses hard-coded hosts or touches files outside its directories, this description says why (the [security scan](https://github.com/vestrasys/vestra-player-plugins/blob/main/MAINTAINING.md#security-review) flags it for review)

Revocation (`revoked.json`):

- [ ] the entry is appended at the end; `versions` and `reason` follow [MAINTAINING.md](https://github.com/vestrasys/vestra-player-plugins/blob/main/MAINTAINING.md#revoking-a-version)

<!-- Registrations (registry/<id>.toml) cannot be merged yet: building plugins
     from their authors' repositories is not implemented
     (MAINTAINING.md, "Registered third-party plugins (planned)"). -->
