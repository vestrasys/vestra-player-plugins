#!/usr/bin/env node
/**
 * The release-and-sign job's first step: check the build job's artifact (see
 * scripts/lib/release.mjs), then create a GitHub Release for each new
 * package with `gh release create`.
 *
 *   node scripts/publish-releases.mjs <artifact dir> [--repo owner/name] [--pages-url <url>]
 *                                     [--previous <url|dir>] [--releases <releases.json>]
 *                                     [--target <commit>] [--keys <dir>] [--dry-run]
 *
 * <artifact dir> holds site/ and releases/ from scripts/build-index.mjs.
 * --dry-run checks and prints the Releases it would create. --keys is the
 * directory of trusted public keys for the previous index (default keys/;
 * for local runs with a test key). `gh` needs
 * GH_TOKEN with contents: write. Runs no plugin code and needs no npm
 * packages: Node built-ins and the files in scripts/, keys/ and revoked.json.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readRevoked } from "./lib/build.mjs";
import {
  loadPrevious,
  releases,
  releasesFromFile,
  settings,
} from "./lib/publishing.mjs";
import { checkArtifact } from "./lib/release.mjs";
import { readTrustedKeys } from "./lib/signing.mjs";

const root = resolve(import.meta.dirname, "..");

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      "pages-url": { type: "string" },
      previous: { type: "string" },
      releases: { type: "string" },
      target: { type: "string" },
      keys: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "usage: node scripts/publish-releases.mjs <artifact dir> [options]",
    );
  const artifact = resolve(positionals[0]);
  const { repo, pagesUrl } = settings({
    repo: values.repo,
    pagesUrl: values["pages-url"],
  });
  const provider = values.releases
    ? await releasesFromFile(values.releases)
    : releases.github(repo, process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
  const publicKeys = (
    await readTrustedKeys(values.keys ?? join(root, "keys"))
  ).map(({ key }) => key);
  const previousSource = values.previous ?? pagesUrl;
  const previous = await loadPrevious(previousSource, publicKeys, () =>
    provider.any(),
  );
  const index = JSON.parse(
    await readFile(join(artifact, "site/index.json"), "utf8"),
  );
  const revoked = await readRevoked(join(root, "revoked.json"));

  const { problems, create } = await checkArtifact({
    artifact,
    index,
    revoked,
    previous,
    repo,
    pagesUrl,
    releases: provider,
  });
  if (problems.length)
    throw new Error(
      `the build artifact is rejected:\n  ${problems.join("\n  ")}`,
    );
  console.log(
    `artifact OK (generated ${index.generated}); previous index: ${previous ? `signed, generated ${previous.generated ?? "none"}, history and revoked unchanged` : "none (first publish)"}`,
  );

  for (const item of create) {
    const args = [
      "release",
      "create",
      item.tag,
      item.file,
      "--repo",
      repo,
      "--title",
      `${item.name} ${item.version}`,
      "--notes",
      `${item.id} ${item.version} for Vestra Player. Install it from the plugin store.`,
      ...(values.target ? ["--target", values.target] : []),
    ];
    if (values["dry-run"]) {
      console.log(
        `would run: gh ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
      );
      continue;
    }
    const result = spawnSync("gh", args, { stdio: "inherit" });
    if (result.status !== 0)
      throw new Error(`gh release create ${item.tag} failed`);
    console.log(`released ${item.tag}`);
  }
  if (!create.length) console.log("no new releases");
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
