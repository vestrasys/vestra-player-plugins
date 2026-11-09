/**
 * Licenses of the files a hosted plugin ships (CONTRIBUTING.md, "Third-party
 * files and licenses").
 *
 * A plugin's own code keeps its permissive license. Copyleft text is refused
 * in its files, with one exception: unmodified LGPL-3.0 mpv shaders.
 *
 * - A file whose text carries an LGPL notice ("GNU Lesser General Public
 *   License", "GNU Library General Public License" or an SPDX identifier
 *   naming LGPL) is accepted only as a shader (`.glsl`, `.hook`) under the
 *   plugin's `shaders/` directory that has a record in `shaders/SOURCES.txt`
 *   whose SHA256 equals the file's bytes: shipped as upstream published it,
 *   as a separate file, never edited, concatenated or derived.
 *   The hash is of the bytes as committed: .gitattributes stores shaders
 *   and their COPYING files under each plugin's shaders/ with -text, so
 *   upstream CRLF endings survive checkout.
 * - Next to every LGPL shader (same directory) lie the license texts:
 *   `COPYING.LESSER` (LGPL-3.0) and `COPYING` (GPL-3.0, which LGPL-3.0
 *   incorporates).
 * - Any other GPL/AGPL notice (or an LGPL one anywhere else: code, a shader
 *   outside shaders/ or not listed) is refused.
 * - Every record in SOURCES.txt is checked, LGPL or not: the file exists,
 *   is a shader under shaders/, and its SHA256 matches.
 *
 * A record in shaders/SOURCES.txt (the rest of the file is free text):
 *
 *   File: ravu/ravu-lite-ar-r4.hook
 *   Repository: https://github.com/bjin/mpv-prescalers
 *   Commit: <full commit id>
 *   Path: compute/ravu-lite-ar-r4.hook
 *   SHA256: <sha256 of the file, lowercase hex>
 *   License: LGPL-3.0-or-later
 *
 * `File:` starts at the beginning of a line; the record ends at a blank line.
 *
 * Not scanned: documentation and translations (.md, .txt, .po, .pot),
 * license texts (LICENSE*, LICENCE*, COPYING*, NOTICE*), images, and the
 * npm dependencies' licenses/, node_modules/ and dist/ (the npm rules in
 * scripts/lib/dependencies.mjs cover those; the package check scans the
 * built package).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

export const SHADERS = "shaders";
export const SOURCES = `${SHADERS}/SOURCES.txt`;
/** The licenses an LGPL shader may have; widening this needs a maintainer. */
export const SHADER_LGPL_LICENSES = new Set([
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
]);
const SHADER_FILE = /\.(glsl|hook)$/i;
const LICENSE_TEXT = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const NOT_SCANNED =
  /\.(md|txt|po|pot|png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf)$/i;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "licenses"]);

// Words may be split across comment lines ("GNU Lesser General\n// Public").
const GAP = String.raw`[\s/*#;!-]+`;
const LGPL_NOTICE = new RegExp(
  [
    `GNU${GAP}(Lesser|Library)${GAP}General${GAP}Public${GAP}Licen[cs]e`,
    String.raw`SPDX-License-Identifier:[^\n]*\bLGPL`,
  ].join("|"),
  "i",
);
const COPYLEFT_NOTICE = new RegExp(
  [
    `GNU${GAP}(Affero${GAP})?General${GAP}Public${GAP}Licen[cs]e`,
    String.raw`SPDX-License-Identifier:[^\n]*\bA?GPL`,
  ].join("|"),
  "i",
);

/**
 * The license notice in a file's text: "lgpl", "copyleft" (GPL, AGPL) or
 * null.
 */
export function copyleftNotice(text) {
  if (LGPL_NOTICE.test(text)) return "lgpl";
  if (COPYLEFT_NOTICE.test(text)) return "copyleft";
  return null;
}

/** The LGPL-3.0 and GPL-3.0 texts, recognised by their fixed passages. */
const TEXTS = {
  "COPYING.LESSER": [
    "GNU LESSER GENERAL PUBLIC LICENSE",
    "Version 3, 29 June 2007",
    "4. Combined Works.",
    "6. Revised Versions of the GNU Lesser General Public License.",
  ],
  COPYING: [
    "GNU GENERAL PUBLIC LICENSE",
    "Version 3, 29 June 2007",
    "TERMS AND CONDITIONS",
    "END OF TERMS AND CONDITIONS",
  ],
};

const FIELDS = {
  repository: "Repository",
  commit: "Commit",
  path: "Path",
  sha256: "SHA256",
  license: "License",
};

/**
 * The records of a SOURCES.txt text: [{ line, file, repository, commit,
 * path, sha256, license }] (missing fields undefined).
 */
export function parseSources(text) {
  const records = [];
  let current = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    const start = /^File:\s*(.*)$/.exec(line);
    if (start) {
      current = { line: index + 1, file: start[1] };
      records.push(current);
      return;
    }
    if (!line.trim()) {
      current = null;
      return;
    }
    if (!current) return;
    const field = /^\s*([A-Za-z0-9]+):\s*(.*)$/.exec(line);
    const key = field
      ? Object.keys(FIELDS).find(
          (name) =>
            FIELDS[name].toLowerCase() === field[1].toLowerCase() ||
            (name === "license" && field[1].toLowerCase() === "licence"),
        )
      : undefined;
    if (key) current[key] = field[2];
    else current.unknown = (current.unknown ?? 0) + 1;
  });
  return records;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function walk(directory, base = directory) {
  const out = [];
  let items;
  try {
    items = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const item of items) {
    const path = join(directory, item.name);
    const rel = posix.relative(
      base.split("\\").join("/"),
      path.split("\\").join("/"),
    );
    if (item.isDirectory()) {
      if (directory === base && SKIPPED_DIRECTORIES.has(item.name)) continue;
      if (item.name === "node_modules") continue;
      out.push(...(await walk(path, base)));
    } else if (item.isFile()) out.push(rel);
  }
  return out;
}

/** Whether a package or plugin path is read for license notices. */
export function scanned(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return !LICENSE_TEXT.test(name) && !NOT_SCANNED.test(name);
}

/**
 * The SOURCES.txt records of a plugin directory, validated: { records,
 * problems }. Each record gets `target` (its path in the plugin) and `lgpl`.
 */
export async function shaderSources(directory, label) {
  const problems = [];
  const problem = (message) => problems.push(`${label}: ${message}`);
  let text;
  try {
    text = await readFile(join(directory, ...SOURCES.split("/")), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], problems };
    throw error;
  }
  const records = parseSources(text);
  const seen = new Set();
  for (const record of records) {
    const before = problems.length;
    const where = (message) =>
      problem(
        `${SOURCES}:${record.line}: ${record.file || "File"}: ${message}`,
      );
    const file = record.file ?? "";
    const normal = posix.normalize(file);
    if (
      !file ||
      file.includes("\\") ||
      file.startsWith("/") ||
      /^[a-zA-Z]:/.test(file) ||
      normal !== file ||
      normal.startsWith("..")
    ) {
      where("File must be a path under shaders/, with /");
      continue;
    }
    if (!SHADER_FILE.test(file)) where("only .glsl and .hook shaders");
    if (seen.has(file)) where("listed twice");
    seen.add(file);
    record.target = `${SHADERS}/${file}`;
    if (record.unknown) where("unknown fields in the record");
    for (const [key, name] of Object.entries(FIELDS))
      if (!record[key]) where(`${name} is missing`);
    if (record.repository && !/^https:\/\/\S+$/.test(record.repository))
      where("Repository must be an https URL");
    if (record.commit && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(record.commit))
      where("Commit must be a full commit id (lowercase hex)");
    if (record.sha256 && !/^[0-9a-f]{64}$/.test(record.sha256))
      where("SHA256 must be 64 lowercase hex digits");
    let bytes;
    try {
      bytes = await readFile(join(directory, ...record.target.split("/")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      where("the file is missing");
      continue;
    }
    if (record.sha256 && sha256(bytes) !== record.sha256)
      where(
        `the file's SHA256 is ${sha256(bytes)}, not the upstream file's: hosted plugins ship upstream files unmodified`,
      );
    record.lgpl = copyleftNotice(bytes.toString("utf8")) === "lgpl";
    if (record.lgpl && !SHADER_LGPL_LICENSES.has(record.license))
      where(
        `an LGPL shader needs License ${[...SHADER_LGPL_LICENSES].join(" or ")}, not ${JSON.stringify(record.license ?? "")}`,
      );
    record.ok = problems.length === before;
  }
  return { records, problems };
}

/** Problems of the licenses of a plugin directory's files. */
export async function fileLicenseProblems(directory, label) {
  const { records, problems } = await shaderSources(directory, label);
  const problem = (message) => problems.push(`${label}: ${message}`);
  const accepted = new Map(
    records
      .filter((record) => record.ok)
      .map((record) => [record.target, record]),
  );
  const textDirectories = new Set();
  for (const file of await walk(directory)) {
    if (!scanned(file)) continue;
    const notice = copyleftNotice(
      (await readFile(join(directory, ...file.split("/")))).toString("utf8"),
    );
    if (!notice) continue;
    if (notice === "copyleft") {
      problem(
        `${file}: has a GPL/AGPL license notice; only unmodified LGPL-3.0 shaders under shaders/ may be copyleft`,
      );
      continue;
    }
    const record = accepted.get(file);
    if (!record) {
      problem(
        SHADER_FILE.test(file) && file.startsWith(`${SHADERS}/`)
          ? `${file}: an LGPL shader needs a record in ${SOURCES} (File, Repository, Commit, Path, SHA256, License) whose SHA256 matches it`
          : `${file}: has an LGPL license notice; LGPL is allowed only for unmodified mpv shaders (.glsl, .hook) under shaders/ listed in ${SOURCES}, never in code`,
      );
      continue;
    }
    textDirectories.add(posix.dirname(file));
  }
  for (const folder of textDirectories)
    for (const [name, passages] of Object.entries(TEXTS)) {
      const path = `${folder}/${name}`;
      let text;
      try {
        text = await readFile(join(directory, ...path.split("/")), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        problem(
          `${path} is missing: an LGPL shader ships with the full ${name === "COPYING" ? "GPL-3.0" : "LGPL-3.0"} text next to it`,
        );
        continue;
      }
      const flat = text.replace(/\s+/g, " ");
      if (!passages.every((passage) => flat.includes(passage)))
        problem(
          `${path} is not the full ${name === "COPYING" ? "GPL-3.0" : "LGPL-3.0"} text`,
        );
    }
  return problems;
}
