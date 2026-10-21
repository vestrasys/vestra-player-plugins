# registry/

Third-party plugins in the official repository are registered here, one file
per plugin: `registry/<plugin id>.toml`. The file names the plugin's source
repository, the commit to build and the owners; CI builds the plugin from that
source. Format, id and owner rules: [CONTRIBUTING.md](../CONTRIBUTING.md#third-party-plugins-registryplugin-idtoml).

`npm run registry` validates the files. Building and publishing third-party
plugins is not implemented yet, so no plugin is registered. The official
plugins live in [`plugins/`](../plugins/) and need no registry file.
