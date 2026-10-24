/**
 * revoked.json: the hand-maintained revocation list, copied into the index's
 * `revoked` unchanged.
 *
 *   [{ "id": "<plugin id>", "versions": "<range>", "reason": "<text>" }]
 *
 * `versions` uses the range grammar in semver.mjs (an exact version is a
 * range too). `vestra.` ids (the player's built-in plugins, which this
 * index does not publish) are rejected. The store disables an installed version that matches and tells
 * the user why.
 *
 * The list is append-only: once an entry is published, it stays, unchanged
 * and at the same position; new entries go at the end. The store treats an
 * index that lacks a revocation it has seen as a replayed old index
 * (store-design §3.4), so dropping an entry would make every store reject
 * the official index. `revokedAppendProblems` enforces this in CI against
 * the base branch's revoked.json and in the release-and-sign job against the
 * previously signed index.
 */
import { isDeepStrictEqual } from "node:util";
import { idProblems, RESERVED_PREFIX } from "./registry.mjs";
import { parseRange } from "./semver.mjs";

const KEYS = ["id", "versions", "reason"];
const MAX_REASON = 500;

/** Problems with the parsed revoked.json (empty: valid). */
export function revokedProblems(list) {
  if (!Array.isArray(list)) return ["revoked.json must be a JSON array"];
  const problems = [];
  list.forEach((item, index) => {
    const at = `revoked.json[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(item))
      if (!KEYS.includes(key)) problems.push(`${at}: unknown key "${key}"`);
    for (const problem of idProblems(item.id))
      problems.push(`${at}: ${problem}`);
    if (
      typeof item.id === "string" &&
      item.id.toLowerCase().startsWith(RESERVED_PREFIX)
    )
      problems.push(
        `${at}: "${RESERVED_PREFIX}" ids are the player's built-in plugins, which this index does not publish`,
      );
    try {
      parseRange(item.versions);
    } catch (error) {
      problems.push(`${at}: versions: ${error.message}`);
    }
    if (
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      [...item.reason].length > MAX_REASON ||
      /[\u0000-\u0008\u000b-\u001f\u007f]/.test(item.reason)
    )
      problems.push(
        `${at}: reason must be 1–${MAX_REASON} characters of text (newlines allowed)`,
      );
  });
  return problems;
}

/**
 * Problems when `after` is not `before` with entries appended (empty: fine).
 * `before` is what was published (or the base branch's list), `where` names
 * it in the messages.
 */
export function revokedAppendProblems(before, after, where) {
  const problems = [];
  const old = Array.isArray(before) ? before : [];
  const now = Array.isArray(after) ? after : [];
  old.forEach((entry, index) => {
    if (index >= now.length)
      problems.push(
        `revoked[${index}] (${entry?.id} ${entry?.versions}) from ${where} was removed; revoked.json is append-only`,
      );
    else if (!isDeepStrictEqual(now[index], entry))
      problems.push(
        `revoked[${index}] (${entry?.id} ${entry?.versions}) differs from ${where}; published entries never change, add new ones at the end`,
      );
  });
  return problems;
}
