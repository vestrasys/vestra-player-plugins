# registry/

Registered third-party plugins are listed here, one file per plugin:
`registry/<plugin id>.toml`. Their source stays in the author's repository. The file names the plugin's source
repository, the commit to build and the owners; CI builds the plugin from that
source. How to register, with the format: [Contributing a plugin](../README.md#contributing-a-plugin);
id and owner rules: [CONTRIBUTING.md](../CONTRIBUTING.md#third-party-registrations-ids-and-owners).

`npm run registry` validates the files. Building and publishing registered
plugins is not implemented yet, so no plugin is registered.

The other two kinds of plugin need no registry file: the third-party plugins
hosted in [`plugins/`](../plugins/) (owners in `plugins/owners.toml`), and
the official plugins, which are built into the player and are not in this
repository. Their `vestra.` prefix cannot be registered here.
