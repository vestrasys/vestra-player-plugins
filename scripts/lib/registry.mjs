/**
 * Third-party registrations: registry/<plugin id>.toml.
 *
 *   repository = "https://github.com/<owner>/<repo>"
 *   commit = "<40 hex digits>"
 *   path = "."            # optional; the plugin's directory in that repository
 *   owners = ["<GitHub login>", ...]
 *
 * Rules (ecosystem plan 1.3a, 1.5a):
 * - the file name is the plugin id; the id is `<owner>.<name>` where <owner>
 *   is the repository's GitHub owner (user or organization, compared without
 *   case, as GitHub does);
 * - `vestra.` belongs to the plugins in plugins/ and cannot be registered;
 * - the id uses the manifest's characters (letters, digits, `.`, `-`, `_`);
 * - no other keys (there is no `channel`: decision 1.6 item 8);
 * - once registered, a change to the file (including removing it or changing
 *   its owners) must come from one of the owners already on file.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseToml } from "./toml.mjs";

export const ID = /^[A-Za-z0-9._-]+$/;
const MAX_ID_BYTES = 128;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;
const KEYS = new Set(["repository", "commit", "path", "owners"]);
export const OFFICIAL_PREFIX = "vestra.";

/** Problems with one plugin id as an id (empty: valid). */
export function idProblems(id) {
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    Buffer.byteLength(id) > MAX_ID_BYTES
  )
    return ["id must be 1–128 ASCII letters, digits, '.', '-' or '_'"];
  return [];
}

function pathProblems(path) {
  if (typeof path !== "string" || !path)
    return ["path must be a non-empty string"];
  if (path === ".") return [];
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "" || part === ".")
  )
    return [
      'path must be "." or a relative path like "packages/plugin" (no "..", "\\", empty or absolute parts)',
    ];
  return [];
}

/**
 * Validates registry/<id>.toml. Returns `{ entry, problems }`: `entry` is the
 * normalized registration (`path` defaults to ".") when there are no
 * problems.
 */
export function validateRegistration(id, text) {
  const problems = [];
  let data;
  try {
    data = parseToml(text);
  } catch (error) {
    return { entry: null, problems: [error.message] };
  }
  problems.push(...idProblems(id));
  for (const key of Object.keys(data))
    if (!KEYS.has(key))
      problems.push(
        key === "channel"
          ? "channel is not used: the official repository has no channels"
          : `unknown key "${key}"`,
      );
  const match =
    typeof data.repository === "string" && REPOSITORY.exec(data.repository);
  if (!match)
    problems.push(
      "repository must be https://github.com/<owner>/<repo> (no trailing slash or .git)",
    );
  else if (match[2].endsWith(".git"))
    problems.push("repository must not end with .git");
  if (typeof data.commit !== "string" || !/^[0-9a-f]{40}$/.test(data.commit))
    problems.push("commit must be a full 40-digit lowercase hex commit id");
  const path = data.path ?? ".";
  problems.push(...pathProblems(path));
  const owners = data.owners;
  if (
    !Array.isArray(owners) ||
    !owners.length ||
    owners.some((owner) => typeof owner !== "string" || !LOGIN.test(owner))
  )
    problems.push("owners must be a non-empty array of GitHub logins");
  else if (
    new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length
  )
    problems.push("owners has duplicates");
  if (typeof id === "string" && !idProblems(id).length) {
    if (id.toLowerCase().startsWith(OFFICIAL_PREFIX))
      problems.push(
        `the "${OFFICIAL_PREFIX}" prefix is reserved for the official plugins in plugins/`,
      );
    else if (match) {
      const dot = id.indexOf(".");
      const prefix = dot > 0 ? id.slice(0, dot) : "";
      if (!prefix || dot === id.length - 1)
        problems.push(
          `id must be <GitHub owner>.<plugin name>, here "${match[1]}.<plugin name>"`,
        );
      else if (prefix.toLowerCase() !== match[1].toLowerCase())
        problems.push(
          `id prefix "${prefix}" must be the repository owner "${match[1]}"`,
        );
    }
  }
  if (problems.length) return { entry: null, problems };
  return {
    entry: {
      id,
      repository: data.repository,
      commit: data.commit,
      path,
      owners: [...owners],
    },
    problems,
  };
}

/** Reads and validates every registry/*.toml. Other files except README.md are problems. */
export async function readRegistry(directory) {
  const entries = [];
  const problems = [];
  let items;
  try {
    items = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { entries, problems };
    throw error;
  }
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name === "README.md") continue;
    if (!item.isFile() || !item.name.endsWith(".toml")) {
      problems.push(
        `registry/${item.name}: only <plugin id>.toml files belong here`,
      );
      continue;
    }
    const id = item.name.slice(0, -".toml".length);
    const result = validateRegistration(
      id,
      await readFile(join(directory, item.name), "utf8"),
    );
    for (const problem of result.problems)
      problems.push(`registry/${item.name}: ${problem}`);
    if (result.entry) entries.push(result.entry);
  }
  const seen = new Map();
  for (const entry of entries) {
    const key = entry.id.toLowerCase();
    if (seen.has(key))
      problems.push(
        `registry/${entry.id}.toml: same id as registry/${seen.get(key)}.toml except for case`,
      );
    else seen.set(key, entry.id);
  }
  return { entries, problems };
}

/**
 * The owner rule for a pull request. `before` is the registration on the base
 * branch (null when the file is new), `after` the one in the pull request
 * (null when the file is removed), `author` the pull request author's login.
 * A new registration needs `author` among its own owners; any change to an
 * existing one needs `author` among the owners on the base branch.
 */
export function ownerProblems(id, before, after, author) {
  const has = (owners) =>
    owners.some(
      (owner) => owner.toLowerCase() === String(author).toLowerCase(),
    );
  if (!before) {
    if (after && !has(after.owners))
      return [
        `registry/${id}.toml: the pull request author ${author} must be one of the owners of a new registration`,
      ];
    return [];
  }
  if (!has(before.owners))
    return [
      `registry/${id}.toml: only its owners (${before.owners.join(", ")}) can change or remove it; the pull request author is ${author}`,
    ];
  return [];
}
