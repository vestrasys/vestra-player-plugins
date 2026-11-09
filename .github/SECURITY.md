# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull
request: use **Report a vulnerability** on the
[Security tab](https://github.com/vestrasys/vestra-player-plugins/security/advisories/new)
of this repository (GitHub private vulnerability reporting).

This covers:

- the plugins hosted in `plugins/`;
- the store index and its signature (`index.json`, `index.json.sig`, the
  keys in `keys/`), the publish pipeline and the repository scripts
  (`scripts/`, `.github/workflows/`);
- `revoked.json` and the third-party registrations in `registry/`, for
  example a registered plugin that behaves maliciously.

A problem in a third-party plugin's own code also goes to its author (the
repository named in its `registry/<id>.toml`); report it here as well when
the plugin should be revoked. A problem in the player itself goes to the
player's repository.

Please include the plugin id and version (or the file and commit), what an
attacker can do, and the steps to reproduce it. We confirm a report within
7 days and say what we will do about it. A fix ships as a new plugin
version; an affected version is revoked in `revoked.json` (the player then
refuses to install it and warns users who have it). We credit reporters in
the advisory unless they ask us not to.

## Supported versions

Only the latest version of each plugin in the store index is supported.
