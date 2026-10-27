/**
 * A fake of yt-dlp's GitHub releases for the tests: a signing key of our
 * own, `SHA2-256SUMS` signed with it (a real v4 OpenPGP signature packet),
 * and a `fetch` that answers the release addresses and records them.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { RsaKey } from "../openpgp.ts";
import { RELEASES } from "../ytdlp.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** The key the fake releases are signed with. */
export const KEY: RsaKey = { fingerprint: "ab".repeat(20), key: pair.publicKey };
/** Another key: signatures by it must be refused. */
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** A detached binary signature of `data`, as `gpg --detach-sign` writes it. */
export function signature(data: Uint8Array, signer = pair.privateKey, fingerprint = KEY.fingerprint): Buffer {
  const issuer = Buffer.from(fingerprint, "hex");
  const time = Buffer.alloc(4);
  time.writeUInt32BE(1_760_000_000);
  const hashed = Buffer.concat([Buffer.from([22, 33, 4]), issuer, Buffer.from([5, 2]), time]);
  const head = Buffer.concat([Buffer.from([4, 0x00, 1, 10, 0, hashed.length]), hashed]);
  const trailer = Buffer.from([4, 0xff, 0, 0, 0, head.length]);
  const signed = Buffer.concat([data, head, trailer]);
  const value = sign("sha512", signed, signer);
  const digest = createHash("sha512").update(signed).digest();
  const unhashed = Buffer.concat([Buffer.from([9, 16]), issuer.subarray(12)]);
  const bits = value.length * 8;
  const body = Buffer.concat([
    head,
    Buffer.from([0, unhashed.length]),
    unhashed,
    digest.subarray(0, 2),
    Buffer.from([bits >> 8, bits & 0xff]),
    value,
  ]);
  return Buffer.concat([Buffer.from([0x89, body.length >> 8, body.length & 0xff]), body]);
}

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface Release {
  tag: string;
  /** The asset's bytes. */
  content: Buffer;
  /** The checksum listed for it (default: its real one). */
  listed?: string;
  /** Sign with another key. */
  forged?: boolean;
  /** The asset's response ends with an error after the first half. */
  truncated?: boolean;
  /** What the asset's `--version` prints (default: the tag). */
  reports?: string;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  /** Every address fetched, in order. */
  urls: string[];
  release: Release;
  /** Answer every request with this status (403, 429…). */
  status?: number;
  /** Fail every request as an unreachable network does. */
  offline?: boolean;
  /**
   * Called when half of the asset has been sent; the rest waits until the
   * returned promise settles (to look at the progress, or to cancel, in the middle).
   */
  midway?: () => void | Promise<void>;
  /** Where followed redirects end (default: GitHub's release storage). */
  redirectTo?: string;
  /** Never answer (until the request is aborted). */
  hang?: boolean;
}

/** A fake GitHub serving `release` for `asset`. */
export function github(asset: string, release: Release): FakeGitHub {
  const fake: FakeGitHub = {
    urls: [],
    release,
    fetch: async (input, init) => {
      const url = String(input);
      fake.urls.push(url);
      init?.signal?.throwIfAborted();
      if (fake.offline) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
      if (fake.status) return new Response("limited", { status: fake.status });
      if (fake.hang)
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        );
      /** A followed answer, as if it came from `fake.redirectTo`. */
      const at = (response: Response) =>
        Object.defineProperty(response, "url", {
          value: fake.redirectTo ?? `https://release-assets.githubusercontent.com/${url.split("/").pop()}`,
        });
      const { tag, content } = fake.release;
      const base = `${RELEASES}/download/${tag}`;
      const sums = Buffer.from(
        `${"0".repeat(64)}  yt-dlp.tar.gz\n${fake.release.listed ?? sha256(content)}  ${asset}\n`,
      );
      if (url === `${RELEASES}/latest`) {
        if (init?.redirect !== "manual") throw new Error("the latest release must be looked up without following");
        return new Response(null, { status: 302, headers: { location: `https://github.com/yt-dlp/yt-dlp/releases/tag/${tag}` } });
      }
      if (url === `${base}/SHA2-256SUMS`) return at(new Response(new Uint8Array(sums)));
      if (url === `${base}/SHA2-256SUMS.sig`)
        return at(new Response(new Uint8Array(fake.release.forged ? signature(sums, other.privateKey) : signature(sums))));
      if (url === `${base}/${asset}`) {
        const half = content.subarray(0, content.length >> 1);
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(half);
            await new Promise((resolve) => setTimeout(resolve, 5));
            await fake.midway?.();
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (signal?.aborted) return controller.error(signal.reason);
            if (fake.release.truncated) return controller.error(new TypeError("terminated"));
            controller.enqueue(content.subarray(half.length));
            controller.close();
          },
        });
        return at(new Response(body, { headers: { "content-length": String(content.length) } }));
      }
      return new Response("not found", { status: 404 });
    },
  };
  return fake;
}
