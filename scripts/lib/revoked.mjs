/**
 * revoked.json: the hand-maintained revocation list, copied into the index's
 * `revoked` unchanged.
 *
 *   [{ "id": "<plugin id>", "versions": "<range>", "reason": "<text>" }]
 *
 * `versions` uses the range grammar in semver.mjs (an exact version is a
 * range too). The store disables an installed version that matches and tells
 * the user why.
 */
import { idProblems } from "./registry.mjs";
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
