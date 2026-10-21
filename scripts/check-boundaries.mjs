import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname, extname, relative, sep } from "node:path";
import ts from "typescript";
// Plugins are independent: a plugin never imports another plugin's files or
// anything else outside its own directory. They reach the SDK only through
// the package's public entries: the types (`@vestra-player/sdk`) and, in
// tests, the test host. `/runtime` is the player's own and deep paths are not
// part of the package interface.
const source = resolve(import.meta.dirname, "..");
const SDK = "@vestra-player/sdk";
const PUBLIC = new Set([SDK]);
const PUBLIC_IN_TESTS = new Set([SDK, `${SDK}/testing`]);
async function files(directory) {
  const items = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      items.map(async (item) => {
        const path = resolve(directory, item.name);
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
        } else if (target === SDK || target.startsWith(`${SDK}/`)) {
          const allowed = inside(path, tests) ? PUBLIC_IN_TESTS : PUBLIC;
          if (!allowed.has(target))
            throw new Error(
              `${relative(source, path)} imports ${target}; plugins use ${[...allowed].join(" or ")}`,
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
        ts.forEachChild(node, visit);
      }
      visit(parsed);
    }
  }
}
console.log(
  "Plugin import boundaries pass (static imports; trusted runtime is not a sandbox).",
);
