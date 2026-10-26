/**
 * npm dependencies of hosted plugins: the supply-chain rules (CONTRIBUTING.md,
 * "npm dependencies").
 *
 * A plugin may have its own plugins/<name>/package.json with runtime
 * `dependencies`. The SDK's `vestra-plugin build` bundles the entry and those
 * dependencies into one file with esbuild (`"vestra": { "bundle": true }`),
 * so the package (.vxp) has no node_modules. The build tools (esbuild,
 * TypeScript, the SDK) come from the repository root, so a plugin's lockfile
 * holds exactly what ends up in its package.
 *
 * Static rules (`dependencyProblems`, no install, run by `npm run registry`,
 * the index build and before every install):
 * - package.json: only the keys in PACKAGE_KEYS; no devDependencies,
 *   optional, peer or bundled dependencies, overrides or workspaces; no
 *   install lifecycle scripts; with dependencies, `vestra.bundle` is `true`
 *   (no `external`) and `vestra.assets` includes "licenses" (the SDK leaves
 *   *.md such as LICENSE.md out otherwise); `vestra.assets` never names
 *   node_modules;
 * - package-lock.json is required (lockfileVersion 2 or 3) and its root
 *   lists the same dependencies as package.json;
 * - every locked package comes from https://registry.npmjs.org/ with a
 *   sha512 integrity, is no link, is not optional or bundled, has no install
 *   script and no `os`/`cpu`/`libc` restriction (prebuilt native binaries),
 *   and has a license whose SPDX expression is satisfied by ALLOWED_LICENSES;
 * - dependency-inventory.json lists exactly the locked packages (name,
 *   version, license) with their license files under
 *   licenses/<name, "/" as "__">/, and those files exist.
 *
 * Installed rules (`installedProblems`, after `npm ci --ignore-scripts`):
 * - no package contains native code (NATIVE_FILE: .node and other binaries,
 *   binding.gyp) or declares `gypfile` or an install script;
 * - each package's own license matches the lockfile;
 * - the license files in licenses/ equal the ones the package ships; a
 *   package that ships none needs its license text in licenses/ (from its
 *   source repository; reviewed by a maintainer).
 *
 * Size (`sizeProblems`, every plugin): the .vxp at most PACKAGE_LIMIT bytes,
 * its files at most UNPACKED_LIMIT bytes together.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Licenses a bundled dependency may have: permissive licenses that can be
 * redistributed inside an Apache-2.0 plugin with their notices. Copyleft
 * (GPL, AGPL, LGPL, MPL, EUPL, SSPL, ...) and anything unlisted is refused;
 * adding a license here needs a maintainer's review.
 */
export const ALLOWED_LICENSES = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "Zlib",
  "BlueOak-1.0.0",
  "BSL-1.0",
  "CC0-1.0",
  "Unlicense",
]);

/** The .vxp download, and its files unpacked (the store's budget). */
export const PACKAGE_LIMIT = 4 * 1024 * 1024;
export const UNPACKED_LIMIT = 16 * 1024 * 1024;

export const REGISTRY = "https://registry.npmjs.org/";
export const INVENTORY = "dependency-inventory.json";
export const LICENSES = "licenses";

const PACKAGE_KEYS = new Set([
  "name",
  "version",
  "private",
  "type",
  "description",
  "license",
  "dependencies",
  "scripts",
  "vestra",
]);
const LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
];
/** Native code and other binaries a JavaScript bundle never needs. */
export const NATIVE_FILE =
  /(^binding\.gyp$|\.(node|dll|dylib|exe|so|a|lib|o|obj)$|\.so\.\d+(\.\d+)*$)/i;
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const NAME = /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i;

/** The directory under licenses/ of a package. */
export const licenseDirectory = (name) => name.replace("/", "__");

/** Whether an SPDX expression is satisfied by `allowed` (OR: one side, AND: all). */
export function spdxAllowed(expression, allowed = ALLOWED_LICENSES) {
  const tokens = String(expression).match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const factor = () => {
    if (peek() === "(") {
      position++;
      const value = or();
      if (tokens[position++] !== ")") throw new Error("unbalanced parentheses");
      return value;
    }
    let atom = tokens[position++];
    if (!atom || ["AND", "OR", "WITH", ")"].includes(atom))
      throw new Error("incomplete expression");
    if (peek() === "WITH") {
      position++;
      atom = `${atom} WITH ${tokens[position++]}`;
    }
    return allowed.has(atom);
  };
  const and = () => {
    let value = factor();
    while (peek() === "AND") {
      position++;
      value = factor() && value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (peek() === "OR") {
      position++;
      value = and() || value;
    }
    return value;
  };
  const value = or();
  if (position !== tokens.length) throw new Error("not an SPDX expression");
  return value;
}

function licenseProblem(license) {
  if (typeof license !== "string" || !license)
    return "no license in the lockfile";
  try {
    if (spdxAllowed(license)) return null;
  } catch (error) {
    return `license ${JSON.stringify(license)}: ${error.message}`;
  }
  return `license ${license} is not allowed (allowed: ${[...ALLOWED_LICENSES].join(", ")})`;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`${file}: ${error.message}`);
  }
}

/** The plugin's package.json, or undefined. */
export const readPackageJson = (directory) =>
  readJson(join(directory, "package.json"));

/** Whether the plugin has runtime npm dependencies. */
export async function hasDependencies(directory) {
  const json = await readPackageJson(directory);
  return Object.keys(json?.dependencies ?? {}).length > 0;
}

/** [{ path, name, entry }] of the locked packages (not the root). */
export function lockedPackages(lock) {
  return Object.entries(lock?.packages ?? {})
    .filter(([path]) => path !== "")
    .map(([path, entry]) => ({
      path,
      name: entry?.name ?? path.slice(path.lastIndexOf("node_modules/") + 13),
      entry: entry ?? {},
    }));
}

/** The inventory the lockfile implies, without license files: sorted. */
function expectedInventory(lock) {
  const seen = new Map();
  for (const { name, entry } of lockedPackages(lock))
    seen.set(`${name}@${entry.version}`, {
      name,
      version: entry.version,
      license: entry.license,
    });
  return [...seen.values()].sort((a, b) =>
    a.name === b.name
      ? String(a.version).localeCompare(String(b.version))
      : a.name < b.name
        ? -1
        : 1,
  );
}

/**
 * Static problems of one plugin directory's npm dependencies (no install).
 * `label` prefixes each message (`plugins/<name>`). `inventory: false` skips
 * dependency-inventory.json and licenses/ (written from an install).
 */
export async function dependencyProblems(
  directory,
  label,
  { inventory: checkInventory = true } = {},
) {
  const problems = [];
  const problem = (message) => problems.push(`${label}: ${message}`);
  let json;
  let lock;
  let inventory;
  try {
    json = await readPackageJson(directory);
    lock = await readJson(join(directory, "package-lock.json"));
    inventory = await readJson(join(directory, INVENTORY));
  } catch (error) {
    return [`${label}: ${error.message}`];
  }
  if (json === undefined) {
    if (lock !== undefined) problem("package-lock.json without package.json");
    if (inventory !== undefined)
      problem(`${INVENTORY} without package.json dependencies`);
    return problems;
  }
  if (!json || typeof json !== "object" || Array.isArray(json))
    return [`${label}: package.json is not an object`];
  for (const key of Object.keys(json))
    if (!PACKAGE_KEYS.has(key))
      problem(
        key === "devDependencies"
          ? "package.json: no devDependencies; the build tools (esbuild, TypeScript, the SDK) come from the repository root"
          : `package.json: "${key}" is not allowed (allowed: ${[...PACKAGE_KEYS].join(", ")})`,
      );
  for (const script of LIFECYCLE)
    if (json.scripts?.[script] !== undefined)
      problem(`package.json: no "${script}" script (installs run no scripts)`);
  const dependencies = json.dependencies ?? {};
  if (
    typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    !Object.values(dependencies).every((value) => typeof value === "string")
  ) {
    problem("package.json: dependencies must map names to versions");
    return problems;
  }
  const vestra = json.vestra ?? {};
  if (
    vestra.assets !== undefined &&
    !(
      Array.isArray(vestra.assets) &&
      vestra.assets.every((asset) => typeof asset === "string")
    )
  ) {
    problem("package.json: vestra.assets must be a list of paths");
    return problems;
  }
  for (const asset of vestra.assets ?? [])
    if (String(asset).split(/[\\/]/).includes("node_modules"))
      problem(`package.json: vestra.assets must not ship node_modules`);
  const names = Object.keys(dependencies);
  if (!names.length) {
    if (lock !== undefined) problem("package-lock.json without dependencies");
    if (inventory !== undefined)
      problem(`${INVENTORY} without package.json dependencies`);
    return problems;
  }
  if (vestra.bundle !== true)
    problem(
      'package.json: a plugin with dependencies needs "vestra": { "bundle": true } (the package has no node_modules; "external" is not allowed)',
    );
  // The SDK leaves *.md out of a package unless it is an asset (LICENSE.md).
  if (!(vestra.assets ?? []).includes(LICENSES))
    problem(
      `package.json: a plugin with dependencies needs "${LICENSES}" in vestra.assets, so that every license file is packed as it is`,
    );

  if (lock === undefined) {
    problem("package-lock.json is required (run npm install in the plugin)");
    return problems;
  }
  if (![2, 3].includes(lock.lockfileVersion))
    problem(
      "package-lock.json: lockfileVersion must be 2 or 3 (npm 7 or later)",
    );
  const root = lock.packages?.[""] ?? {};
  if (!isDeepStrictEqual(root.dependencies ?? {}, dependencies))
    problem(
      "package-lock.json does not match package.json dependencies (run npm install in the plugin)",
    );
  for (const key of [
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])
    if (Object.keys(root[key] ?? {}).length)
      problem(`package-lock.json: the root has ${key}`);

  for (const { path, name, entry } of lockedPackages(lock)) {
    const where = (message) => problem(`${path}: ${message}`);
    if (!path.startsWith("node_modules/") || path.split("/").includes(".."))
      where("not an installed package path");
    if (!NAME.test(name)) where("not an npm package name");
    if (entry.link) where("links are not allowed");
    if (typeof entry.version !== "string") where("no version");
    if (
      typeof entry.resolved !== "string" ||
      !entry.resolved.startsWith(REGISTRY) ||
      !entry.resolved.endsWith(".tgz")
    )
      where(`must be resolved from ${REGISTRY} (no git, file or URL sources)`);
    if (
      typeof entry.integrity !== "string" ||
      !/^sha512-/.test(entry.integrity)
    )
      where("needs a sha512 integrity");
    if (entry.hasInstallScript)
      where("has an install script (native code is not allowed)");
    for (const key of ["os", "cpu", "libc"])
      if (entry[key] !== undefined)
        where(`is limited to some ${key} values (a prebuilt native binary)`);
    for (const key of ["dev", "optional", "devOptional"])
      if (entry[key]) where(`is ${key}: only runtime dependencies are allowed`);
    if (entry.inBundle) where("bundled dependencies are not allowed");
    const license = licenseProblem(entry.license);
    if (license) where(license);
  }

  // The inventory shipped in the package: the locked packages and their
  // license files under licenses/.
  if (!checkInventory) return problems;
  if (inventory === undefined) {
    problem(
      `${INVENTORY} is required: run node scripts/plugin-deps.mjs licenses ${label.replace(/^plugins\//, "")} --write`,
    );
    return problems;
  }
  if (!Array.isArray(inventory)) {
    problem(`${INVENTORY} is not an array`);
    return problems;
  }
  const expected = expectedInventory(lock);
  const listed = inventory.map(({ name, version, license }) => ({
    name,
    version,
    license,
  }));
  if (!isDeepStrictEqual(listed, expected))
    problem(
      `${INVENTORY} does not list the locked packages (name, version, license, sorted); run node scripts/plugin-deps.mjs licenses ${label.replace(/^plugins\//, "")} --write`,
    );
  for (const item of inventory) {
    const files = item.licenseFiles;
    if (Array.isArray(files) && !files.length) {
      problem(
        `${INVENTORY}: ${item.name} has no license files; when the package ships none, put its license text (from its source repository) into ${LICENSES}/${licenseDirectory(String(item.name))}/LICENSE and write the inventory again`,
      );
      continue;
    }
    if (
      !Array.isArray(files) ||
      !files.length ||
      !files.every(
        (file) =>
          typeof file === "string" && file && !/[\\/]|^\.\.?$/.test(file),
      )
    ) {
      problem(`${INVENTORY}: ${item.name}: licenseFiles must list file names`);
      continue;
    }
    for (const file of files)
      if (
        !existsSync(
          join(directory, LICENSES, licenseDirectory(String(item.name)), file),
        )
      )
        problem(
          `${LICENSES}/${licenseDirectory(String(item.name))}/${file} is missing`,
        );
  }
  const directories = new Set(
    inventory.map((item) => licenseDirectory(String(item.name))),
  );
  if (existsSync(join(directory, LICENSES)))
    for (const item of await readdir(join(directory, LICENSES), {
      withFileTypes: true,
    }))
      if (item.isDirectory() && !directories.has(item.name))
        problem(`${LICENSES}/${item.name} belongs to no locked package`);
  return problems;
}

async function walk(directory, base = directory) {
  const out = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    // Nested node_modules are packages of their own (scanned separately).
    if (item.isDirectory()) {
      if (item.name !== "node_modules") out.push(...(await walk(path, base)));
    } else out.push(relative(base, path).split("\\").join("/"));
  }
  return out;
}

/** The license files a package ships (top level), sorted. */
async function shippedLicenseFiles(packageDirectory) {
  return (await readdir(packageDirectory, { withFileTypes: true }))
    .filter((item) => item.isFile() && LICENSE_FILE.test(item.name))
    .map((item) => item.name)
    .sort();
}

/**
 * Problems of the installed node_modules of a plugin (after npm ci), and the
 * inventory with license files it implies (for `writeLicenses`).
 */
export async function installedProblems(directory, label) {
  const problems = [];
  const problem = (message) => problems.push(`${label}: ${message}`);
  const lock = await readJson(join(directory, "package-lock.json"));
  const inventory = [];
  const sources = new Map(); // licenses/<dir>/<file> → shipped file path
  for (const { path, name, entry } of lockedPackages(lock)) {
    const packageDirectory = join(directory, path);
    let meta;
    try {
      meta = await readJson(join(packageDirectory, "package.json"));
    } catch (error) {
      problem(error.message);
      continue;
    }
    if (!meta) {
      problem(`${path} is not installed`);
      continue;
    }
    if (meta.name !== name || meta.version !== entry.version)
      problem(
        `${path}: installed ${meta.name}@${meta.version}, locked ${name}@${entry.version}`,
      );
    if (meta.license !== entry.license)
      problem(
        `${path}: its package.json has license ${JSON.stringify(meta.license ?? meta.licenses)}, the lockfile ${JSON.stringify(entry.license)}`,
      );
    if (meta.gypfile) problem(`${path}: gypfile (native code)`);
    for (const script of ["preinstall", "install", "postinstall"])
      if (meta.scripts?.[script] !== undefined)
        problem(
          `${path}: has an install script "${script}" (native code is not allowed)`,
        );
    for (const file of await walk(packageDirectory))
      if (NATIVE_FILE.test(file.slice(file.lastIndexOf("/") + 1)))
        problem(`${path}/${file}: native code is not allowed`);

    const shipped = await shippedLicenseFiles(packageDirectory);
    const target = licenseDirectory(name);
    let licenseFiles = shipped;
    if (!shipped.length) {
      // Supplied by the plugin from the package's source repository.
      const own = join(directory, LICENSES, target);
      licenseFiles = existsSync(own)
        ? (await readdir(own, { withFileTypes: true }))
            .filter((item) => item.isFile())
            .map((item) => item.name)
            .sort()
        : [];
      if (!licenseFiles.length)
        problem(
          `${name}@${entry.version} ships no license file: put its license text (from its source repository) into ${LICENSES}/${target}/LICENSE`,
        );
      for (const file of licenseFiles)
        if (!(await stat(join(own, file))).size)
          problem(`${LICENSES}/${target}/${file} is empty`);
    }
    for (const file of shipped) {
      const key = `${target}/${file}`;
      const source = join(packageDirectory, file);
      const earlier = sources.get(key);
      if (earlier && !(await readFile(earlier)).equals(await readFile(source)))
        problem(
          `${name}: two installed versions ship different ${file}; dedupe them (npm dedupe)`,
        );
      sources.set(key, source);
    }
    if (
      !inventory.some(
        (item) => item.name === name && item.version === entry.version,
      )
    )
      inventory.push({
        name,
        version: entry.version,
        license: entry.license,
        licenseFiles,
      });
  }
  inventory.sort((a, b) =>
    a.name === b.name
      ? String(a.version).localeCompare(String(b.version))
      : a.name < b.name
        ? -1
        : 1,
  );

  // The committed inventory and license texts match what is installed.
  const committed = await readJson(join(directory, INVENTORY));
  if (committed !== undefined && !isDeepStrictEqual(committed, inventory))
    problem(
      `${INVENTORY} differs from the installed packages; run node scripts/plugin-deps.mjs licenses ${label.replace(/^plugins\//, "")} --write`,
    );
  for (const [key, source] of sources) {
    const file = join(directory, LICENSES, ...key.split("/"));
    if (
      existsSync(file) &&
      !(await readFile(file)).equals(await readFile(source))
    )
      problem(`${LICENSES}/${key} differs from the file the package ships`);
  }
  return { problems, inventory, sources };
}

/**
 * Writes dependency-inventory.json and copies the shipped license files into
 * licenses/ (license texts supplied for packages that ship none are kept).
 */
export async function writeLicenses(directory, label) {
  const { inventory, sources } = await installedProblems(directory, label);
  const keep = new Set(inventory.map((item) => licenseDirectory(item.name)));
  const licenses = join(directory, LICENSES);
  if (existsSync(licenses))
    for (const item of await readdir(licenses, { withFileTypes: true }))
      if (item.isDirectory() && !keep.has(item.name))
        await rm(join(licenses, item.name), { recursive: true });
  for (const [key, source] of sources) {
    const target = join(licenses, ...key.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(
    join(directory, INVENTORY),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
}

const STAMP = ".vestra-installed";

/**
 * npm's own CLI script: npm_execpath under `npm run`, else the npm that comes
 * with this Node (next to node.exe on Windows, lib/node_modules elsewhere).
 */
function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  return candidates.find(
    (file) => file && /\.[cm]?js$/.test(file) && existsSync(file),
  );
}

function npm(args, cwd) {
  const env = { ...process.env, npm_config_ignore_scripts: "true" };
  const cli = npmCli();
  if (cli)
    return spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      stdio: "inherit",
    });
  // npm is npm.cmd on Windows, which spawn only runs through a shell; the
  // arguments are fixed strings.
  return spawnSync(`npm ${args.join(" ")}`, {
    cwd,
    env,
    stdio: "inherit",
    shell: true,
  });
}

/**
 * Checks and installs one plugin's npm dependencies: the static rules first
 * (nothing is downloaded for a refused lockfile), then `npm ci
 * --ignore-scripts` (skipped when node_modules was installed from the same
 * package.json and lockfile), then the installed rules. Returns the problems.
 */
export async function prepareDependencies(directory, label) {
  if (!(await hasDependencies(directory)))
    return dependencyProblems(directory, label);
  // The inventory is written from an install; it may be missing or stale now.
  const problems = await dependencyProblems(directory, label, {
    inventory: false,
  });
  if (problems.length) return problems;
  const stamp = createHash("sha256")
    .update(await readFile(join(directory, "package.json")))
    .update(await readFile(join(directory, "package-lock.json")))
    .digest("hex");
  const stampFile = join(directory, "node_modules", STAMP);
  const installed = existsSync(stampFile)
    ? (await readFile(stampFile, "utf8")).trim()
    : "";
  if (installed !== stamp) {
    console.log(`${label}: npm ci --ignore-scripts`);
    const result = npm(
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      directory,
    );
    if (result.status !== 0) return [`${label}: npm ci failed`];
    await writeFile(stampFile, `${stamp}\n`);
  }
  return [];
}

/** Every rule: static and installed (after `prepareDependencies`). */
export async function allDependencyProblems(directory, label) {
  const problems = await dependencyProblems(directory, label);
  if (problems.length || !(await hasDependencies(directory))) return problems;
  return (await installedProblems(directory, label)).problems;
}

/** Size problems of a package: bytes of the .vxp and of its files unpacked. */
export function sizeProblems(label, packed, unpacked) {
  const problems = [];
  const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (packed !== undefined && packed > PACKAGE_LIMIT)
    problems.push(
      `${label}: the package is ${mib(packed)}, at most ${mib(PACKAGE_LIMIT)}`,
    );
  if (unpacked !== undefined && unpacked > UNPACKED_LIMIT)
    problems.push(
      `${label}: the package unpacks to ${mib(unpacked)}, at most ${mib(UNPACKED_LIMIT)}`,
    );
  return problems;
}

/** Total size of the files under a directory. */
export async function directorySize(directory) {
  let total = 0;
  for (const item of await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  }))
    if (item.isFile())
      total += (await stat(join(item.parentPath, item.name))).size;
  return total;
}
