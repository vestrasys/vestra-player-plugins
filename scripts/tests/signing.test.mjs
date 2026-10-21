import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  privateKeyFromPem,
  publicKeyFromPem,
  signIndex,
  verifyIndex,
} from "../lib/signing.mjs";

const scripts = join(import.meta.dirname, "..");
const index = {
  schema: 1,
  name: "Vestra Player 官方仓库",
  official: true,
  plugins: [],
  revoked: [],
  extensions: {},
};
let directory;
let pair;
let other;

const pem = (key, type) => key.export({ type, format: "pem" }).toString();
const run = (script, args, env = {}) =>
  spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, VESTRA_INDEX_SIGNING_KEY: "", ...env },
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "vestra-signing-"));
  pair = generateKeyPairSync("ed25519");
  other = generateKeyPairSync("ed25519");
  await writeFile(join(directory, "public.pem"), pem(pair.publicKey, "spki"));
  await writeFile(join(directory, "other.pem"), pem(other.publicKey, "spki"));
});
after(() => rm(directory, { recursive: true, force: true }));

test("a signature verifies only the exact bytes it signed", () => {
  const privateKey = privateKeyFromPem(pem(pair.privateKey, "pkcs8"));
  const publicKey = publicKeyFromPem(pem(pair.publicKey, "spki"));
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  const signature = signIndex(bytes, privateKey);
  assert.match(signature, /^[A-Za-z0-9+/]+=*$/);
  assert.ok(verifyIndex(bytes, signature, publicKey));
  assert.ok(
    verifyIndex(bytes, `${signature}\n`, publicKey),
    "a trailing newline is tolerated",
  );
  assert.ok(
    !verifyIndex(
      Buffer.concat([bytes, Buffer.from(" ")]),
      signature,
      publicKey,
    ),
  );
  assert.ok(
    !verifyIndex(
      Buffer.from(bytes.toString().replace("true", "false")),
      signature,
      publicKey,
    ),
  );
  assert.ok(
    !verifyIndex(
      bytes,
      signature,
      publicKeyFromPem(pem(other.publicKey, "spki")),
    ),
  );
  assert.ok(!verifyIndex(bytes, "not base64!", publicKey));
  assert.ok(
    !verifyIndex(bytes, Buffer.alloc(10).toString("base64"), publicKey),
  );
});

test("only Ed25519 keys are accepted, and a bad key is not echoed", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
  assert.throws(
    () => privateKeyFromPem(pem(rsa.privateKey, "pkcs8")),
    /not Ed25519/,
  );
  assert.throws(
    () => publicKeyFromPem(pem(rsa.publicKey, "spki")),
    /not Ed25519/,
  );
  assert.throws(
    () =>
      privateKeyFromPem(
        "-----BEGIN PRIVATE KEY-----\nSECRETSTUFF\n-----END PRIVATE KEY-----\n",
      ),
    (error) => !error.message.includes("SECRETSTUFF"),
  );
});

test("sign-index and verify-index: signed index passes, tampered index fails", async () => {
  const site = await mkdtemp(join(directory, "site-"));
  await writeFile(
    join(site, "index.json"),
    JSON.stringify(index, null, 2) + "\n",
  );
  const key = pem(pair.privateKey, "pkcs8");

  let result = run("sign-index.mjs", [site]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VESTRA_INDEX_SIGNING_KEY is not set/);

  result = run(
    "sign-index.mjs",
    [site, "--public-key", join(directory, "other.pem")],
    {
      VESTRA_INDEX_SIGNING_KEY: key,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match/);

  result = run(
    "sign-index.mjs",
    [site, "--public-key", join(directory, "public.pem")],
    {
      VESTRA_INDEX_SIGNING_KEY: key,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    !result.stdout.includes("PRIVATE") && !result.stderr.includes("PRIVATE"),
  );
  const signature = await readFile(join(site, "index.json.sig"), "utf8");
  assert.equal(Buffer.from(signature, "base64").length, 64);

  result = run("verify-index.mjs", [join(directory, "public.pem"), site]);
  assert.equal(result.status, 0, result.stderr);
  result = run("verify-index.mjs", [join(directory, "other.pem"), site]);
  assert.equal(result.status, 1);

  const tampered = {
    ...index,
    revoked: [{ id: "a.b", versions: "*", reason: "x" }],
  };
  await writeFile(
    join(site, "index.json"),
    JSON.stringify(tampered, null, 2) + "\n",
  );
  result = run("verify-index.mjs", [join(directory, "public.pem"), site]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match/);
});

test("sign-index refuses an invalid index", async () => {
  const site = await mkdtemp(join(directory, "bad-"));
  await writeFile(
    join(site, "index.json"),
    JSON.stringify({ ...index, downloadCount: 3 }),
  );
  const result = run("sign-index.mjs", [site], {
    VESTRA_INDEX_SIGNING_KEY: pem(pair.privateKey, "pkcs8"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown key "downloadCount"/);
});
