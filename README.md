# Vestra Player plugins

Official [Vestra Player](https://github.com/vestrasys/vestra-player) plugins
that are **not** bundled with the installer, and (later) the registry of
third-party plugins for the official plugin repository. Users install these
plugins through the plugin store. Plugins use only the public plugin API from
[`@vestra-player/sdk`](https://github.com/vestrasys/vestra-player-sdk).

The built-in plugins (playback, playlist, subtitles, …) ship with the player
and live in the player repository under
[`src/plugins/`](https://github.com/vestrasys/vestra-player/tree/main/src/plugins),
not here.

## Layout

```text
plugins/<name>/   one plugin per directory: manifest.json, main.ts, .slint UI, tests/, README.md
                  (youtube, bilibili)
registry/         third-party registration files, registry/<id>.toml (not implemented yet)
scripts/          repository scripts: plugin.mjs (runs the SDK's vestra-plugin CLI),
                  check-boundaries.mjs, check-portability.mjs
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
npm run plugin -- pack youtube      # dist/ as <id>-<version>.zip
```

A name is a directory under `plugins/`; `--all` runs every plugin. The whole
repository, as CI runs it:

```sh
npm ci && npm run check && npm run format:check && npm run boundaries \
  && npm run portability && npm run build && npm test
```

`format:check` covers the repository's own scripts and configuration; plugin
sources keep their authors' formatting.

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

## Contributing

The submission process for third-party plugins is not written yet; see
[CONTRIBUTING.md](CONTRIBUTING.md) (placeholder).

## License

Apache-2.0, see [LICENSE](LICENSE).
