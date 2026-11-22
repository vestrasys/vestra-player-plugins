#!/usr/bin/env node
/**
 * Builds the unsigned index.json, its Pages assets and the packages of the
 * versions that are not released yet (the CI build job; no secrets).
 *
 *   node scripts/build-index.mjs --out <dir> [--repo owner/name] [--pages-url <url>]
 *                                [--previous <url|dir>] [--releases <releases.json>]
 *                                [--keys <dir>]
 *   node scripts/build-index.mjs --dry-run [--out <dir>] [...]
 *
 * --repo       default GITHUB_REPOSITORY, else package.json's repository
 * --pages-url  default https://<owner>.github.io/<name>/
 * --previous   where the published index.json and index.json.sig are; default
 *              the Pages URL. Its signature is checked with the trusted keys.
 * --keys       the directory of trusted public keys (every *.pub.pem); default
 *              keys/. For local runs with a test key; CI uses the default.
 * --releases   answer "is this tag released?" from the file that
 *              scripts/query-releases.mjs writes, instead of asking the GitHub
 *              API (which uses GH_TOKEN or GITHUB_TOKEN when set). CI uses
 *              the file, so this step, which runs plugin builds, has no token.
 * --dry-run    no network: no previous index unless --previous names a
 *              directory, no releases unless --releases is given; --out
 *              defaults to a new temporary directory. Prints the index.
 *
 * Layout and rules: scripts/lib/build.mjs and scripts/lib/publishing.mjs.
 */
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildIndex } from "./lib/build.mjs";
import {
  loadPrevious,
  releases,
  releasesFromFile,
  serializeIndex,
  settings,
} from "./lib/publishing.mjs";
import { readTrustedKeys } from "./lib/signing.mjs";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    repo: { type: "string" },
    "pages-url": { type: "string" },
    previous: { type: "string" },
    releases: { type: "string" },
    keys: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const dryRun = values["dry-run"];

try {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const fromPackage = /github\.com\/([^/]+\/[^/.]+)/.exec(
    packageJson.repository?.url ?? "",
  )?.[1];
  const { repo, pagesUrl } = settings({
    repo: values.repo ?? process.env.GITHUB_REPOSITORY ?? fromPackage,
    pagesUrl: values["pages-url"],
  });
  if (!values.out && !dryRun) throw new Error("--out <dir> is required");
  const out = resolve(
    values.out ?? (await mkdtemp(join(tmpdir(), "vestra-index-dry-run-"))),
  );
  try {
    if ((await readdir(out)).length) throw new Error(`${out} is not empty`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const provider = values.releases
    ? await releasesFromFile(values.releases)
    : dryRun
      ? releases.fixture({})
      : releases.github(repo, process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
  const previousSource = values.previous ?? (dryRun ? null : pagesUrl);
  if (dryRun && previousSource?.startsWith("https://"))
    throw new Error("--dry-run reads --previous only from a local directory");
  const publicKeys = (
    await readTrustedKeys(values.keys ?? join(root, "keys"))
  ).map(({ key }) => key);
  const previous = previousSource
    ? await loadPrevious(previousSource, publicKeys, () => provider.any())
    : null;
  console.log(
    previous
      ? `previous index: ${previousSource} (signature OK)`
      : "previous index: none (first publish)",
  );

  const { index, packed } = await buildIndex({
    root,
    out,
    repo,
    pagesUrl,
    previous,
    releases: provider,
  });
  await writeFile(join(out, "site/index.json"), serializeIndex(index));
  console.log(
    `wrote ${join(out, "site/index.json")} (generated ${index.generated}); ${packed.length} new package(s) in ${join(out, "releases")}`,
  );
  if (dryRun) process.stdout.write(serializeIndex(index));
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
