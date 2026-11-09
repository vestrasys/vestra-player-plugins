// Licenses of a hosted plugin's own files (scripts/lib/file-licenses.mjs):
// LGPL-3.0 only for unmodified mpv shaders under shaders/ listed in
// shaders/SOURCES.txt with a matching SHA256 and the license texts next to
// them; refused in code, npm dependencies and anywhere else. Synthetic
// plugins in a temporary directory; the package check on hand-made .vxp
// files; the upstream comparison (scripts/verify-shader-sources.mjs) with a
// stand-in download. fixtures/licenses/ holds the FSF's LGPL-3.0 and
// GPL-3.0 texts as published on gnu.org.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { dependencyProblems } from "../lib/dependencies.mjs";
import {
  copyleftNotice,
  fileLicenseProblems,
  LICENSE_TEXTS,
  parseSources,
  scanned,
  upstreamUrl,
  verifyUpstream,
} from "../lib/file-licenses.mjs";

const repository = resolve(import.meta.dirname, "../..");
let work;
before(async () => {
  work = await mkdtemp(join(tmpdir(), "vestra-file-licenses-"));
});
after(() => rm(work, { recursive: true, force: true }));

// The header bjin/mpv-prescalers puts on RAVU (LGPL-3.0-or-later).
const RAVU = `// Copyright (C) 2017-2021 Bin Jin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Lesser General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// You should have received a copy of the GNU Lesser General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

//!DESC RAVU-Lite (step1, luma, r3)
//!HOOK LUMA
vec4 hook() { return LUMA_tex(LUMA_pos); }
`;
const texts = join(import.meta.dirname, "fixtures/licenses");
const LGPL_TEXT = await readFile(join(texts, "COPYING.LESSER"), "utf8");
const GPL_TEXT = await readFile(join(texts, "COPYING"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const record = (file, text, extra = "") => `File: ${file}
Repository: https://github.com/bjin/mpv-prescalers
Commit: ${"a".repeat(40)}
Path: gather/${file.slice(file.lastIndexOf("/") + 1)}
SHA256: ${sha256(text)}
License: LGPL-3.0-or-later
${extra}`;

/** A plugin directory with these files ({ path: text }). */
let count = 0;
async function plugin(files) {
  const directory = join(work, `p${++count}`);
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return directory;
}
const ravuPlugin = (overrides = {}) =>
  plugin({
    "main.ts": "export {};\n",
    "shaders/SOURCES.txt": `Third-party shaders\n\n${record("ravu/ravu-lite-r3.hook", RAVU)}`,
    "shaders/ravu/ravu-lite-r3.hook": RAVU,
    "shaders/ravu/COPYING.LESSER": LGPL_TEXT,
    "shaders/ravu/COPYING": GPL_TEXT,
    ...overrides,
  });
const problemsOf = async (directory) =>
  (await fileLicenseProblems(directory, "p")).join("\n");

test("license notices: LGPL, other copyleft, none", () => {
  assert.equal(copyleftNotice(RAVU), "lgpl");
  assert.equal(
    copyleftNotice("// the GNU Lesser General\n// Public License"),
    "lgpl",
  );
  assert.equal(copyleftNotice("// SPDX-License-Identifier: LGPL-3.0"), "lgpl");
  assert.equal(
    copyleftNotice("// under the GNU General Public License"),
    "copyleft",
  );
  assert.equal(
    copyleftNotice("/* SPDX-License-Identifier: AGPL-3.0-only */"),
    "copyleft",
  );
  assert.equal(copyleftNotice("// MIT License"), null);
});

test("SOURCES.txt records among free text", () => {
  const [one] = parseSources(
    `Prose\n  Files: x.glsl\n\n${record("ravu/a.hook", RAVU)}\nMore prose\n`,
  );
  assert.equal(one.file, "ravu/a.hook");
  assert.equal(one.sha256, sha256(RAVU));
  assert.equal(one.license, "LGPL-3.0-or-later");
  assert.equal(parseSources("  Files: x.glsl\nLicence: MIT\n").length, 0);
});

test("accepted: an unmodified LGPL shader listed with its SHA256 and license texts", async () => {
  assert.equal(await problemsOf(await ravuPlugin()), "");
  // The same through the rules every hosted plugin goes through.
  assert.deepEqual(await dependencyProblems(await ravuPlugin(), "p"), []);
});

test("refused: a modified LGPL shader (SHA256 mismatch)", async () => {
  const problems = await problemsOf(
    await ravuPlugin({
      "shaders/ravu/ravu-lite-r3.hook": RAVU.replace("r3", "r3 tweaked"),
    }),
  );
  assert.match(problems, /SHA256 is [0-9a-f]{64}, not the one in the record/);
  assert.match(problems, /an LGPL shader needs a record/);
});

test("refused: an LGPL .ts file, also under shaders/ or listed", async () => {
  const header = RAVU.split("\n\n")[0];
  assert.match(
    await problemsOf(
      await ravuPlugin({ "main.ts": `${header}\nexport {};\n` }),
    ),
    /main\.ts: has an LGPL license notice; .*never in code/,
  );
  assert.match(
    await problemsOf(
      await ravuPlugin({ "shaders/ravu/loader.ts": `${header}\n` }),
    ),
    /shaders\/ravu\/loader\.ts: has an LGPL license notice/,
  );
  const code = `${header}\nexport const x = 1;\n`;
  assert.match(
    await problemsOf(
      await ravuPlugin({
        "shaders/SOURCES.txt": record("ravu/loader.ts", code),
        "shaders/ravu/loader.ts": code,
      }),
    ),
    /only \.glsl and \.hook shaders/,
  );
});

test("refused: an LGPL npm dependency", async () => {
  const directory = await plugin({
    "package.json": JSON.stringify({
      name: "x",
      private: true,
      type: "module",
      dependencies: { a: "1.0.0" },
      vestra: { bundle: true, assets: ["licenses"] },
    }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { a: "1.0.0" } },
        "node_modules/a": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
          integrity: "sha512-AAAA",
          license: "LGPL-3.0-or-later",
        },
      },
    }),
  });
  assert.match(
    (await dependencyProblems(directory, "p", { inventory: false })).join("\n"),
    /license LGPL-3\.0-or-later is not allowed/,
  );
});

test("refused: unlisted or misplaced LGPL shaders, GPL shaders, missing license texts", async () => {
  assert.match(
    await problemsOf(
      await ravuPlugin({ "shaders/SOURCES.txt": "Third-party shaders\n" }),
    ),
    /ravu-lite-r3\.hook: an LGPL shader needs a record/,
  );
  assert.match(
    await problemsOf(await plugin({ "ravu.glsl": RAVU })),
    /ravu\.glsl: has an LGPL license notice/,
  );
  assert.match(
    await problemsOf(
      await plugin({
        "shaders/gpl.glsl": "// the GNU General Public License v3\n",
      }),
    ),
    /gpl\.glsl: has a GPL\/AGPL license notice/,
  );
  const missing = await ravuPlugin();
  await rm(join(missing, "shaders/ravu/COPYING"));
  assert.match(
    await problemsOf(missing),
    /shaders\/ravu\/COPYING is missing: .*GPL-3\.0 text/,
  );
  assert.match(
    await problemsOf(
      await ravuPlugin({
        "shaders/ravu/COPYING.LESSER": "LGPL, see gnu.org\n",
      }),
    ),
    /COPYING\.LESSER is not the FSF's LGPL-3\.0 text byte for byte/,
  );
  assert.match(
    await problemsOf(
      await ravuPlugin({
        "shaders/SOURCES.txt": record("ravu/ravu-lite-r3.hook", RAVU).replace(
          "LGPL-3.0-or-later",
          "MIT",
        ),
      }),
    ),
    /an LGPL shader needs License LGPL-3\.0-only or LGPL-3\.0-or-later/,
  );
  assert.match(
    await problemsOf(
      await ravuPlugin({
        "shaders/SOURCES.txt": record("../main.hook", RAVU),
      }),
    ),
    /File must be a path under shaders\//,
  );
});

test("documentation and license texts are not scanned", async () => {
  assert.equal(
    await problemsOf(
      await plugin({
        "README.md": "Bundles RAVU (GNU Lesser General Public License).\n",
        "shaders/x/COPYING": GPL_TEXT,
      }),
    ),
    "",
  );
});

// ---------------------------------------------------------------- package

/** A stored zip of these entries ({ name: text }); no CRCs (not read). */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = {
  id: "someone.ravu",
  version: "1.0.0",
  apiVersion: "vestra/1",
  entry: "main.js",
  capabilities: [],
};
async function checkPackage(packed) {
  const directory = await ravuPlugin({
    "manifest.json": JSON.stringify(manifest),
  });
  const out = join(directory, "out");
  await mkdir(out);
  await writeFile(join(out, "someone.ravu-1.0.0.vxp"), zip(packed));
  return spawnSync(
    process.execPath,
    [join(repository, "scripts/check-package.mjs"), directory, out],
    { encoding: "utf8" },
  );
}
const packedFiles = {
  "manifest.json": JSON.stringify(manifest),
  "main.js": "export {};\n",
  "shaders/SOURCES.txt": `Third-party shaders\n\n${record("ravu/ravu-lite-r3.hook", RAVU)}`,
  "shaders/ravu/ravu-lite-r3.hook": RAVU,
  "shaders/ravu/COPYING.LESSER": LGPL_TEXT,
  "shaders/ravu/COPYING": GPL_TEXT,
};

test("package check: the listed shader and its license texts ship unchanged", async () => {
  const accepted = await checkPackage(packedFiles);
  assert.equal(accepted.status, 0, accepted.stderr);

  const { "shaders/ravu/COPYING": _, ...noGpl } = packedFiles;
  const missing = await checkPackage(noGpl);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /shaders\/ravu\/COPYING is not in the package/);

  const modified = await checkPackage({
    ...packedFiles,
    "shaders/ravu/ravu-lite-r3.hook": `${RAVU}// edited\n`,
  });
  assert.equal(modified.status, 1);
  assert.match(modified.stderr, /ravu-lite-r3\.hook differs from the plugin's/);
});

test("package check: LGPL shader text inside the bundle is refused", async () => {
  const result = await checkPackage({
    ...packedFiles,
    "main.js": `const shader = ${JSON.stringify(RAVU)};\nexport {};\n`,
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /main\.js: carries a GPL\/AGPL\/LGPL license notice/,
  );
});

test("the SHA256 is of the bytes as committed: CRLF stays CRLF", async () => {
  const crlf = RAVU.replaceAll("\n", "\r\n");
  const listed = {
    "shaders/SOURCES.txt": record("ravu/ravu-lite-r3.hook", crlf),
    "shaders/ravu/ravu-lite-r3.hook": crlf,
  };
  assert.equal(await problemsOf(await ravuPlugin(listed)), "");
  // The same file with LF endings (what text normalisation would check
  // out) no longer matches its upstream hash.
  assert.match(
    await problemsOf(
      await ravuPlugin({
        ...listed,
        "shaders/ravu/ravu-lite-r3.hook": RAVU,
      }),
    ),
    /SHA256 is [0-9a-f]{64}, not the one in the record/,
  );
});

test(".gitattributes stores shaders and their license texts byte for byte", () => {
  const paths = [
    "plugins/x/shaders/ravu/ravu-lite-r3.hook",
    "plugins/x/shaders/a.glsl",
    "plugins/x/shaders/ravu/COPYING",
    "plugins/x/shaders/ravu/COPYING.LESSER",
    "plugins/x/main.ts",
  ];
  const result = spawnSync("git", ["check-attr", "text", "--", ...paths], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const text = Object.fromEntries(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [path, , value] = line.split(": ");
        return [path, value];
      }),
  );
  for (const path of paths.slice(0, 4)) assert.equal(text[path], "unset", path);
  assert.equal(text["plugins/x/main.ts"], "auto");
});

// FSRCNNX is published only as release assets of igv/FSRCNN-TensorFlow.
const FSRCNNX = RAVU.replace("Bin Jin", "igv");
const assetRecord = (
  asset,
  extra = "",
) => `File: fsrcnnx/FSRCNNX_x2_8-0-4-1.glsl
Repository: https://github.com/igv/FSRCNN-TensorFlow
Commit: ${"b".repeat(40)}
Asset: ${asset}
SHA256: ${sha256(FSRCNNX)}
License: LGPL-3.0-or-later
${extra}`;
const ASSET =
  "https://github.com/igv/FSRCNN-TensorFlow/releases/download/1.1/FSRCNNX_x2_8-0-4-1.glsl";
const assetPlugin = (sources) =>
  plugin({
    "shaders/SOURCES.txt": sources,
    "shaders/fsrcnnx/FSRCNNX_x2_8-0-4-1.glsl": FSRCNNX,
    "shaders/fsrcnnx/COPYING.LESSER": LGPL_TEXT,
    "shaders/fsrcnnx/COPYING": GPL_TEXT,
  });

test("accepted: a release asset record (Asset instead of Path)", async () => {
  assert.equal(await problemsOf(await assetPlugin(assetRecord(ASSET))), "");
});

test("refused: a release asset outside the record's repository", async () => {
  for (const asset of [
    "https://github.com/someone/FSRCNN-TensorFlow/releases/download/1.1/FSRCNNX_x2_8-0-4-1.glsl",
    "https://github.com/igv/FSRCNN-TensorFlow-fork/releases/download/1.1/x.glsl",
    "https://github.com/igv/FSRCNN-TensorFlow/blob/master/x.glsl",
    "https://github.com/igv/FSRCNN-TensorFlow/releases/download/1.1/../../../other/x.glsl",
    "http://github.com/igv/FSRCNN-TensorFlow/releases/download/1.1/x.glsl",
  ])
    assert.match(
      await problemsOf(await assetPlugin(assetRecord(asset))),
      /Asset must be a release asset of the Repository/,
      asset,
    );
});

test("refused: both Path and Asset, or neither", async () => {
  assert.match(
    await problemsOf(
      await assetPlugin(assetRecord(ASSET, "Path: FSRCNNX_x2_8-0-4-1.glsl\n")),
    ),
    /exactly one of Path .* or Asset/,
  );
  assert.match(
    await problemsOf(
      await assetPlugin(assetRecord(ASSET).replace(/^Asset: .*\n/m, "")),
    ),
    /exactly one of Path .* or Asset/,
  );
});

test("the license texts are the FSF's files, pinned by SHA256", () => {
  assert.equal(sha256(LGPL_TEXT), LICENSE_TEXTS["COPYING.LESSER"].sha256);
  assert.equal(sha256(GPL_TEXT), LICENSE_TEXTS.COPYING.sha256);
});

test("refused: a near copy of a license text (snippets, other line endings)", async () => {
  for (const text of [
    "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n4. Combined Works.\n6. Revised Versions of the GNU Lesser General Public License.\n",
    LGPL_TEXT.replaceAll("\n", "\r\n"),
  ])
    assert.match(
      await problemsOf(
        await ravuPlugin({ "shaders/ravu/COPYING.LESSER": text }),
      ),
      /COPYING\.LESSER is not the FSF's LGPL-3\.0 text byte for byte/,
    );
});

test("only README.md, CHANGELOG.md, SOURCES.txt, locale catalogs and license texts under shaders/ or licenses/ are not scanned", () => {
  for (const path of [
    "README.md",
    "CHANGELOG.md",
    "shaders/SOURCES.txt",
    "locales/zh-Hans.po",
    "shaders/ravu/COPYING",
    "shaders/ravu/COPYING.LESSER",
    "shaders/x/LICENSE",
    "shaders/x/LICENSE.txt",
    "licenses/a/LICENSE-MIT",
    "licenses/a/license.md",
  ])
    assert.equal(scanned(path), false, path);
  for (const path of [
    "license.ts",
    "notice.js",
    "shaders/copying.glsl",
    "shaders/ravu/license.ts",
    "licenses/a/notice.js",
    "LICENSE",
    "assets/COPYING",
    "DESIGN.md",
    "assets/ravu.md",
    "ravu.txt",
    "shaders/ravu/notes.txt",
    "assets/icon.png",
  ])
    assert.equal(scanned(path), true, path);
});

test("refused: an LGPL file named like a license text or documentation", async () => {
  const modified = RAVU.replace("r3", "r3 tweaked");
  for (const [path, pattern] of [
    ["license.ts", /license\.ts: has an LGPL license notice/],
    ["notice.js", /notice\.js: has an LGPL license notice/],
    [
      "shaders/ravu/copying.glsl",
      /copying\.glsl: an LGPL shader needs a record/,
    ],
    ["ravu.txt", /ravu\.txt: has an LGPL license notice/],
    ["assets/ravu.md", /assets\/ravu\.md: has an LGPL license notice/],
    ["shaders/ravu/ravu.txt", /shaders\/ravu\/ravu\.txt: has an LGPL/],
  ])
    assert.match(
      await problemsOf(await ravuPlugin({ [path]: modified })),
      pattern,
      path,
    );
  // A license text outside shaders/ and licenses/ is read like any file.
  assert.match(
    await problemsOf(await plugin({ "assets/COPYING": GPL_TEXT })),
    // (the GPL text also names the Lesser GPL)
    /assets\/COPYING: has an? (LGPL|GPL\/AGPL) license notice/,
  );
  assert.equal(
    await problemsOf(
      await plugin({
        "locales/zh-Hans.po": 'msgid "GNU Lesser General Public License"\n',
      }),
    ),
    "",
  );
});

test("refused: a Repository other than github.com or gist.github.com, a gist Asset, a bad Path", async () => {
  for (const repository of [
    "https://gitlab.com/someone/shaders",
    "https://github.com/someone",
    "https://github.com.evil.example/a/b",
    "http://github.com/bjin/mpv-prescalers",
  ])
    assert.match(
      await problemsOf(
        await ravuPlugin({
          "shaders/SOURCES.txt": record("ravu/ravu-lite-r3.hook", RAVU).replace(
            "https://github.com/bjin/mpv-prescalers",
            repository,
          ),
        }),
      ),
      /Repository must be https:\/\/github\.com\/<owner>\/<repo> or https:\/\/gist\.github\.com/,
      repository,
    );
  assert.match(
    await problemsOf(
      await assetPlugin(
        assetRecord(
          "https://gist.github.com/igv/abc/releases/download/1/x.glsl",
        ).replace(
          "https://github.com/igv/FSRCNN-TensorFlow",
          "https://gist.github.com/igv/0123abcd",
        ),
      ),
    ),
    /a gist has no release assets/,
  );
  assert.match(
    await problemsOf(
      await ravuPlugin({
        "shaders/SOURCES.txt": record("ravu/ravu-lite-r3.hook", RAVU).replace(
          "Path: gather/",
          "Path: ../",
        ),
      }),
    ),
    /Path must be a relative path in the repository/,
  );
});

test("upstream URLs: raw file at the commit, release asset, gist revision", () => {
  const commit = "a".repeat(40);
  assert.equal(
    upstreamUrl({
      repository: "https://github.com/bjin/mpv-prescalers",
      commit,
      path: "gather/ravu-lite-ar-r4.hook",
    }),
    `https://raw.githubusercontent.com/bjin/mpv-prescalers/${commit}/gather/ravu-lite-ar-r4.hook`,
  );
  assert.equal(
    upstreamUrl({
      repository: "https://github.com/igv/FSRCNN-TensorFlow",
      commit,
      asset: ASSET,
    }),
    ASSET,
  );
  assert.equal(
    upstreamUrl({
      repository:
        "https://gist.github.com/igv/a8e2fbd31a3cd1e1d8d1b4b7c88e7b29",
      commit,
      path: "SSimDownscaler.glsl",
    }),
    `https://gist.githubusercontent.com/igv/a8e2fbd31a3cd1e1d8d1b4b7c88e7b29/raw/${commit}/SSimDownscaler.glsl`,
  );
  assert.equal(
    upstreamUrl({ repository: "https://gitlab.com/a/b", commit, path: "x" }),
    undefined,
  );
});

test("upstream: a file changed together with its SHA256 passes offline and fails against upstream", async () => {
  const tweaked = RAVU.replace("r3", "r3 tweaked");
  const directory = await ravuPlugin({
    "shaders/SOURCES.txt": record("ravu/ravu-lite-r3.hook", tweaked),
    "shaders/ravu/ravu-lite-r3.hook": tweaked,
  });
  assert.equal(await problemsOf(directory), "");
  const urls = [];
  const upstream = async (url) => {
    urls.push(url);
    return sha256(RAVU);
  };
  const { checked, problems } = await verifyUpstream(directory, "p", {
    download: upstream,
  });
  assert.equal(checked, 1);
  assert.deepEqual(urls, [
    `https://raw.githubusercontent.com/bjin/mpv-prescalers/${"a".repeat(40)}/gather/ravu-lite-r3.hook`,
  ]);
  assert.match(
    problems.join("\n"),
    /the upstream file .* has SHA256 [0-9a-f]{64}, the record \(and the shipped file\) [0-9a-f]{64}: the shipped shader is not the upstream file/,
  );
  // Unmodified: the same upstream bytes.
  const clean = await verifyUpstream(await ravuPlugin(), "p", {
    download: upstream,
  });
  assert.deepEqual(clean.problems, []);
  // A failed download fails the check.
  const offline = await verifyUpstream(await ravuPlugin(), "p", {
    download: async () => {
      throw new Error("HTTP 404");
    },
  });
  assert.match(
    offline.problems.join("\n"),
    /could not download the upstream file .*: HTTP 404/,
  );
});

test("package check: an LGPL notice in a packed license.js is refused", async () => {
  const result = await checkPackage({
    ...packedFiles,
    "license.js": RAVU,
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /license\.js: carries a GPL\/AGPL\/LGPL license notice/,
  );
});

// mpv loads a shader whatever its file name: the files exempt from the
// notice scan may not hide one.
const STRIPPED = RAVU.replaceAll("GNU Lesser General Public License", "terms");

test("refused: a shader hidden in a license, notice, readme or locale file", async () => {
  for (const path of [
    "shaders/x/LICENSE-ravu",
    "shaders/x/NOTICE.md",
    "shaders/x/LICENSE.txt",
    "licenses/foo/LICENSE",
    "README.md",
    "CHANGELOG.md",
    "locales/zh.po",
    "locales/zh.pot",
  ])
    for (const text of [RAVU, STRIPPED])
      assert.match(
        await problemsOf(await plugin({ [path]: text })),
        new RegExp(
          `${path.replaceAll(".", "\.")}: has a shader directive line`,
        ),
        path,
      );
  // Any directive, indented or not, any line ending.
  for (const directive of [
    "//!HOOK MAIN",
    "  //!BIND HOOKED",
    "//!SAVE x",
    "//!TEXTURE t",
    "//!BUFFER b",
    "//!PARAM p",
    "//!COMPUTE 8 8",
    "//!DESC x",
  ])
    assert.match(
      await problemsOf(
        await plugin({ "shaders/x/NOTICE": `Notice\r\n${directive}\r\n` }),
      ),
      /NOTICE: has a shader directive line/,
      directive,
    );
  // Prose that mentions a directive is fine.
  assert.equal(
    await problemsOf(
      await plugin({ "README.md": "Shaders start with `//!HOOK MAIN`.\n" }),
    ),
    "",
  );
});

test("refused: a COPYING or COPYING.LESSER under shaders/ that is not the FSF's text, LGPL shader next to it or not", async () => {
  for (const [path, name] of [
    ["shaders/evil/COPYING.LESSER", "LGPL-3.0"],
    ["shaders/evil/COPYING", "GPL-3.0"],
    ["shaders/evil/copying.lesser", "LGPL-3.0"],
    ["shaders/COPYING", "GPL-3.0"],
  ])
    for (const text of [STRIPPED, "GNU GENERAL PUBLIC LICENSE (abridged)\n"])
      assert.match(
        await problemsOf(await plugin({ [path]: text })),
        new RegExp(
          `${path.replaceAll(".", "\.")} is not the FSF's ${name} text byte for byte`,
        ),
        path,
      );
  // The FSF's texts alone are accepted; elsewhere a COPYING is read for
  // notices, not pinned.
  assert.equal(
    await problemsOf(
      await plugin({
        "shaders/x/COPYING.LESSER": LGPL_TEXT,
        "shaders/x/COPYING": GPL_TEXT,
        "licenses/foo/COPYING": "Copyright (c) someone. MIT License.\n",
      }),
    ),
    "",
  );
  // A wrong text next to an LGPL shader is reported once.
  const problems = await problemsOf(
    await ravuPlugin({ "shaders/ravu/COPYING": "GPL\n" }),
  );
  assert.equal(problems.split("\n").length, 1, problems);
});

test("locales/ exempts only .po and .pot files", async () => {
  for (const path of ["locales/zh.po", "locales/zh-Hans.pot", "locales/a/b.PO"])
    assert.equal(scanned(path), false, path);
  for (const path of [
    "locales/ravu.hook",
    "locales/ravu.glsl",
    "locales/notes.txt",
    "locales/zh.po.js",
    "locales/LICENSE",
  ])
    assert.equal(scanned(path), true, path);
  assert.match(
    await problemsOf(await plugin({ "locales/ravu.hook": RAVU })),
    /locales\/ravu\.hook: has an LGPL license notice/,
  );
});

test("refused: a GitHub repository named . or ..", async () => {
  for (const name of [".", "..", ".git", "..git"])
    assert.match(
      await problemsOf(
        await ravuPlugin({
          "shaders/SOURCES.txt": record("ravu/ravu-lite-r3.hook", RAVU).replace(
            "https://github.com/bjin/mpv-prescalers",
            `https://github.com/bjin/${name}`,
          ),
        }),
      ),
      /Repository must be https:\/\/github\.com\/<owner>\/<repo>/,
      name,
    );
  for (const name of [".github", "a.b", "mpv-prescalers.git", "..."])
    assert.equal(
      await problemsOf(
        await ravuPlugin({
          "shaders/SOURCES.txt": record("ravu/ravu-lite-r3.hook", RAVU).replace(
            "https://github.com/bjin/mpv-prescalers",
            `https://github.com/bjin/${name}`,
          ),
        }),
      ),
      "",
      name,
    );
});

test("package check: a shader hidden in an exempt packed file is refused", async () => {
  for (const [path, pattern] of [
    ["shaders/ravu/NOTICE.md", /NOTICE\.md: has a shader directive line/],
    ["licenses/foo/LICENSE", /LICENSE: has a shader directive line/],
    ["locales/zh.po", /zh\.po: has a shader directive line/],
    [
      "locales/ravu.hook",
      /locales\/ravu\.hook: carries a GPL\/AGPL\/LGPL license notice/,
    ],
    [
      "shaders/evil/COPYING.LESSER",
      /shaders\/evil\/COPYING\.LESSER is not the FSF's LGPL-3\.0 text/,
    ],
  ]) {
    const result = await checkPackage({ ...packedFiles, [path]: RAVU });
    assert.equal(result.status, 1, path);
    assert.match(result.stderr, pattern, path);
  }
  const plain = await checkPackage({
    ...packedFiles,
    "locales/zh.po": 'msgid "Upscale"\nmsgstr ""\n',
  });
  assert.equal(plain.status, 0, plain.stderr);
});
