#!/usr/bin/env node
/**
 * Portability scan of the plugins (workflow §1.5 in the player repository):
 * string literals in plugins/ (without tests, dist, vendor, node_modules)
 * that name system command paths or macOS-only commands, and
 * `process.platform` branches. Plugins must not call system commands; ask the
 * player for a cross-platform capability or use plain Node instead.
 *
 *   npm run portability
 *
 * Exit status 0 only when no system command was found; `process.platform`
 * branches are listed for review, not failures. The player repository runs
 * the same scan over its runtime and the installed SDK package.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const source = resolve(import.meta.dirname, "..");
let failed = false;

// ---------------------------------------------------------------- scan

const SKIP = new Set([
  "tests",
  "dist",
  "vendor",
  "node_modules",
  ".typecheck",
  ".cache",
]);
const CODE = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
/** Absolute locations of system programs and macOS-only directories. */
const PATHS =
  /(^|[\s"'`=:])(\/usr\/(s?bin|local|libexec)\/|\/s?bin\/|\/opt\/homebrew|\/opt\/local\/|\/System\/|\/Library\/|\/Applications\/|~\/Library|Library\/Application Support)/;
/** Programs that exist only on macOS (or are named differently elsewhere). */
const MACOS = new Set([
  "open",
  "sips",
  "plutil",
  "sw_vers",
  "sysctl",
  "system_profiler",
  "security",
  "osascript",
  "pbcopy",
  "pbpaste",
  "caffeinate",
  "defaults",
  "mdls",
  "mdfind",
  "launchctl",
  "diskutil",
  "pmset",
  "afplay",
  "say",
  "xattr",
  "codesign",
  "hdiutil",
  "ditto",
  "screencapture",
  "textutil",
  "qlmanage",
  "scutil",
]);
const SPAWNERS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);

async function files(directory) {
  const out = [];
  let items;
  try {
    items = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const item of items) {
    const path = join(directory, item.name);
    if (item.isDirectory()) {
      if (!SKIP.has(item.name)) out.push(...(await files(path)));
    } else if (
      CODE.has(extname(item.name)) &&
      !/\.test\.[mc]?[jt]s$/.test(item.name)
    )
      out.push(path);
  }
  return out;
}

function scanFile(path, text) {
  const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const findings = [];
  const at = (node) =>
    parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const callee = (call) => {
    const expression = call.expression;
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return "";
  };
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) {
      const value = node.text;
      if (PATHS.test(value))
        findings.push({ kind: "command", line: at(node), text: value });
      else if (
        ts.isCallExpression(node.parent) &&
        SPAWNERS.has(callee(node.parent)) &&
        node.parent.arguments[0] === node &&
        MACOS.has(value.split(/\s+/)[0])
      )
        findings.push({ kind: "command", line: at(node), text: value });
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "platform" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process"
    )
      findings.push({
        kind: "platform",
        line: at(node),
        text: node.parent.getText(parsed).slice(0, 80),
      });
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return findings;
}

async function scan() {
  console.log("== Scan: system commands in plugins/");
  let commands = 0;
  let branches = 0;
  for (const path of (await files(join(source, "plugins"))).sort()) {
    for (const finding of scanFile(path, await readFile(path, "utf8"))) {
      const where = `${relative(source, path)}:${finding.line}`;
      if (finding.kind === "command") {
        commands++;
        console.log(`  COMMAND  ${where}: ${JSON.stringify(finding.text)}`);
      } else {
        branches++;
        console.log(`  PLATFORM ${where}: ${finding.text}`);
      }
    }
  }
  console.log(
    `${commands} system command reference(s); ${branches} process.platform branch(es) (review, not failures).`,
  );
  if (commands) failed = true;
}

await scan();
console.log(failed ? "\nportability: problems found" : "\nportability: clean");
process.exit(failed ? 1 : 0);
