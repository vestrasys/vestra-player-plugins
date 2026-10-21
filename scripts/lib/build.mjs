/**
 * Builds the unsigned index.json and its Pages assets (the build job; see
 * scripts/build-index.mjs for the command line).
 *
 * For every official plugin in plugins/ (id `vestra.<name>`), the version in
 * its manifest is:
 * - kept as published when the previous index already lists it;
 * - recovered from its GitHub Release when the release exists but the index
 *   does not list it (an earlier run released it and then failed to sign);
 * - otherwise packed with `vestra-plugin pack` into <out>/releases/ for the
 *   release-and-sign job to release.
 * A released version is never rebuilt. Earlier versions come from the
 * previous index, so the history survives each Pages deployment.
 *
 * Output:
 *   <out>/site/index.json                         unsigned
 *   <out>/site/assets/<id>/<version>/...          README.md, CHANGELOG.md, icon.<ext>
 *   <out>/releases/<id>-<version>.vxp             new versions only
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { plugins as pluginNames } from "../plugins.mjs";
import {
  assetDigest,
  assetOf,
  downloadUrlOf,
  INDEX_NAME,
  INDEX_SCHEMA,
  indexProblems,
  sha256,
  tagOf,
} from "./publishing.mjs";
import { OFFICIAL_PREFIX, readRegistry } from "./registry.mjs";
import { revokedProblems } from "./revoked.mjs";
import { compareVersions, isVersion } from "./semver.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

/** Packs one plugin directory with the SDK CLI; returns the .vxp path. */
export async function packWithSdk(directory, id, version, outDirectory) {
  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "scripts/plugin.mjs"),
      "pack",
      directory,
      "--out",
      outDirectory,
    ],
    { stdio: ["ignore", "inherit", "inherit"], cwd: repositoryRoot },
  );
  if (result.status !== 0)
    throw new Error(`${directory}: vestra-plugin pack failed`);
  const file = join(outDirectory, assetOf(id, version));
  if (!existsSync(file))
    throw new Error(`${directory}: pack did not write ${assetOf(id, version)}`);
  return file;
}

/** revoked.json, validated; an absent file is an empty list. */
export async function readRevoked(file) {
  let list;
  try {
    list = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`${file}: ${error.message}`);
  }
  const problems = revokedProblems(list);
  if (problems.length) throw new Error(problems.join("\n"));
  return list;
}

function safeRelative(path) {
  return (
    typeof path === "string" &&
    path &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === ".." || part === "")
  );
}

/** The package files shown in the store: [manifest field, file in the plugin, published name]. */
function displayFiles(directory, manifest) {
  const files = [];
  const pick = (field, fallback, published) => {
    const path =
      manifest[field] ??
      (existsSync(join(directory, fallback)) ? fallback : null);
    if (path === null) return;
    if (!safeRelative(path))
      throw new Error(
        `${directory}: ${field} is not a relative path inside the plugin`,
      );
    files.push([field, path, published(path)]);
  };
  pick("readme", "README.md", () => "README.md");
  pick("changelog", "CHANGELOG.md", () => "CHANGELOG.md");
  if (manifest.icon !== undefined)
    pick("icon", null, (path) => `icon${extname(path).toLowerCase()}`);
  return files;
}

/**
 * Builds the index. Options:
 *   root          repository root (plugins/, registry/, revoked.json)
 *   out           output directory (created; must not hold an earlier build)
 *   repo          owner/name, for Release URLs
 *   pagesUrl      Pages base URL with a trailing slash
 *   previous      the previously published index (or null: first publish)
 *   releases      a provider from publishing.mjs `releases`
 *   now           ISO date for new versions' `published`
 *   pack          (directory, id, version, outDirectory) → .vxp path
 *   log           progress lines
 * Returns { index, packed: [{ id, version, file }] }.
 */
export async function buildIndex({
  root = repositoryRoot,
  out,
  repo,
  pagesUrl,
  previous = null,
  releases,
  now = new Date().toISOString(),
  pack = packWithSdk,
  log = console.log,
}) {
  const revoked = await readRevoked(join(root, "revoked.json"));
  const registry = await readRegistry(join(root, "registry"));
  if (registry.problems.length) throw new Error(registry.problems.join("\n"));
  if (registry.entries.length)
    // Third-party plugins are built from their registered source in this job
    // (no secrets), each in isolation; not implemented yet (CONTRIBUTING.md).
    throw new Error(
      `third-party builds are not implemented yet; cannot publish ${registry.entries.map((entry) => entry.id).join(", ")}`,
    );

  const site = join(out, "site");
  const releasesDirectory = join(out, "releases");
  await mkdir(site, { recursive: true });
  await mkdir(releasesDirectory, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), "vestra-index-"));

  const plugins = [];
  const packed = [];
  const ids = new Set(registry.entries.map((entry) => entry.id.toLowerCase()));
  try {
    for (const name of await pluginNames(join(root, "plugins"))) {
      const directory = join(root, "plugins", name);
      const manifest = JSON.parse(
        await readFile(join(directory, "manifest.json"), "utf8"),
      );
      const { id, version } = manifest;
      if (
        typeof id !== "string" ||
        !id.startsWith(OFFICIAL_PREFIX) ||
        id.length === OFFICIAL_PREFIX.length
      )
        throw new Error(
          `plugins/${name}: an official plugin's id must be ${OFFICIAL_PREFIX}<name>, not ${JSON.stringify(id)}`,
        );
      if (!isVersion(version))
        throw new Error(`plugins/${name}: version must be MAJOR.MINOR.PATCH`);
      if (ids.has(id.toLowerCase()))
        throw new Error(`plugins/${name}: id ${id} is used twice`);
      ids.add(id.toLowerCase());

      const earlier = previous?.plugins.find((plugin) => plugin.id === id);
      const versions = (earlier?.versions ?? []).map((entry) => ({ ...entry }));
      if (versions.some((entry) => entry.version === version)) {
        log(`${id} ${version}: published, kept`);
      } else {
        const tag = tagOf(id, version);
        const asset = assetOf(id, version);
        const release = await releases.release(tag, asset);
        let entry;
        if (release) {
          if (!release.asset)
            throw new Error(`release ${tag} exists but has no ${asset}`);
          const { sha256: digest, size } = await assetDigest(release.asset);
          log(
            `${id} ${version}: released as ${tag} but not in the index, recovered`,
          );
          entry = { sha256: digest, size, published: release.published };
        } else {
          const file = await pack(directory, id, version, scratch);
          const bytes = await readFile(file);
          await copyFile(file, join(releasesDirectory, asset));
          packed.push({ id, version, file: join(releasesDirectory, asset) });
          log(`${id} ${version}: packed ${asset} (${bytes.length} bytes)`);
          entry = { sha256: sha256(bytes), size: bytes.length, published: now };
        }
        versions.push({
          version,
          apiVersion: manifest.apiVersion,
          minPlayerVersion: manifest.minPlayerVersion ?? null,
          capabilities: [...(manifest.capabilities ?? [])],
          downloadUrl: downloadUrlOf(repo, id, version),
          sha256: entry.sha256,
          size: entry.size,
          published: entry.published,
        });
      }
      versions.sort((a, b) => compareVersions(b.version, a.version));

      // Display fields and assets follow the newest version in the repository.
      const urls = { iconUrl: null, readmeUrl: null, changelogUrl: null };
      for (const [field, path, published] of displayFiles(
        directory,
        manifest,
      )) {
        const target = join(site, "assets", id, version);
        await mkdir(target, { recursive: true });
        await copyFile(join(directory, path), join(target, published));
        urls[`${field}Url`] = new URL(
          `assets/${id}/${version}/${published}`,
          pagesUrl,
        ).href;
      }
      plugins.push({
        id,
        name: manifest.name ?? id,
        author: manifest.author ?? null,
        punchline: manifest.punchline ?? null,
        description: manifest.description ?? null,
        tags: [...(manifest.tags ?? [])],
        license: manifest.license ?? null,
        ...urls,
        sourceUrl:
          manifest.sourceUrl ??
          `https://github.com/${repo}/tree/main/plugins/${name}`,
        versions,
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  for (const plugin of previous?.plugins ?? [])
    if (!plugins.some((item) => item.id === plugin.id))
      log(`${plugin.id}: no longer in the repository, dropped from the index`);

  plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = {
    schema: INDEX_SCHEMA,
    name: INDEX_NAME,
    official: true,
    plugins,
    revoked,
    extensions: {},
  };
  const problems = indexProblems(index);
  if (problems.length)
    throw new Error(`generated index is invalid:\n  ${problems.join("\n  ")}`);
  return { index, packed };
}
