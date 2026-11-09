// Licenses of a hosted plugin's own files (scripts/lib/file-licenses.mjs):
// LGPL-3.0 only for unmodified mpv shaders under shaders/ listed in
// shaders/SOURCES.txt with a matching SHA256 and the license texts next to
// them; refused in code, npm dependencies and anywhere else. Synthetic
// plugins in a temporary directory; the package check on hand-made .vxp
// files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { dependencyProblems } from "../lib/dependencies.mjs";
import {
  copyleftNotice,
  fileLicenseProblems,
  parseSources,
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
// Stand-ins with the passages the check recognises the full texts by.
const LGPL_TEXT = `                   GNU LESSER GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007
  4. Combined Works.
  6. Revised Versions of the GNU Lesser General Public License.
`;
const GPL_TEXT = `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007
                       TERMS AND CONDITIONS
                     END OF TERMS AND CONDITIONS
`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const record = (file, text, extra = "") => `File: ${file}
Repository: https://github.com/bjin/mpv-prescalers
Commit: ${"a".repeat(40)}
Path: compute/${file.slice(file.lastIndexOf("/") + 1)}
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
  assert.match(problems, /SHA256 is [0-9a-f]{64}, not the upstream file's/);
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
    /COPYING\.LESSER is not the full LGPL-3\.0 text/,
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
    /SHA256 is [0-9a-f]{64}, not the upstream file's/,
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
