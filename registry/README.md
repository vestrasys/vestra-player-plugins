# registry/

Third-party plugins in the official repository are registered here, one file
per plugin: `registry/<plugin id>.toml`. The file names the plugin's source
repository, the commit to build and the owners; CI builds the plugin from that
source. The format is drafted in the player repository's
[ecosystem plan §1.3a](https://github.com/vestrasys/vestra-player/blob/main/doc/product/ecosystem-plan.md)
(in Chinese).

Not implemented yet: nothing reads this directory, and no plugin is
registered. The official plugins live in [`plugins/`](../plugins/) and need no
registry file.
