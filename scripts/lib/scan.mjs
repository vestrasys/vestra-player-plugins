/**
 * The capability scan of a version entry in index.json: which boundaries the
 * plugin's code crosses, as the one-word categories of the SDK's
 * `vestra-plugin scan` (SDK 1.8.0 and later; its docs/reference/scan.md).
 *
 *   "scan": { "uses": ["player", "clipboard"], "method": "types", "sdk": "1.8.0" }
 *
 * `uses`    the categories the code uses, each once, in the SDK's order
 *           (`SCAN_CATEGORIES`); empty when it uses none.
 * `method`  how the source was read: "types" (TypeScript, by type), "names"
 *           (by name, best effort) or "mixed" (some files each way).
 * `sdk`     the version of the SDK that scanned: its table decides the
 *           categories.
 *
 * The build (scripts/build-index.mjs) runs the scan on the plugin's source
 * in plugins/<name>/ for every version it adds to the index, and stores
 * only these three fields (no evidence: `vestra-plugin scan plugins/<name>`
 * prints it). A version that is in the published index already keeps its
 * entry as signed, with or without `scan`. It is a report for people (the
 * store shows it before installing and compares two versions); it gates
 * nothing.
 *
 * The shape check (`scanProblems`) uses nothing outside this file, so the
 * signing job, which has no node_modules, can run it. The SDK is looked up
 * only when `sdkScanner` is called.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { compareVersions, isVersion } from "./semver.mjs";

/** The categories, in the order of the SDK's table (capability-scan.json). */
export const SCAN_CATEGORIES = [
  "player",
  "plugins",
  "clipboard",
  "credentials",
  "camera",
  "microphone",
  "screen",
  "notifications",
];
export const SCAN_METHODS = ["types", "names", "mixed"];
const SCAN_KEYS = ["uses", "method", "sdk"];
/** The `scan` format of the SDK's output this file reads. */
const SCAN_FORMAT = 1;
/** The first SDK with `vestra-plugin scan`. */
export const SCAN_SDK = "1.8.0";

/** Problems with a version entry's optional `scan` (empty: valid or absent). */
export function scanProblems(scan, where) {
  if (scan === undefined) return [];
  const at = `${where}.scan`;
  if (!scan || typeof scan !== "object" || Array.isArray(scan))
    return [`${at} must be an object`];
  const problems = [];
  for (const key of Object.keys(scan))
    if (!SCAN_KEYS.includes(key)) problems.push(`${at}: unknown key "${key}"`);
  const { uses, method, sdk } = scan;
  if (
    !Array.isArray(uses) ||
    uses.some((category) => !SCAN_CATEGORIES.includes(category))
  )
    problems.push(
      `${at}: uses must be an array of ${SCAN_CATEGORIES.join(", ")}`,
    );
  else if (
    uses.some(
      (category, i) =>
        i > 0 &&
        SCAN_CATEGORIES.indexOf(uses[i - 1]) >=
          SCAN_CATEGORIES.indexOf(category),
    )
  )
    problems.push(
      `${at}: uses must list each category once, in the order ${SCAN_CATEGORIES.join(", ")}`,
    );
  if (!SCAN_METHODS.includes(method))
    problems.push(`${at}: method must be ${SCAN_METHODS.join(", ")}`);
  if (!isVersion(sdk)) problems.push(`${at}: sdk must be MAJOR.MINOR.PATCH`);
  return problems;
}

/**
 * The `scan` of an index entry from what `vestra-plugin scan` printed for
 * one directory. Throws when the output is not the format this file reads,
 * or when no source file was found (every plugin has an entry file).
 */
export function scanEntry(output, label) {
  if (output?.scan !== SCAN_FORMAT)
    throw new Error(
      `${label}: vestra-plugin scan printed format ${JSON.stringify(output?.scan)}, not ${SCAN_FORMAT}`,
    );
  if (output.method === "none")
    throw new Error(`${label}: vestra-plugin scan found no source files`);
  const entry = {
    uses: Array.isArray(output.uses) ? [...output.uses] : output.uses,
    method: output.method,
    sdk: output.sdk,
  };
  const problems = scanProblems(entry, label);
  if (problems.length) throw new Error(problems.join("\n"));
  return entry;
}

/**
 * Whether the repository asks for an SDK with the scan: the lowest version
 * of package.json's `@vestra-player/sdk` range (`^1.7.19` → 1.7.19) is
 * `SCAN_SDK` or later. Until then the scan is optional.
 */
export function scanRequired(range) {
  const lowest = /(\d+)\.(\d+)\.(\d+)/.exec(String(range ?? ""))?.[0];
  return isVersion(lowest) && compareVersions(lowest, SCAN_SDK) >= 0;
}

/**
 * The scanner of the SDK installed in `root` (node_modules/@vestra-player/sdk):
 * `{ scan, sdk }`, where `scan(directory, label)` resolves to the index
 * `scan` of the plugin in `directory` and prints a line to `log` when
 * requests by name could not be placed. `scan` is null when the installed
 * SDK is older than `SCAN_SDK` and package.json does not ask for one with
 * the scan yet (`scanRequired`); when it does, an SDK without it is an
 * error.
 */
export async function sdkScanner(root, { log = console.log } = {}) {
  const require = createRequire(join(root, "package.json"));
  const sdkPackage = require.resolve("@vestra-player/sdk/package.json");
  const { version, bin } = JSON.parse(await readFile(sdkPackage, "utf8"));
  const sdkRoot = dirname(sdkPackage);
  if (!existsSync(join(sdkRoot, "capability-scan.json"))) {
    const { devDependencies = {}, dependencies = {} } = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    const range =
      devDependencies["@vestra-player/sdk"] ??
      dependencies["@vestra-player/sdk"];
    if (scanRequired(range))
      throw new Error(
        `@vestra-player/sdk ${version} has no vestra-plugin scan, but package.json asks for ${range}; run npm ci`,
      );
    return { scan: null, sdk: version };
  }
  const cli = join(sdkRoot, bin["vestra-plugin"]);
  return {
    sdk: version,
    async scan(directory, label) {
      const result = spawnSync(process.execPath, [cli, "scan", directory], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      });
      if (result.status !== 0)
        throw new Error(`${label}: vestra-plugin scan failed`);
      let output;
      try {
        output = JSON.parse(result.stdout);
      } catch (error) {
        throw new Error(
          `${label}: vestra-plugin scan did not print JSON: ${error.message}`,
        );
      }
      const entry = scanEntry(output, label);
      if (output.unchecked?.length)
        log(
          `${label}: scan could not place ${output.unchecked.length} request(s) by name; they are not in uses (vestra-plugin scan ${label} lists them)`,
        );
      return entry;
    },
  };
}
