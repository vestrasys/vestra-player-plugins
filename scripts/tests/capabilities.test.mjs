import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildIndex } from "../lib/build.mjs";
import {
  builtinOnlyCapabilities,
  builtinOnlyProblems,
} from "../lib/capabilities.mjs";
import { releases } from "../lib/publishing.mjs";

const fixture = join(import.meta.dirname, "fixtures/builtin-only");

test("the builtin-only list comes from the SDK", async () => {
  const builtinOnly = await builtinOnlyCapabilities();
  assert.ok(builtinOnly.has("commands.run"));
  assert.ok(builtinOnly.has("palette.lead"));
  assert.ok(!builtinOnly.has("commands"));
});

test("a manifest with builtin-only capabilities is refused, naming each", async () => {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const builtinOnly = await builtinOnlyCapabilities();
  assert.deepEqual(
    builtinOnlyProblems(
      manifest,
      "plugins/launcher/manifest.json",
      builtinOnly,
    ),
    [
      `plugins/launcher/manifest.json: capability "commands.run" is for the player's built-in plugins only; a third-party plugin cannot declare it`,
      `plugins/launcher/manifest.json: capability "palette.lead" is for the player's built-in plugins only; a third-party plugin cannot declare it`,
    ],
  );
  assert.deepEqual(
    builtinOnlyProblems({ capabilities: ["commands"] }, "x", builtinOnly),
    [],
  );
  assert.deepEqual(builtinOnlyProblems({}, "x", builtinOnly), []);
});

test("the index build refuses a plugin with builtin-only capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "vestra-builtin-only-"));
  try {
    await cp(fixture, join(root, "plugins/launcher"), { recursive: true });
    await writeFile(
      join(root, "plugins/owners.toml"),
      'launcher = "someone"\n',
    );
    await writeFile(join(root, "revoked.json"), "[]");
    await mkdir(join(root, "registry"));
    let packed = false;
    await assert.rejects(
      buildIndex({
        root,
        out: join(root, "out"),
        repo: "vestrasys/vestra-player-plugins",
        pagesUrl: "https://vestrasys.github.io/vestra-player-plugins/",
        releases: releases.fixture({}),
        pack: async () => {
          packed = true;
          throw new Error("must not pack");
        },
        log: () => {},
      }),
      /plugins\/launcher\/manifest\.json: capability "commands\.run" is for the player's built-in plugins only[^]*capability "palette\.lead"/,
    );
    assert.equal(packed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
