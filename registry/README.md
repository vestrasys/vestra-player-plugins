# registry/

Registered third-party plugins are to be listed here, one file per plugin:
`registry/<plugin id>.toml`. Their source stays in the author's repository. The file names the plugin's source
repository, the commit to build and the owners; CI is to build the plugin from that
source. The format and the id and owner rules:
[MAINTAINING.md](../MAINTAINING.md#registered-third-party-plugins-planned).

`npm run registry` validates the files. Building and publishing registered
plugins is not implemented yet, so no plugin is registered and a
registration cannot be merged. To publish a plugin today, add it to
[`plugins/`](../plugins/): [CONTRIBUTING.md](../CONTRIBUTING.md).

The other two kinds of plugin need no registry file: the third-party plugins
hosted in [`plugins/`](../plugins/) (owners in `plugins/owners.toml`), and
the official plugins, which are built into the player and are not in this
repository. Their `vestra.` prefix cannot be registered here.
