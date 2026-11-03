/**
 * What a bundled plugin's entry file is made of. The SDK's `vestra-plugin
 * build` bundles the entry with esbuild (package.json `"vestra": { "bundle":
 * true }`) and resolves imports the way esbuild does: through the nearest
 * tsconfig.json's `paths`, `baseUrl` and `extends`, symbolic links and
 * node_modules. Any of those could pull code from outside the plugin into the
 * package, where neither review nor the security scan looks.
 *
 * `bundleProblems` repeats the SDK's esbuild call with the same options plus
 * a metafile, without writing anything, and refuses
 * - any bundled input outside plugins/<name>/, other than the plugin's own
 *   lockfile-installed packages in plugins/<name>/node_modules/;
 * - an output that differs from the dist/ file the SDK wrote, so the
 *   metafile is known to describe the shipped bytes (if the SDK's options
 *   change, this fails until the options here follow).
 * scripts/plugin.mjs runs it after every `build` and `pack`, so CI and the
 * publish build (which packs through plugin.mjs) both check it.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SDK = "@vestra-player/sdk";
/** The SDK's bundle banner (bin/vestra-plugin.mjs `bundle()`), byte for byte. */
const BANNER =
  'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';

const inside = (path, directory) =>
  path === directory || path.startsWith(directory + sep);

/** The SDK's entry rule: manifest `entry`, its .ts source if present. */
function entryOf(directory, manifest) {
  if (typeof manifest.entry !== "string") return undefined;
  const entry = manifest.entry.replace(/^dist\//, "");
  const source = [entry.replace(/\.js$/, ".ts"), entry].find((file) =>
    existsSync(join(directory, file)),
  );
  return source && { source, built: source.replace(/\.ts$/, ".js") };
}

/** Package directories npm installed from the plugin's lockfile. */
async function lockedPackages(directory) {
  try {
    const lock = JSON.parse(
      await readFile(join(directory, "package-lock.json"), "utf8"),
    );
    return Object.keys(lock.packages ?? {})
      .filter((key) => key.startsWith("node_modules/"))
      .map((key) => resolve(directory, ...key.split("/")));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Problems of one plugin's bundle (after `vestra-plugin build`): bundled
 * inputs from outside the plugin, or a bundle that is not the shipped one.
 * `root` is the working directory the SDK CLI ran in.
 */
export async function bundleProblems(root, directory, label) {
  let options;
  try {
    options =
      JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
        .vestra ?? {};
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!options.bundle) return [];
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  const entry = entryOf(directory, manifest);
  if (!entry) return [`${label}: no entry source to check the bundle of`];
  const esbuild = await import(
    pathToFileURL(
      createRequire(join(directory, "package.json")).resolve("esbuild"),
    ).href
  );
  const outfile = join(directory, "dist", entry.built);
  const external = [
    ...(typeof options.bundle === "object"
      ? (options.bundle.external ?? [])
      : []),
    SDK,
    `${SDK}/*`,
  ];
  const result = await esbuild.build({
    entryPoints: [join(directory, entry.source)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external,
    banner: { js: BANNER },
    outfile,
    logLevel: "silent",
    absWorkingDir: root,
    metafile: true,
    write: false,
  });
  const problems = [];
  const own = resolve(directory);
  const modules = join(own, "node_modules");
  const locked = await lockedPackages(own);
  for (const input of Object.keys(result.metafile.inputs)) {
    // esbuild's placeholder for a module a package's "browser" field disables.
    if (input.startsWith("(disabled):")) continue;
    const path = resolve(root, input.replace(/^[a-z]+:/, ""));
    const allowed = inside(path, modules)
      ? locked.some((pkg) => inside(path, pkg))
      : inside(path, own);
    if (!allowed)
      problems.push(
        `${label}: the bundle includes ${relative(root, path).split(sep).join("/")}, outside the plugin and its locked dependencies (tsconfig paths, baseUrl or extends, a symbolic link, or an unlocked package?)`,
      );
  }
  const built = result.outputFiles.find(
    (file) => resolve(file.path) === resolve(outfile),
  );
  const shipped = existsSync(outfile) ? await readFile(outfile) : undefined;
  if (
    !built ||
    !shipped ||
    Buffer.compare(Buffer.from(built.contents), shipped)
  )
    problems.push(
      `${label}: the bundle check's esbuild output differs from ${relative(root, outfile).split(sep).join("/")}; scripts/lib/bundle.mjs must use the SDK's bundle options`,
    );
  return problems;
}
