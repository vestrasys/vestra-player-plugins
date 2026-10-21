#!/usr/bin/env node
/**
 * Checks registry/*.toml and revoked.json (format and rules: scripts/lib/
 * registry.mjs and scripts/lib/revoked.mjs), and that no registration takes
 * an official plugin's id.
 *
 *   node scripts/check-registry.mjs
 *   node scripts/check-registry.mjs --base <git ref> --head <git ref> --author <GitHub login>
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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readRevoked } from "./lib/build.mjs";
import {
  OFFICIAL_PREFIX,
  ownerProblems,
  readRegistry,
  validateRegistration,
} from "./lib/registry.mjs";
import { revokedProblems } from "./lib/revoked.mjs";
import { plugins } from "./plugins.mjs";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    author: { type: "string" },
  },
});

const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 && !["show", "ls-tree"].includes(args[0]))
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result;
};
const show = (ref, path) => {
  const result = git("show", `${ref}:${path}`);
  return result.status === 0 ? result.stdout : null;
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
      if (revoked !== null) {
        try {
          problems.push(...revokedProblems(JSON.parse(revoked)));
        } catch (error) {
          problems.push(`revoked.json: ${error.message}`);
        }
      }

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
      await readRevoked(join(root, "revoked.json"));
    } catch (error) {
      problems.push(error.message);
    }
    const { entries, problems: registryProblems } = await readRegistry(
      join(root, "registry"),
    );
    problems.push(...registryProblems);
    const official = new Set();
    for (const name of await plugins(join(root, "plugins"))) {
      const { id } = JSON.parse(
        await readFile(join(root, "plugins", name, "manifest.json"), "utf8"),
      );
      if (typeof id !== "string" || !id.startsWith(OFFICIAL_PREFIX))
        problems.push(
          `plugins/${name}: an official plugin's id must start with ${OFFICIAL_PREFIX}`,
        );
      official.add(String(id).toLowerCase());
    }
    for (const entry of entries)
      if (official.has(entry.id.toLowerCase()))
        problems.push(
          `registry/${entry.id}.toml: the id belongs to an official plugin`,
        );
    console.log(
      `${entries.length} third-party registration(s), ${official.size} official plugin(s), revoked.json checked`,
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
