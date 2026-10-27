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
  splitSignatures,
  verifyIndex,
} from "../lib/signing.mjs";

const scripts = join(import.meta.dirname, "..");
const index = {
  schema: 1,
  generated: 1,
  name: "Vestra Player official repository",
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
  assert.match(result.stderr, /no signature in index\.json\.sig matches/);
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

test("sign-index refuses an index without generated (the legacy shape)", async () => {
  const site = await mkdtemp(join(directory, "legacy-"));
  const { generated, ...legacy } = index;
  assert.equal(generated, 1);
  await writeFile(join(site, "index.json"), JSON.stringify(legacy));
  const result = run("sign-index.mjs", [site], {
    VESTRA_INDEX_SIGNING_KEY: pem(pair.privateKey, "pkcs8"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /generated must be a positive integer/);
});

test("several signatures: any one by any trusted key verifies", () => {
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  const a = signIndex(bytes, pair.privateKey);
  const b = signIndex(bytes, other.privateKey);
  const third = generateKeyPairSync("ed25519");
  for (const text of [
    `${a}\n${b}`,
    `${b}\n${a}`,
    `${b} ${a}\n`,
    `\n${a}\r\n${b}`,
  ]) {
    assert.ok(verifyIndex(bytes, text, pair.publicKey));
    assert.ok(verifyIndex(bytes, text, other.publicKey));
    assert.ok(verifyIndex(bytes, text, [third.publicKey, other.publicKey]));
    assert.ok(!verifyIndex(bytes, text, third.publicKey));
    assert.ok(!verifyIndex(bytes, text, []));
  }
  // A garbage line next to a good signature does not hide it; a signature
  // over other bytes does not count.
  assert.ok(verifyIndex(bytes, `junk!\n${a}`, pair.publicKey));
  const forOther = signIndex(Buffer.from("other"), pair.privateKey);
  assert.ok(!verifyIndex(bytes, `${forOther}\n${b}`, pair.publicKey));
  assert.deepEqual(splitSignatures(` ${a}\n\n${b} `), [a, b]);
  assert.ok(!verifyIndex(bytes, "", pair.publicKey));
});

test("sign-index with a rotation key writes one line per key; verify-index takes several keys", async () => {
  const site = await mkdtemp(join(directory, "rotate-"));
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  await writeFile(join(site, "index.json"), bytes);
  const current = pem(pair.privateKey, "pkcs8");
  const next = pem(other.privateKey, "pkcs8");
  const third = generateKeyPairSync("ed25519");
  await writeFile(join(directory, "third.pem"), pem(third.publicKey, "spki"));
  const both = [
    "--public-key",
    join(directory, "public.pem"),
    "--public-key",
    join(directory, "other.pem"),
  ];

  // NEXT must belong to one of the given public keys too.
  let result = run(
    "sign-index.mjs",
    [site, "--public-key", join(directory, "public.pem")],
    { VESTRA_INDEX_SIGNING_KEY: current, VESTRA_INDEX_SIGNING_KEY_NEXT: next },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VESTRA_INDEX_SIGNING_KEY_NEXT does not match/);
  result = run("sign-index.mjs", [site, ...both], {
    VESTRA_INDEX_SIGNING_KEY: current,
    VESTRA_INDEX_SIGNING_KEY_NEXT: current,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /same key/);
  result = run("sign-index.mjs", [site, ...both], {
    VESTRA_INDEX_SIGNING_KEY_NEXT: next,
  });
  assert.equal(result.status, 1, "NEXT alone is not enough");
  result = run("sign-index.mjs", [site, ...both], {
    VESTRA_INDEX_SIGNING_KEY: current,
    VESTRA_INDEX_SIGNING_KEY_NEXT: "not a key",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VESTRA_INDEX_SIGNING_KEY_NEXT: the signing key/);
  assert.ok(!result.stderr.includes("not a key"));

  result = run("sign-index.mjs", [site, ...both], {
    VESTRA_INDEX_SIGNING_KEY: current,
    VESTRA_INDEX_SIGNING_KEY_NEXT: next,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!/PRIVATE/.test(result.stdout + result.stderr));
  const text = await readFile(join(site, "index.json.sig"), "utf8");
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(!text.endsWith("\n"));
  assert.equal(lines[0], signIndex(bytes, pair.privateKey));
  assert.equal(lines[1], signIndex(bytes, other.privateKey));

  for (const key of ["public.pem", "other.pem"]) {
    result = run("verify-index.mjs", [join(directory, key), site]);
    assert.equal(result.status, 0, result.stderr);
  }
  result = run("verify-index.mjs", [
    join(directory, "third.pem"),
    join(directory, "other.pem"),
    site,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 signature\(s\); verified with .*other\.pem/);
  result = run("verify-index.mjs", [
    "--public-key",
    join(directory, "third.pem"),
    site,
  ]);
  assert.equal(result.status, 1);
  result = run("verify-index.mjs", [site]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage/);

  // An empty NEXT (an unset GitHub secret) is ignored: one signature.
  result = run("sign-index.mjs", [site, ...both], {
    VESTRA_INDEX_SIGNING_KEY: current,
    VESTRA_INDEX_SIGNING_KEY_NEXT: "",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(site, "index.json.sig"), "utf8"),
    signIndex(bytes, pair.privateKey),
  );
});

test("sign-index --append keeps valid signatures and refuses stale ones", async () => {
  const site = await mkdtemp(join(directory, "append-"));
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  await writeFile(join(site, "index.json"), bytes);
  const both = [
    "--public-key",
    join(directory, "public.pem"),
    "--public-key",
    join(directory, "other.pem"),
  ];
  let result = run("sign-index.mjs", [site, ...both], {
    VESTRA_INDEX_SIGNING_KEY: pem(pair.privateKey, "pkcs8"),
  });
  assert.equal(result.status, 0, result.stderr);
  result = run("sign-index.mjs", [site, ...both, "--append"], {
    VESTRA_INDEX_SIGNING_KEY: pem(other.privateKey, "pkcs8"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(site, "index.json.sig"), "utf8"),
    `${signIndex(bytes, pair.privateKey)}\n${signIndex(bytes, other.privateKey)}`,
  );
  // Appending the same key again changes nothing.
  result = run("sign-index.mjs", [site, ...both, "--append"], {
    VESTRA_INDEX_SIGNING_KEY: pem(other.privateKey, "pkcs8"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    (await readFile(join(site, "index.json.sig"), "utf8")).split("\n").length,
    2,
  );

  // index.json changed after the first signature: appending would publish a
  // stale signature next to a good one.
  await writeFile(
    join(site, "index.json"),
    JSON.stringify({ ...index, generated: 2 }),
  );
  result = run("sign-index.mjs", [site, ...both, "--append"], {
    VESTRA_INDEX_SIGNING_KEY: pem(pair.privateKey, "pkcs8"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to append/);
  result = run("sign-index.mjs", [site, "--append"], {
    VESTRA_INDEX_SIGNING_KEY: pem(pair.privateKey, "pkcs8"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--append needs --public-key/);
});
