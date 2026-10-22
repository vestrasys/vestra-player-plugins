/**
 * The release-and-sign job's check of the build job's artifact, before it
 * creates any Release or signs anything.
 *
 * The build job runs plugin code (type checks, builds, later third-party
 * build scripts), so its artifact is untrusted. This check reads only data
 * (JSON and file hashes) and accepts the index only when:
 * - the index is well-formed and its `revoked` equals revoked.json from the
 *   checked-out commit;
 * - `revoked` keeps every entry of the previously signed index unchanged and
 *   in place (append-only), and `generated` is exactly the previous index's
 *   + 1 (1 when there is none, or it has no `generated`);
 * - every plugin's earlier versions are exactly as in the previously signed
 *   index (no rewritten or dropped history);
 * - every other version's downloadUrl is the Release URL for its id and
 *   version, and its sha256 and size match either the existing Release asset
 *   or the package in the artifact (which this job then releases);
 * - the artifact holds no package the index does not reference;
 * - every store asset URL points at a regular file in the artifact's site
 *   whose sha256 and size are the ones in the index, and the site holds
 *   nothing else (index.json and the referenced assets only).
 */
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join, relative, sep } from "node:path";
import { revokedAppendProblems } from "./revoked.mjs";
import {
  ASSETS,
  assetDigest,
  assetOf,
  downloadUrlOf,
  INDEX_NAME,
  indexProblems,
  nextGenerated,
  sha256,
  tagOf,
} from "./publishing.mjs";

/** Every file below `directory`, as `/`-separated paths relative to it. */
async function listFiles(directory) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      relative(directory, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    );
}

/**
 * Returns `{ problems, create: [{ id, version, tag, file, name }] }`; the
 * caller creates the Releases in `create` only when `problems` is empty.
 */
export async function checkArtifact({
  artifact,
  index,
  revoked,
  previous,
  repo,
  pagesUrl,
  releases,
}) {
  const problems = indexProblems(index);
  if (problems.length) return { problems, create: [] };
  const create = [];
  if (index.name !== INDEX_NAME || index.official !== true)
    problems.push(
      "index name or official flag differs from the official repository's",
    );
  if (!isDeepStrictEqual(index.revoked, revoked))
    problems.push("index revoked differs from revoked.json");
  problems.push(
    ...revokedAppendProblems(
      previous?.revoked,
      index.revoked,
      "the previously signed index",
    ),
  );
  if (index.generated !== nextGenerated(previous))
    problems.push(
      `index generated must be ${nextGenerated(previous)} (the previously signed index's + 1), not ${index.generated}`,
    );
  if (!isDeepStrictEqual(index.extensions, {}))
    problems.push("index extensions must be {}");

  const site = join(artifact, "site");
  const siteFiles = new Set(await listFiles(site));
  const deployed = new Set(["index.json"]);

  const referenced = new Set();
  for (const plugin of index.plugins) {
    for (const { name } of ASSETS) {
      const key = `${name}Url`;
      const url = plugin[key];
      if (url === null) continue;
      const prefix = `${pagesUrl}assets/${plugin.id}/`;
      const path = url.slice(pagesUrl.length);
      if (
        !url.startsWith(prefix) ||
        path.split("/").some((part) => [".", "..", ""].includes(part)) ||
        /[?#%\\]/.test(path)
      ) {
        problems.push(`${plugin.id}: ${key} must be under ${prefix}`);
        continue;
      }
      if (!siteFiles.has(path)) {
        problems.push(
          `${plugin.id}: ${key} names a file missing from the site`,
        );
        continue;
      }
      deployed.add(path);
      const file = join(site, path);
      if (!(await lstat(file)).isFile()) {
        problems.push(`site/${path}: not a regular file`);
        continue;
      }
      const bytes = await readFile(file);
      if (
        sha256(bytes) !== plugin[`${name}Sha256`] ||
        bytes.length !== plugin[`${name}Size`]
      )
        problems.push(
          `${plugin.id}: site/${path} does not match ${name}Sha256/${name}Size`,
        );
    }
    const earlier = previous?.plugins.find((item) => item.id === plugin.id);
    for (const old of earlier?.versions ?? []) {
      const now = plugin.versions.find(
        (entry) => entry.version === old.version,
      );
      if (!now)
        problems.push(
          `${plugin.id} ${old.version}: dropped from the version history`,
        );
      else if (!isDeepStrictEqual(now, old))
        problems.push(
          `${plugin.id} ${old.version}: differs from the signed index`,
        );
    }
    for (const entry of plugin.versions) {
      if (earlier?.versions.some((old) => old.version === entry.version))
        continue;
      const { version } = entry;
      const where = `${plugin.id} ${version}`;
      const tag = tagOf(plugin.id, version);
      const name = assetOf(plugin.id, version);
      if (entry.downloadUrl !== downloadUrlOf(repo, plugin.id, version)) {
        problems.push(
          `${where}: downloadUrl must be ${downloadUrlOf(repo, plugin.id, version)}`,
        );
        continue;
      }
      const release = await releases.release(tag, name);
      if (release) {
        if (!release.asset) {
          problems.push(`${where}: release ${tag} has no ${name}`);
          continue;
        }
        const digest = await assetDigest(release.asset);
        if (digest.sha256 !== entry.sha256 || digest.size !== entry.size)
          problems.push(
            `${where}: the index does not match the released ${name}`,
          );
        continue;
      }
      const file = join(artifact, "releases", name);
      referenced.add(name);
      if (!existsSync(file)) {
        problems.push(`${where}: not released and releases/${name} is missing`);
        continue;
      }
      const bytes = await readFile(file);
      if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.size)
        problems.push(
          `${where}: releases/${name} does not match the index sha256/size`,
        );
      else
        create.push({ id: plugin.id, version, tag, file, name: plugin.name });
    }
  }
  const packages = existsSync(join(artifact, "releases"))
    ? await readdir(join(artifact, "releases"))
    : [];
  for (const name of packages)
    if (!referenced.has(name))
      problems.push(`releases/${name}: not referenced by the index`);
  for (const path of siteFiles)
    if (!deployed.has(path))
      problems.push(
        `site/${path}: unexpected file in the Pages site (not referenced by the index)`,
      );
  return { problems, create };
}
