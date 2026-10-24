#!/usr/bin/env node
/**
 * Checks the ids and owners of the plugins in plugins/ (plugins/owners.toml),
 * registry/*.toml and revoked.json (format and rules: scripts/lib/
 * registry.mjs and scripts/lib/revoked.mjs), and that no registration takes
 * the id of a plugin in plugins/. `vestra.` ids belong to the player's
 * built-in plugins and are rejected everywhere.
 *
 *   node scripts/check-registry.mjs [--revoked-base <git ref>]
 *   node scripts/check-registry.mjs --base <git ref> --head <git ref> --author <GitHub login>
 *
 * revoked.json is append-only (scripts/lib/revoked.mjs): with
 * --revoked-base, the working tree's revoked.json must keep every entry of
 * that commit's revoked.json unchanged and in place (CI passes the pull
 * request's base, or the commit before a push). The pull request form checks
 * the same between --base and --head.
 *
 * The second form is the pull request check: it reads registry/ from the
 * `--head` commit as data (git show; nothing from the pull request runs) and
 * applies the owner rule against `--base`. A registration added by the pull
 * request must list the author as an owner; a registration changed or removed
 * by it must already list the author as an owner on the base branch. CI runs
 * this form from the base branch's copy of this script
 * (pull_request_target), so a pull request cannot change the check that
 * judges it.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readRevoked } from "./lib/build.mjs";
import {
  ownerProblems,
  readHostedPlugins,
  readRegistry,
  validateRegistration,
} from "./lib/registry.mjs";
import { revokedAppendProblems, revokedProblems } from "./lib/revoked.mjs";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    author: { type: "string" },
    "revoked-base": { type: "string" },
  },
});

const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (
    result.status !== 0 &&
    !["show", "ls-tree", "rev-parse"].includes(args[0])
  )
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result;
};
const show = (ref, path) => {
  const result = git("show", `${ref}:${path}`);
  return result.status === 0 ? result.stdout : null;
};
/** revoked.json at `ref` (a missing file is an empty list). */
const revokedAt = (ref) => {
  if (git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).status !== 0)
    throw new Error(`${ref}: not a commit in this clone (fetch it first)`);
  const text = show(ref, "revoked.json");
  if (text === null) return [];
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`revoked.json at ${ref}: ${error.message}`);
  }
};

const problems = [];
const pullRequest = values.base || values.head || values.author;
try {
  if (pullRequest) {
    if (!values.base || !values.head || !values.author)
      throw new Error("--base, --head and --author go together");
    const { base, head, author } = values;

    // registry/ and revoked.json of the head commit, as files to validate.
    const directory = await mkdtemp(join(tmpdir(), "vestra-registry-"));
    try {
      // No registry/ in the head commit (all registrations removed): empty.
      const listing = git("ls-tree", "--name-only", `${head}:registry/`);
      const names = listing.status === 0 ? listing.stdout.split("\n") : [];
      for (const name of names.filter(Boolean))
        await writeFile(
          join(directory, name),
          show(head, `registry/${name}`) ?? "",
        );
      const result = await readRegistry(directory);
      problems.push(...result.problems);
      const revoked = show(head, "revoked.json");
      let headRevoked = [];
      if (revoked !== null) {
        try {
          headRevoked = JSON.parse(revoked);
          problems.push(...revokedProblems(headRevoked));
        } catch (error) {
          problems.push(`revoked.json: ${error.message}`);
        }
      }
      problems.push(
        ...revokedAppendProblems(
          revokedAt(base),
          headRevoked,
          `the base branch (${base})`,
        ),
      );

      const changed = git(
        "diff",
        "--name-only",
        "--no-renames",
        `${base}...${head}`,
        "--",
        "registry/",
      );
      const paths = changed.stdout
        .split("\n")
        .filter((path) => /^registry\/[^/]+\.toml$/.test(path));
      for (const path of paths) {
        const id = path.slice("registry/".length, -".toml".length);
        const old = show(base, path);
        // An unparsable base file counts as having no owners: only a
        // maintainer can fix it.
        const before =
          old === null
            ? null
            : (validateRegistration(id, old).entry ?? { owners: [] });
        const after = result.entries.find((entry) => entry.id === id) ?? null;
        problems.push(...ownerProblems(id, before, after, author));
      }
      console.log(
        `owner check: ${paths.length} changed registration(s) by ${author}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else {
    try {
      const revoked = await readRevoked(join(root, "revoked.json"));
      if (values["revoked-base"])
        problems.push(
          ...revokedAppendProblems(
            revokedAt(values["revoked-base"]),
            revoked,
            values["revoked-base"],
          ),
        );
    } catch (error) {
      problems.push(error.message);
    }
    const { entries, problems: registryProblems } = await readRegistry(
      join(root, "registry"),
    );
    problems.push(...registryProblems);
    const hosted = await readHostedPlugins(root);
    problems.push(...hosted.problems);
    const ids = new Map(
      hosted.plugins.map(({ id, name }) => [id.toLowerCase(), name]),
    );
    for (const entry of entries)
      if (ids.has(entry.id.toLowerCase()))
        problems.push(
          `registry/${entry.id}.toml: the id belongs to plugins/${ids.get(entry.id.toLowerCase())}`,
        );
    console.log(
      `${hosted.plugins.length} hosted plugin(s) in plugins/, ${entries.length} registration(s), revoked.json checked${values["revoked-base"] ? ` (append-only against ${values["revoked-base"]})` : ""}`,
    );
  }
} catch (error) {
  problems.push(error.message);
}

if (problems.length) {
  for (const problem of problems) console.error(`✖ ${problem}`);
  process.exit(1);
}
console.log("registry OK");
