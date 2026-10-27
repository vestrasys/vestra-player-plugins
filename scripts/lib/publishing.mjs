/**
 * What the build job and the release-and-sign job share: where things are
 * published, the shape of index.json, the previously published (signed)
 * index and the GitHub Releases lookups.
 *
 * Published layout (a public repository is assumed: Releases downloads and
 * GitHub Pages of a private repository need authentication or a paid plan):
 *
 *   Release  <id>-v<version>   asset <id>-<version>.vxp
 *            https://github.com/<repo>/releases/download/<id>-v<version>/<id>-<version>.vxp
 *   Pages    <pages>/index.json, <pages>/index.json.sig
 *            <pages>/assets/<id>/<version>/README.md | CHANGELOG.md | icon.<png|jpg|jpeg>
 *
 * index.json (CONTRIBUTING.md, "index.json"): `generated` is a sequence number,
 * the previous signed index's + 1 on every publish (1 for the first, and
 * when the previous index has none); each store asset carries its sha256 and
 * size; a plugin's optional `translations` holds its display fields in
 * the languages its package translates them to; everything is covered by
 * the signature.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { idProblems } from "./registry.mjs";
import { revokedProblems } from "./revoked.mjs";
import { isVersion } from "./semver.mjs";
import { verifyIndex } from "./signing.mjs";

export const INDEX_SCHEMA = 1;
export const INDEX_NAME = "Vestra Player official repository";

export const tagOf = (id, version) => `${id}-v${version}`;
export const assetOf = (id, version) => `${id}-${version}.vxp`;
export const downloadUrlOf = (repo, id, version) =>
  `https://github.com/${repo}/releases/download/${tagOf(id, version)}/${assetOf(id, version)}`;

/** `owner/name` and the Pages base URL (with a trailing slash). */
export function settings({ repo, pagesUrl } = {}) {
  const repository = repo ?? process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository))
    throw new Error("--repo owner/name is required (or GITHUB_REPOSITORY)");
  const [owner, name] = repository.split("/");
  let base = pagesUrl ?? `https://${owner.toLowerCase()}.github.io/${name}/`;
  if (!base.endsWith("/")) base += "/";
  if (new URL(base).protocol !== "https:")
    throw new Error("the Pages URL must be https:");
  return { repo: repository, pagesUrl: base };
}

/**
 * `generated` of the index that follows `previous` (null: first publish).
 * An index from before `generated` existed counts as 0.
 */
export const nextGenerated = (previous) => (previous?.generated ?? 0) + 1;

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------- index shape

/**
 * The store assets of a plugin, published next to the index (newest version
 * only). Each has `<name>Url`, `<name>Sha256` and `<name>Size` in the plugin
 * entry: all three null when the plugin has no such file. `limit` is what
 * the store reads at most (store-design §3.2), so a bigger file fails the
 * build instead of failing in every store.
 */
export const ASSETS = [
  { name: "icon", limit: 512 * 1024 },
  { name: "readme", limit: 256 * 1024 },
  { name: "changelog", limit: 256 * 1024 },
];
const ASSET_KEYS = ASSETS.flatMap(({ name }) => [
  `${name}Url`,
  `${name}Sha256`,
  `${name}Size`,
]);

const PLUGIN_KEYS = [
  "id",
  "name",
  "author",
  "punchline",
  "description",
  "tags",
  "license",
  ...ASSET_KEYS,
  "sourceUrl",
  "translations",
  "versions",
];

/**
 * The display fields a plugin entry's optional `translations` carries per
 * language: `{ "<lang>": { name?, punchline?, description?, tags? } }`,
 * read from the compiled catalogs of the newest version's package
 * (dist/locales/<lang>.json; scripts/lib/build.mjs). A field is there only
 * when that catalog translates it, a language only when it translates one
 * of them, and `translations` only when some language does. `tags` holds
 * one entry per tag of the plugin, in order, an untranslated tag in English
 * (as the player shows it). English is the entry's own fields, never a key.
 */
export const TRANSLATED_FIELDS = ["name", "punchline", "description", "tags"];
/** A translation language: a player locale tag (`zh-Hans`, `de`), not `en`. */
export const LANGUAGE = /^(?!en$)[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const VERSION_KEYS = [
  "version",
  "apiVersion",
  "minPlayerVersion",
  "capabilities",
  "downloadUrl",
  "sha256",
  "size",
  "published",
];
const TOP_KEYS = [
  "schema",
  "generated",
  "name",
  "official",
  "plugins",
  "revoked",
  "extensions",
];

const https = (value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};
const optionalString = (value) => value === null || typeof value === "string";

const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Problems with a plugin entry's optional `translations`. */
function translationProblems(plugin, at) {
  const { translations } = plugin;
  if (translations === undefined) return [];
  const where = `${at}.translations`;
  if (!isObject(translations)) return [`${where} must be an object`];
  if (!Object.keys(translations).length)
    return [`${where} must not be empty (leave it out instead)`];
  const problems = [];
  for (const [language, fields] of Object.entries(translations)) {
    const here = `${where}["${language}"]`;
    if (!LANGUAGE.test(language))
      problems.push(`${where}: "${language}" is not a translation language`);
    if (!isObject(fields)) {
      problems.push(`${here} must be an object`);
      continue;
    }
    if (!Object.keys(fields).length)
      problems.push(`${here} must not be empty (leave the language out)`);
    for (const key of Object.keys(fields))
      if (!TRANSLATED_FIELDS.includes(key))
        problems.push(`${here}: unknown key "${key}"`);
    for (const key of ["name", "punchline", "description"]) {
      if (fields[key] === undefined) continue;
      if (typeof fields[key] !== "string" || !fields[key])
        problems.push(`${here}: ${key} must be a non-empty string`);
      else if (typeof plugin[key] !== "string")
        problems.push(`${here}: ${key} translates a field the plugin lacks`);
    }
    if (fields.tags === undefined) continue;
    if (
      !Array.isArray(fields.tags) ||
      fields.tags.some((tag) => typeof tag !== "string" || !tag)
    )
      problems.push(`${here}: tags must be an array of non-empty strings`);
    else if (
      !Array.isArray(plugin.tags) ||
      !plugin.tags.length ||
      fields.tags.length !== plugin.tags.length
    )
      problems.push(`${here}: tags must have one entry per tag of the plugin`);
  }
  return problems;
}

/**
 * Structural problems with an index object (empty: valid).
 *
 * `legacy: true` accepts an index written before `generated` and the asset
 * hashes existed (only for reading the previously published index); when
 * present they are still checked. Everything this repository writes and
 * signs has them.
 */
export function indexProblems(index, { legacy = false } = {}) {
  const problems = [];
  if (!index || typeof index !== "object" || Array.isArray(index))
    return ["index must be an object"];
  const keys = (object, allowed, at) => {
    for (const key of Object.keys(object))
      if (!allowed.includes(key)) problems.push(`${at}: unknown key "${key}"`);
  };
  keys(index, TOP_KEYS, "index");
  if (index.schema !== INDEX_SCHEMA)
    problems.push(`schema must be ${INDEX_SCHEMA}`);
  if (
    !(legacy && index.generated === undefined) &&
    (!Number.isSafeInteger(index.generated) || index.generated < 1)
  )
    problems.push("generated must be a positive integer");
  if (typeof index.name !== "string" || !index.name)
    problems.push("name must be a string");
  if (typeof index.official !== "boolean")
    problems.push("official must be a boolean");
  if (
    !index.extensions ||
    typeof index.extensions !== "object" ||
    Array.isArray(index.extensions)
  )
    problems.push("extensions must be an object");
  problems.push(
    ...revokedProblems(index.revoked).map((p) =>
      p.replace(/^revoked\.json/, "revoked"),
    ),
  );
  if (!Array.isArray(index.plugins))
    return [...problems, "plugins must be an array"];
  const ids = new Set();
  index.plugins.forEach((plugin, i) => {
    const at = `plugins[${i}]`;
    if (!plugin || typeof plugin !== "object")
      return problems.push(`${at} must be an object`);
    keys(plugin, PLUGIN_KEYS, at);
    problems.push(...idProblems(plugin.id).map((p) => `${at}: ${p}`));
    if (ids.has(String(plugin.id).toLowerCase()))
      problems.push(`${at}: duplicate id ${plugin.id}`);
    ids.add(String(plugin.id).toLowerCase());
    if (typeof plugin.name !== "string" || !plugin.name)
      problems.push(`${at}: name must be a string`);
    for (const key of ["author", "punchline", "description", "license"])
      if (!optionalString(plugin[key]))
        problems.push(`${at}: ${key} must be a string or null`);
    if (
      !Array.isArray(plugin.tags) ||
      plugin.tags.some((tag) => typeof tag !== "string")
    )
      problems.push(`${at}: tags must be an array of strings`);
    problems.push(...translationProblems(plugin, at));
    for (const key of ["iconUrl", "readmeUrl", "changelogUrl", "sourceUrl"])
      if (plugin[key] !== null && !https(plugin[key]))
        problems.push(`${at}: ${key} must be an https: URL or null`);
    for (const { name, limit } of ASSETS) {
      const url = plugin[`${name}Url`];
      const hash = plugin[`${name}Sha256`];
      const size = plugin[`${name}Size`];
      if (legacy && hash === undefined && size === undefined) continue;
      if (url === null || url === undefined) {
        if (hash !== null || size !== null)
          problems.push(
            `${at}: ${name}Sha256 and ${name}Size must be null without ${name}Url`,
          );
        continue;
      }
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
        problems.push(`${at}: ${name}Sha256 must be 64 lowercase hex digits`);
      if (!Number.isSafeInteger(size) || size < 0 || size > limit)
        problems.push(`${at}: ${name}Size must be an integer 0–${limit}`);
    }
    if (!Array.isArray(plugin.versions) || !plugin.versions.length)
      return problems.push(`${at}: versions must be a non-empty array`);
    const seen = new Set();
    plugin.versions.forEach((entry, j) => {
      const where = `${at}.versions[${j}]`;
      if (!entry || typeof entry !== "object")
        return problems.push(`${where} must be an object`);
      keys(entry, VERSION_KEYS, where);
      if (!isVersion(entry.version))
        problems.push(`${where}: version must be MAJOR.MINOR.PATCH`);
      if (seen.has(entry.version))
        problems.push(`${where}: duplicate version ${entry.version}`);
      seen.add(entry.version);
      if (typeof entry.apiVersion !== "string" || !entry.apiVersion)
        problems.push(`${where}: apiVersion must be a string`);
      if (entry.minPlayerVersion !== null && !isVersion(entry.minPlayerVersion))
        problems.push(
          `${where}: minPlayerVersion must be MAJOR.MINOR.PATCH or null`,
        );
      if (
        !Array.isArray(entry.capabilities) ||
        entry.capabilities.some((c) => typeof c !== "string")
      )
        problems.push(`${where}: capabilities must be an array of strings`);
      if (!https(entry.downloadUrl))
        problems.push(`${where}: downloadUrl must be an https: URL`);
      if (
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)
      )
        problems.push(`${where}: sha256 must be 64 lowercase hex digits`);
      if (!Number.isSafeInteger(entry.size) || entry.size <= 0)
        problems.push(`${where}: size must be a positive integer`);
      if (
        typeof entry.published !== "string" ||
        Number.isNaN(Date.parse(entry.published))
      )
        problems.push(`${where}: published must be an ISO 8601 date`);
    });
  });
  return problems;
}

/** The bytes written to index.json: two-space JSON and a final newline. */
export const serializeIndex = (index) =>
  Buffer.from(`${JSON.stringify(index, null, 2)}\n`);

// ---------------------------------------------------------------- remote reads

async function get(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: "follow" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Reads `name` from a directory path or below a base URL; null when missing. */
async function readFrom(source, name) {
  if (/^https:\/\//.test(source)) {
    const base = source.endsWith("/") ? source : `${source}/`;
    return get(new URL(name, base).href, { "Cache-Control": "no-cache" });
  }
  try {
    return await readFile(join(source, name));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The index published before this run, read from `source` (the Pages base
 * URL or a local directory) and checked against the trusted public keys
 * (`publicKeys`: one key or an array; any signature by any of them is
 * enough). An index from before `generated` and the asset hashes is
 * accepted (`indexProblems` legacy mode).
 * Returns null only when there is no index.json yet *and* nothing has been
 * released (`anyRelease()` is false): the first publish. A missing index
 * after releases exist, a missing or bad signature, or an invalid index is an
 * error, so a broken Pages site never silently drops the version history.
 */
export async function loadPrevious(source, publicKeys, anyRelease) {
  const bytes = await readFrom(source, "index.json");
  if (!bytes) {
    if (await anyRelease())
      throw new Error(
        `${source}: no index.json, but plugin releases exist; refusing to rebuild the history from scratch`,
      );
    return null;
  }
  const signature = await readFrom(source, "index.json.sig");
  if (!signature)
    throw new Error(`${source}: index.json has no index.json.sig`);
  if (!verifyIndex(bytes, signature.toString("utf8"), publicKeys))
    throw new Error(
      `${source}: index.json.sig does not verify with the keys in keys/`,
    );
  const index = JSON.parse(bytes.toString("utf8"));
  const problems = indexProblems(index, { legacy: true });
  if (problems.length)
    throw new Error(
      `${source}: previous index.json is invalid:\n  ${problems.join("\n  ")}`,
    );
  return index;
}

/**
 * Release lookups. `release(tag)` resolves to null when there is no
 * (published) release with that tag, else
 * `{ published, asset: { name, size, sha256 | null, download() } | null }`
 * for the asset named `assetName`. `any()` tells whether the repository has
 * any release.
 *
 * `github(repo, token)` asks the GitHub API (token optional for a public
 * repository); `fixture(tags, any)` answers from `{ "<tag>": { published,
 * size, sha256 } }` (the `tags` of a scripts/query-releases.mjs file, or
 * test data); `any` defaults to whether `tags` has an entry.
 */
export const releases = {
  github(repo, token) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const api = `https://api.github.com/repos/${repo}`;
    return {
      async any() {
        const bytes = await get(`${api}/releases?per_page=1`, headers);
        return !!bytes && JSON.parse(bytes.toString("utf8")).length > 0;
      },
      async release(tag, assetName) {
        const bytes = await get(
          `${api}/releases/tags/${encodeURIComponent(tag)}`,
          headers,
        );
        if (!bytes) return null;
        const data = JSON.parse(bytes.toString("utf8"));
        if (data.draft) return null;
        const asset = data.assets.find((item) => item.name === assetName);
        return {
          published: data.published_at,
          asset: asset && {
            name: asset.name,
            size: asset.size,
            sha256: /^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "")
              ? asset.digest.slice(7)
              : null,
            download: async () =>
              get(asset.url, {
                ...headers,
                Accept: "application/octet-stream",
              }),
          },
        };
      },
    };
  },
  fixture(data = {}, any = Object.keys(data).length > 0) {
    return {
      async any() {
        return any;
      },
      async release(tag, assetName) {
        const item = data[tag];
        if (!item) return null;
        return {
          published: item.published,
          asset: item.size
            ? {
                name: assetName,
                size: item.size,
                sha256: item.sha256 ?? null,
                download: async () => {
                  throw new Error(`fixture release ${tag} has no file`);
                },
              }
            : null,
        };
      },
    };
  },
};

/** sha256 and size of a release asset, downloading it when GitHub gave no digest. */
export async function assetDigest(asset) {
  if (asset.sha256) return { sha256: asset.sha256, size: asset.size };
  const bytes = await asset.download();
  if (!bytes)
    throw new Error(`release asset ${asset.name} could not be downloaded`);
  return { sha256: sha256(bytes), size: bytes.length };
}

/**
 * A provider from a releases file, `{ "any": boolean, "tags": { "<tag>":
 * { "published", "size", "sha256" } } }` (written by
 * scripts/query-releases.mjs).
 */
export async function releasesFromFile(file) {
  const data = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof data?.any !== "boolean" ||
    !data.tags ||
    typeof data.tags !== "object"
  )
    throw new Error(`${file}: expected { "any": boolean, "tags": { ... } }`);
  for (const [tag, item] of Object.entries(data.tags))
    if (
      typeof item?.published !== "string" ||
      (item.size !== undefined && !Number.isSafeInteger(item.size)) ||
      (item.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(item.sha256))
    )
      throw new Error(
        `${file}: tags["${tag}"] needs published and optional size and sha256`,
      );
  return releases.fixture(data.tags, data.any);
}
