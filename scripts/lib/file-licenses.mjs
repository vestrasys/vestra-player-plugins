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
 *   whose SHA256 equals the file's bytes, as a separate file, never
 *   concatenated into or embedded in code. Offline this proves only that
 *   the file and its record agree; that the record names the upstream bytes
 *   (unmodified) is checked by downloading them in CI
 *   (scripts/verify-shader-sources.mjs, `upstreamUrl`).
 *   The hash is of the bytes as committed: .gitattributes stores shaders
 *   and their COPYING files under each plugin's shaders/ with -text, so
 *   upstream CRLF endings survive checkout.
 * - Next to every LGPL shader (same directory) lie the license texts, the
 *   FSF's files byte for byte (pinned by SHA256): `COPYING.LESSER`
 *   (LGPL-3.0) and `COPYING` (GPL-3.0, which LGPL-3.0 incorporates).
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
 *   Path: gather/ravu-lite-ar-r4.hook
 *   SHA256: <sha256 of the file, lowercase hex>
 *   License: LGPL-3.0-or-later
 *
 * `File:` starts at the beginning of a line; the record ends at a blank line.
 * A file that is only a release asset (in no commit) has
 * `Asset: <Repository>/releases/download/<tag>/<file>` instead of `Path:`,
 * with `Commit:` the commit the tag points to; exactly one of the two.
 * Repository is https://github.com/<owner>/<repo> or
 * https://gist.github.com/<owner>/<id> (Commit: the gist revision, Path: the
 * file name; no Asset).
 *
 * Every file is scanned for notices, whatever its extension, except
 * README.md, CHANGELOG.md, shaders/SOURCES.txt, .po and .pot files under
 * locales/, and license texts under shaders/ or licenses/ (LICENSE,
 * LICENCE, COPYING, NOTICE, with no extension, .txt or .md, COPYING.LESSER,
 * or a "-<name>" suffix such as LICENSE-MIT). node_modules/ and dist/ are
 * not read here (the npm rules in scripts/lib/dependencies.mjs cover them;
 * the package check scans the built package with the same rule).
 *
 * mpv loads a shader whatever its file name, so an exempt file must not be
 * one (`exemptFileProblem`): it holds no "//!" anywhere, and every COPYING
 * or COPYING.LESSER under shaders/ is the FSF's text (pinned by SHA256),
 * with or without an LGPL shader next to it.
 *
 * Review still has to catch what text matching cannot: a stripped notice,
 * shorthand such as "LGPLv3", shader text pasted into a string in code, and
 * a License field that differs from the file's notice.
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
const LICENSE_TEXT =
  /^(licen[cs]e|copying|notice)(\.lesser|-[a-z0-9-]+)?(\.(txt|md))?$/i;
const NOT_SCANNED_PATHS = new Set(["README.md", "CHANGELOG.md", SOURCES]);
const LOCALE_FILE = /^locales\/.*\.pot?$/i;
// mpv (libplacebo's custom_mpv.c) starts a shader at the first "//!"
// anywhere in the text and reads its keywords by prefix ("//!HOOKMAIN"); a
// text without "//!" has no headers and does not load.
const SHADER_HEADER = "//!";
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);
// The repository name is never "." or ".." (also with ".git"): the URL would
// name another path.
const GITHUB =
  /^https:\/\/github\.com\/[A-Za-z0-9-]+\/(?!\.{0,2}(\.git)?$)[A-Za-z0-9._-]+$/;
const GIST = /^https:\/\/gist\.github\.com\/[A-Za-z0-9-]+\/[0-9a-f]+$/;

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

/**
 * SHA256 of the FSF's texts: https://www.gnu.org/licenses/lgpl-3.0.txt and
 * https://www.gnu.org/licenses/gpl-3.0.txt (LF line endings).
 */
export const LICENSE_TEXTS = {
  "COPYING.LESSER": {
    name: "LGPL-3.0",
    url: "https://www.gnu.org/licenses/lgpl-3.0.txt",
    sha256: "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118",
  },
  COPYING: {
    name: "GPL-3.0",
    url: "https://www.gnu.org/licenses/gpl-3.0.txt",
    sha256: "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
  },
};

const FIELDS = {
  repository: "Repository",
  commit: "Commit",
  path: "Path",
  asset: "Asset",
  sha256: "SHA256",
  license: "License",
};

/**
 * The records of a SOURCES.txt text: [{ line, file, repository, commit,
 * path, asset, sha256, license }] (missing fields undefined).
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

/** Whether a package or plugin path (relative, with /) is read for notices. */
export function scanned(path) {
  if (NOT_SCANNED_PATHS.has(path) || LOCALE_FILE.test(path)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return !(
    (path.startsWith(`${SHADERS}/`) || path.startsWith("licenses/")) &&
    LICENSE_TEXT.test(name)
  );
}

/**
 * Why a file that is not scanned for notices (`scanned`) is refused, or
 * undefined: it holds "//!" anywhere, or it is a COPYING or
 * COPYING.LESSER under shaders/ that is not the FSF's text byte for byte.
 */
export function exemptFileProblem(path, bytes) {
  if (scanned(path)) return undefined;
  const name = path.slice(path.lastIndexOf("/") + 1).toUpperCase();
  const text = LICENSE_TEXTS[name];
  if (path.startsWith(`${SHADERS}/`) && text && sha256(bytes) !== text.sha256)
    return `${path} is not the FSF's ${text.name} text byte for byte (${text.url}, sha256 ${text.sha256})`;
  if (bytes.includes(SHADER_HEADER))
    return `${path}: contains "//!", which starts a shader header; mpv loads a shader whatever the file's name, so documentation, license and locale files may not contain it`;
  return undefined;
}

/**
 * Where CI downloads a record's upstream bytes: raw.githubusercontent.com at
 * the commit, the release asset, or the gist's raw file at the revision.
 * undefined for a record that names none of them.
 */
export function upstreamUrl(record) {
  const segments = (path) => path.split("/").map(encodeURIComponent).join("/");
  if (GITHUB.test(record.repository ?? "")) {
    if (record.asset) return record.asset;
    const [owner, repo] = record.repository.split("/").slice(3);
    return `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, "")}/${record.commit}/${segments(record.path)}`;
  }
  if (GIST.test(record.repository ?? "")) {
    const [owner, id] = record.repository.split("/").slice(3);
    return `https://gist.githubusercontent.com/${owner}/${id}/raw/${record.commit}/${segments(record.path)}`;
  }
  return undefined;
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
      if (key !== "path" && key !== "asset" && !record[key])
        where(`${name} is missing`);
    if (!record.path === !record.asset)
      where(
        "exactly one of Path (a file in the commit) or Asset (a release asset)",
      );
    if (record.asset && record.repository) {
      const releases = `${record.repository.replace(/(\.git)?\/*$/, "")}/releases/download/`;
      let href;
      try {
        href = new URL(record.asset).href;
      } catch {
        href = undefined;
      }
      const rest = record.asset.slice(releases.length);
      if (
        href !== record.asset ||
        !record.asset.startsWith("https://") ||
        !record.asset.startsWith(releases) ||
        /[?#]/.test(rest) ||
        !/^[^/]+\/[^/]+$/.test(rest) ||
        rest.split("/").some((part) => part === "." || part === "..")
      )
        where(
          `Asset must be a release asset of the Repository: ${releases}<tag>/<file>`,
        );
    }
    if (
      record.repository &&
      !GITHUB.test(record.repository) &&
      !GIST.test(record.repository)
    )
      where(
        "Repository must be https://github.com/<owner>/<repo> or https://gist.github.com/<owner>/<id>",
      );
    if (record.asset && GIST.test(record.repository ?? ""))
      where("a gist has no release assets: use Path (the file name)");
    if (
      record.path &&
      (record.path.startsWith("/") ||
        record.path.includes("\\") ||
        record.path
          .split("/")
          .some((part) => !part || part === "." || part === ".."))
    )
      where("Path must be a relative path in the repository, with /");
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
        `the file's SHA256 is ${sha256(bytes)}, not the one in the record: hosted plugins ship upstream files unmodified`,
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
    const bytes = await readFile(join(directory, ...file.split("/")));
    if (!scanned(file)) {
      const exempt = exemptFileProblem(file, bytes);
      if (exempt) problem(exempt);
      continue;
    }
    const notice = copyleftNotice(bytes.toString("utf8"));
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
          ? `${file}: an LGPL shader needs a record in ${SOURCES} (File, Repository, Commit, Path or Asset, SHA256, License) whose SHA256 matches it`
          : `${file}: has an LGPL license notice; LGPL is allowed only for unmodified mpv shaders (.glsl, .hook) under shaders/ listed in ${SOURCES}, never in code`,
      );
      continue;
    }
    textDirectories.add(posix.dirname(file));
  }
  for (const folder of textDirectories)
    for (const [name, text] of Object.entries(LICENSE_TEXTS)) {
      const path = `${folder}/${name}`;
      // Its bytes are checked with every other COPYING under shaders/
      // (exemptFileProblem). walk() skips symbolic links, so a linked
      // COPYING counts as missing here; `npm run boundaries` refuses
      // symbolic links in a plugin outright.
      try {
        await readFile(join(directory, ...path.split("/")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        problem(
          `${path} is missing: an LGPL shader ships with the full ${text.name} text next to it (${text.url})`,
        );
      }
    }
  return problems;
}

/**
 * Compares each SOURCES.txt record's SHA256 with its upstream file's:
 * `download(url)` returns the downloaded bytes' SHA256 (or throws). Records
 * the offline rules refuse are reported as such and not downloaded.
 * { checked, problems }.
 */
export async function verifyUpstream(directory, label, { download }) {
  const { records, problems } = await shaderSources(directory, label);
  let checked = 0;
  for (const record of records) {
    if (!record.ok) continue;
    const where = `${label}: ${SOURCES}:${record.line}: ${record.file}`;
    const url = upstreamUrl(record);
    if (!url) {
      problems.push(`${where}: no upstream URL for ${record.repository}`);
      continue;
    }
    let upstream;
    try {
      upstream = await download(url);
    } catch (error) {
      problems.push(
        `${where}: could not download the upstream file ${url}: ${error.message}`,
      );
      continue;
    }
    checked++;
    if (upstream !== record.sha256)
      problems.push(
        `${where}: the upstream file ${url} has SHA256 ${upstream}, the record (and the shipped file) ${record.sha256}: the shipped shader is not the upstream file; ship it unmodified from that commit or asset`,
      );
  }
  return { checked, problems };
}
