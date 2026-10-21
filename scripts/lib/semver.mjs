/**
 * Plugin versions and the version ranges of revoked.json.
 *
 * A version is strict MAJOR.MINOR.PATCH without leading zeros, the same rule
 * as the manifest's `version` (no pre-release or build suffix).
 *
 * A range is one or more alternatives separated by `||`; an alternative is
 * either `*` (every version) or one or more space-separated comparators that
 * must all hold. A comparator is a version with an optional operator: `=`
 * (the default), `<`, `<=`, `>` or `>=`. Examples: `1.2.0`, `<1.2.3`,
 * `>=1.0.0 <1.2.0`, `0.1.0 || >=0.3.0 <0.3.2`. No `^`, `~`, `x` or hyphen
 * ranges: the store (S5) implements exactly this grammar.
 */

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMPARATOR = /^(<=|>=|<|>|=)?(.+)$/;

export function isVersion(value) {
  return typeof value === "string" && VERSION.test(value);
}

function parts(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`not a MAJOR.MINOR.PATCH version: ${version}`);
  return match.slice(1).map(Number);
}

/** Negative, zero or positive, like a sort comparator. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Parses a range into alternatives of comparators. Throws with a readable
 * message when the range is not in the grammar above.
 */
export function parseRange(range) {
  if (typeof range !== "string" || !range.trim())
    throw new Error("range must be a non-empty string");
  if (range.length > 256)
    throw new Error("range is longer than 256 characters");
  return range.split("||").map((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) throw new Error(`empty alternative in "${range}"`);
    if (tokens.length === 1 && tokens[0] === "*") return [];
    return tokens.map((token) => {
      const [, operator = "=", version] = COMPARATOR.exec(token);
      if (!isVersion(version))
        throw new Error(
          `"${token}" in "${range}" is not a comparator (an optional <, <=, >, >= or = and a MAJOR.MINOR.PATCH version)`,
        );
      return { operator, version };
    });
  });
}

/** Whether `version` is in `range` (see the grammar above). */
export function satisfies(version, range) {
  return parseRange(range).some((comparators) =>
    comparators.every(({ operator, version: bound }) => {
      const order = compareVersions(version, bound);
      switch (operator) {
        case "<":
          return order < 0;
        case "<=":
          return order <= 0;
        case ">":
          return order > 0;
        case ">=":
          return order >= 0;
        default:
          return order === 0;
      }
    }),
  );
}
