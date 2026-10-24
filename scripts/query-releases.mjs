#!/usr/bin/env node
/**
 * Records which versions of the plugins in plugins/ are already released, for
 * build-index.mjs --releases. CI runs it before `npm ci`, so the token it
 * uses is never in the environment of a step that runs plugin code.
 *
 *   node scripts/query-releases.mjs <out file> [--repo owner/name]
 *
 * Writes { "any": <the repository has any release>, "tags": { "<id>-v<version>":
 * { "published", "size", "sha256" } } } for the current version of every
 * plugin in plugins/ that has a release. Uses GH_TOKEN or GITHUB_TOKEN when
 * set. Reads manifest.json files only (no plugin code).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assetDigest,
  assetOf,
  releases,
  settings,
  tagOf,
} from "./lib/publishing.mjs";
import { plugins } from "./plugins.mjs";

const root = resolve(import.meta.dirname, "..");

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { repo: { type: "string" } },
  });
  if (positionals.length !== 1)
    throw new Error(
      "usage: node scripts/query-releases.mjs <out file> [--repo owner/name]",
    );
  const { repo } = settings({ repo: values.repo });
  const github = releases.github(
    repo,
    process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  );
  const tags = {};
  for (const name of await plugins(join(root, "plugins"))) {
    const { id, version } = JSON.parse(
      await readFile(join(root, "plugins", name, "manifest.json"), "utf8"),
    );
    const tag = tagOf(id, version);
    const release = await github.release(tag, assetOf(id, version));
    if (!release) {
      console.log(`${tag}: not released`);
      continue;
    }
    if (!release.asset)
      throw new Error(`release ${tag} has no ${assetOf(id, version)}`);
    tags[tag] = {
      published: release.published,
      ...(await assetDigest(release.asset)),
    };
    console.log(`${tag}: released ${release.published}`);
  }
  await writeFile(
    positionals[0],
    `${JSON.stringify({ any: await github.any(), tags }, null, 2)}\n`,
  );
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
