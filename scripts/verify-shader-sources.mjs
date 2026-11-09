#!/usr/bin/env node
/**
 * Checks that the shaders a plugin lists in shaders/SOURCES.txt are the
 * upstream files, byte for byte (CI only: it downloads):
 *
 *   node scripts/verify-shader-sources.mjs <plugin dir>...
 *
 * The offline rules (scripts/lib/file-licenses.mjs, run by `npm run
 * registry`, the build and the package check) prove that each listed file
 * matches the SHA256 in its record. This script proves that the record's
 * SHA256 is the upstream file's: it downloads each record's upstream bytes
 * (raw.githubusercontent.com at the commit, the release asset, or the
 * gist's raw file at the revision; `upstreamUrl`) and compares. Together:
 * the shipped file is upstream's, unmodified. Only github.com and
 * gist.github.com sources are accepted; redirects are followed (release
 * assets live on GitHub's object storage).
 */
import { createHash } from "node:crypto";
import { verifyUpstream } from "./lib/file-licenses.mjs";

const directories = process.argv.slice(2);
if (!directories.length) {
  console.error(
    "usage: node scripts/verify-shader-sources.mjs <plugin dir>...",
  );
  process.exit(2);
}

async function download(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}

let failed = false;
for (const directory of directories) {
  const { checked, problems } = await verifyUpstream(directory, directory, {
    download,
  });
  for (const problem of problems) console.error(`✖ ${problem}`);
  if (problems.length) failed = true;
  else
    console.log(
      `✔ ${directory}: ${checked} listed shader(s) match their upstream files`,
    );
}
process.exit(failed ? 1 : 0);
