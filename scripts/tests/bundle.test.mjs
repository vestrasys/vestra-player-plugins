import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { bundleProblems } from "../lib/bundle.mjs";

// scripts/lib/bundle.mjs on fixtures: a plugin whose tsconfig.json `paths`
// maps a package-looking import to a file outside the plugin, and one that
// bundles only its own files. Neither has a dist/ (no SDK build here), so
// both also report that the output differs from the shipped file; the
// comparison itself is exercised by every `npm run build`.
const fixtures = resolve(import.meta.dirname, "fixtures/bundle");
const outside = (problems) =>
  problems.filter((p) => /outside the plugin/.test(p));

test("a tsconfig paths import from outside the plugin is refused", async () => {
  const problems = await bundleProblems(
    fixtures,
    join(fixtures, "plugins/bad"),
    "bad",
  );
  assert.deepEqual(outside(problems), [
    "bad: the bundle includes outside/evil.ts, outside the plugin and its locked dependencies (tsconfig paths, baseUrl or extends, a symbolic link, or an unlocked package?)",
  ]);
});

test("a plugin that bundles only its own files passes the input check", async () => {
  const problems = await bundleProblems(
    fixtures,
    join(fixtures, "plugins/good"),
    "good",
  );
  assert.deepEqual(outside(problems), []);
  assert.match(
    problems.join("\n"),
    /differs from plugins\/good\/dist\/main\.js/,
  );
});
