import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { resolve, dirname, extname, relative, sep } from "node:path";
import ts from "typescript";
// Plugins are independent: a plugin never imports another plugin's files or
// anything else outside its own directory. They reach the SDK only through
// the package's public entries: the types (`@vestra-player/sdk`) and, in
// tests, the test host. `/runtime` is the player's own and deep paths are not
// part of the package interface. Any other package must be a Node built-in
// or one of the plugin's own `dependencies` (plugins/<name>/package.json),
// so that nothing from the repository's own node_modules (build tools) is
// bundled into a package. Runtime code never imports the plugin's own
// tests/ (the bundle would ship test code), and a plugin holds real files
// only: no symbolic links, submodules or committed node_modules, whose
// contents the security scan (scripts/security-scan.mjs) does not read, and
// no tsconfig/jsconfig of its own (paths, baseUrl or extends could redirect
// an import outside it; neither may the repository's tsconfig.json).
const source = resolve(import.meta.dirname, "..");
const SDK = "@vestra-player/sdk";
const PUBLIC = new Set([SDK]);
const PUBLIC_IN_TESTS = new Set([SDK, `${SDK}/testing`]);
/** tsconfig.json, tsconfig.<anything>.json, jsconfig.json. */
const COMPILER_CONFIG = /^(tsconfig(\..+)?|jsconfig)\.json$/i;
// The repository's tsconfig.json is found by esbuild for every bundled
// plugin: it must not map imports anywhere (scripts/lib/bundle.mjs checks
// the bundles themselves as well).
{
  const { compilerOptions = {}, ...config } = JSON.parse(
    await readFile(resolve(source, "tsconfig.json"), "utf8"),
  );
  for (const key of ["paths", "baseUrl", "rootDirs"])
    if (key in compilerOptions)
      throw new Error(
        `tsconfig.json: compilerOptions.${key} is not allowed (it would redirect plugin imports)`,
      );
  if ("extends" in config)
    throw new Error("tsconfig.json: extends is not allowed");
}
async function files(directory) {
  const items = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      items.map(async (item) => {
        const path = resolve(directory, item.name);
        // esbuild follows a symbolic link to whatever it points at, outside
        // the plugin and outside what the security scan reads.
        if (item.isSymbolicLink())
          throw new Error(
            `${relative(source, path)} is a symbolic link; plugins hold real files only`,
          );
        // A plugin's own compiler configuration could redirect imports
        // (paths, baseUrl, extends) to files outside it; the repository's
        // tsconfig.json applies to every plugin.
        if (item.isFile() && COMPILER_CONFIG.test(item.name))
          throw new Error(
            `${relative(source, path)}: plugins have no tsconfig or jsconfig of their own (the repository's tsconfig.json applies)`,
          );
        // Third-party and generated trees are not plugin-authored source.
        if (item.isDirectory())
          return ["node_modules", "vendor", ".typecheck", ".cache"].includes(
            item.name,
          )
            ? []
            : files(path);
        return [".ts", ".js", ".mjs"].includes(extname(path)) ? [path] : [];
      }),
    )
  ).flat();
}
function inside(path, root) {
  return path === root || path.startsWith(root + sep);
}
{
  const root = resolve(source, "plugins");
  const packages = await readdir(root, { withFileTypes: true });
  for (const item of packages.filter((item) => item.isDirectory())) {
    const own = resolve(root, item.name);
    const tests = resolve(own, "tests");
    let dependencies = {};
    try {
      dependencies =
        JSON.parse(await readFile(resolve(own, "package.json"), "utf8"))
          .dependencies ?? {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const path of await files(own)) {
      const parsed = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function check(specifier) {
        // A nonliteral import is allowed only where a reviewer marked that exact line.
        const line =
          parsed.text.split("\n")[
            parsed.getLineAndCharacterOfPosition(specifier.getStart()).line
          ];
        if (
          !ts.isStringLiteralLike(specifier) &&
          line.includes("boundary-reviewed:")
        )
          return;
        if (!ts.isStringLiteralLike(specifier))
          throw new Error(`${path}: nonliteral dynamic imports require review`);
        const target = specifier.text;
        if (target.startsWith(".") || target.startsWith("/")) {
          const resolved = resolve(dirname(path), target);
          if (!inside(resolved, own))
            throw new Error(
              `${relative(source, path)} imports outside its package: ${target}`,
            );
          // The bundle holds everything the entry imports: test code would
          // ship with the plugin.
          if (inside(resolved, tests) && !inside(path, tests))
            throw new Error(
              `${relative(source, path)} imports from the plugin's tests/: ${target}; runtime code may not use test code`,
            );
        } else if (target === SDK || target.startsWith(`${SDK}/`)) {
          const allowed = inside(path, tests) ? PUBLIC_IN_TESTS : PUBLIC;
          if (!allowed.has(target))
            throw new Error(
              `${relative(source, path)} imports ${target}; plugins use ${[...allowed].join(" or ")}`,
            );
        } else {
          const parts = target.split("/");
          const name = target.startsWith("@")
            ? parts.slice(0, 2).join("/")
            : parts[0];
          if (
            !target.startsWith("node:") &&
            !builtinModules.includes(name) &&
            !Object.hasOwn(dependencies, name)
          )
            throw new Error(
              `${relative(source, path)} imports ${target}, which is not in the plugin's own package.json dependencies`,
            );
        }
      }
      function visit(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        )
          check(node.moduleSpecifier);
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        )
          check(node.arguments[0]);
        // require("…") with a literal path follows the same rules (a
        // nonliteral one is the security scan's: vestra-dynamic-import).
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          node.arguments.length === 1 &&
          ts.isStringLiteralLike(node.arguments[0])
        )
          check(node.arguments[0]);
        ts.forEachChild(node, visit);
      }
      visit(parsed);
    }
  }
}
// What git tracks under plugins/: no symbolic links or submodules (esbuild
// would bundle what they point at, which the security scan does not read)
// and no node_modules (dependencies come from the lockfile through npm ci;
// committed ones, with a matching install stamp, would skip it and every
// dependency check). The checkout itself is checked above.
{
  const listed = spawnSync("git", ["ls-files", "-s", "-z", "--", "plugins"], {
    cwd: source,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0)
    console.log(
      "Not a git checkout: tracked symbolic links and node_modules not checked.",
    );
  else
    for (const line of listed.stdout.split("\0").filter(Boolean)) {
      const [meta, path] = line.split("\t");
      const mode = meta.split(" ")[0];
      if (mode === "120000")
        throw new Error(
          `${path} is a symbolic link; plugins hold real files only`,
        );
      if (mode === "160000")
        throw new Error(
          `${path} is a git submodule; plugins hold real files only`,
        );
      if (path.split("/").includes("node_modules"))
        throw new Error(
          `${path}: node_modules must not be committed (dependencies are installed from the lockfile)`,
        );
      if (COMPILER_CONFIG.test(path.split("/").pop()))
        throw new Error(
          `${path}: plugins have no tsconfig or jsconfig of their own (the repository's tsconfig.json applies)`,
        );
    }
}
console.log(
  "Plugin import boundaries pass (static imports; trusted runtime is not a sandbox).",
);
