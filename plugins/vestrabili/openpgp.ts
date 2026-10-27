import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Just enough OpenPGP (RFC 9580) to check a detached binary signature made
 * by one RSA key: yt-dlp signs each release's `SHA2-256SUMS` with its
 * project key and publishes `SHA2-256SUMS.sig`. Node's own crypto does the
 * RSA work; this file only reads the packet layout. Anything it does not
 * understand fails verification.
 */

/**
 * The public key packet of yt-dlp's signing key ("Simon Sawicki (yt-dlp
 * signing key)", created 2023-02-26), from `public.key` in the yt-dlp
 * repository, fingerprint {@link YT_DLP_FINGERPRINT}.
 */
const YT_DLP_KEY_PACKET =
  'BGP78C4BEAD0rF9zjGPAt0thlt5C1ebzccAVX7Nb1v+eqQjk+WEZdTETVCg3WAM5ngArlHdm/fZqzUgO+pAYrB60GKeg7ffUDf+S0XFKEZdeRLYeAaqqKhSibValDjvOBOztu3W607HLETQAqA7wTPuIt2WqmpL60NIcyr27LxqmgdN3mNvZ2iLO+bP0nKR/C+PgE9H4ytywDa12zMx6PmZCnVOOOu6XZEFmdUxxdQ9fFDqd9LcBKY2LDOcSYo1saY0YWiZWHtzVoZu1kOzjnS5Fjq/yBHJLImDH7pNxHm7s/PnaurpmQFtDFrukt+2lhDnpKUmGr/I/3IHqH/X+9nPoS4uiqQ5HpblB8BK+4WfpaiEg75LnvuOPfZIPKYyXa/0A7QojMwgOrD88ozT+VCkKkkJ+ijXZ7gHNjmcBaUdKK7fDIEOYI63Lyc6QWkGQTigFffSUXWHDCO9aXNhP3ejqFWgGMtCUsrbkcJkWuWY7q5ARy/05HbSM3K4DU9eqtnxmiV1WQ8nXuI9JgJQRvh5PTkny5LtxqzcmqvWO9TjHBbrs14BPEO9fcXxKL/CFBbzXDSvvAgArdqqlMoncQ/yicTlfL6qzJ8EKFiqW14QMTdAn6SuuZTodXCTiInwoT7WjjuFPKKdvfH1GP4bnqdzTnzLxCSDIEtfyfPsIX+9GI7Jkk/zZjQARAQAB';
export const YT_DLP_FINGERPRINT = 'ac0cbbe6848d6a873464af4e57cf65933b5a7581';

export interface RsaKey { fingerprint: string; key: KeyObject }

/** A v4 RSA public key from its packet body; the fingerprint is computed, not trusted. */
export function rsaKey(packet: Uint8Array): RsaKey {
  const body = Buffer.from(packet);
  if (body[0] !== 4 || (body[5] !== 1 && body[5] !== 3)) throw new Error('not a v4 RSA key');
  const n = mpi(body, 6);
  const e = mpi(body, n.end);
  if (e.end !== body.length) throw new Error('trailing key data');
  const fingerprint = createHash('sha1').update(Buffer.from([0x99, body.length >> 8, body.length & 0xff])).update(body).digest('hex');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: n.value.toString('base64url'), e: e.value.toString('base64url') } });
  return { fingerprint, key };
}

let pinned: RsaKey | undefined;
/** yt-dlp's signing key, checked against its published fingerprint. */
export function ytDlpKey(): RsaKey {
  pinned ??= rsaKey(Buffer.from(YT_DLP_KEY_PACKET, 'base64'));
  if (pinned.fingerprint !== YT_DLP_FINGERPRINT) throw new Error('the pinned yt-dlp key does not match its fingerprint');
  return pinned;
}

function mpi(data: Buffer, at: number): { value: Buffer; end: number } {
  if (at + 2 > data.length) throw new Error('truncated');
  const bytes = (data.readUInt16BE(at) + 7) >> 3;
  const end = at + 2 + bytes;
  if (end > data.length) throw new Error('truncated');
  return { value: data.subarray(at + 2, end), end };
}

/** The body of the first packet of `data` (old or new header format), which must be a signature (tag 2). */
function signaturePacket(data: Buffer): Buffer {
  const header = data[0];
  if (header === undefined || !(header & 0x80)) throw new Error('not an OpenPGP packet');
  let tag: number, length: number, at: number;
  if (header & 0x40) {
    tag = header & 0x3f;
    const first = data[1] ?? 0;
    if (first < 192) [length, at] = [first, 2];
    else if (first < 224) [length, at] = [((first - 192) << 8) + (data[2] ?? 0) + 192, 3];
    else if (first === 255) [length, at] = [data.readUInt32BE(2), 6];
    else throw new Error('partial packet lengths are not supported');
  } else {
    tag = (header >> 2) & 0x0f;
    const type = header & 3;
    if (type === 0) [length, at] = [data[1] ?? 0, 2];
    else if (type === 1) [length, at] = [data.readUInt16BE(1), 3];
    else if (type === 2) [length, at] = [data.readUInt32BE(1), 5];
    else throw new Error('indeterminate packet length');
  }
  if (tag !== 2) throw new Error('not a signature packet');
  if (at + length > data.length) throw new Error('truncated');
  return data.subarray(at, at + length);
}

const HASHES: Record<number, string> = { 8: 'sha256', 9: 'sha384', 10: 'sha512' };

/** The issuer fingerprint (subpacket 33) or key id (16) a signature names, lower-case hex. */
function issuers(subpackets: Buffer): string[] {
  const found: string[] = [];
  for (let at = 0; at < subpackets.length; ) {
    const first = subpackets[at]!;
    let length: number;
    if (first < 192) [length, at] = [first, at + 1];
    else if (first < 255) [length, at] = [((first - 192) << 8) + subpackets[at + 1]! + 192, at + 2];
    else [length, at] = [subpackets.readUInt32BE(at + 1), at + 5];
    if (length < 1 || at + length > subpackets.length) throw new Error('bad subpacket');
    const type = subpackets[at]! & 0x7f;
    const value = subpackets.subarray(at + 1, at + length);
    if (type === 33 && value[0] === 4) found.push(value.subarray(1).toString('hex'));
    if (type === 16) found.push(value.toString('hex'));
    at += length;
  }
  return found;
}

/**
 * Whether `signature` (a binary detached OpenPGP signature) is a valid
 * signature of `data` (signature type 0x00, a binary document) by `key`.
 * Malformed input, another signer, another algorithm or a version other
 * than 4 all give `false`.
 */
export function verifyDetached(data: Uint8Array, signature: Uint8Array, key: RsaKey = ytDlpKey()): boolean {
  try {
    const packet = signaturePacket(Buffer.from(signature));
    const [version, type, algorithm, hashId] = packet;
    const hash = HASHES[hashId ?? 0];
    if (version !== 4 || type !== 0x00 || (algorithm !== 1 && algorithm !== 3) || !hash) return false;
    const hashedLength = packet.readUInt16BE(4);
    const hashedEnd = 6 + hashedLength;
    const unhashedLength = packet.readUInt16BE(hashedEnd);
    const unhashedEnd = hashedEnd + 2 + unhashedLength;
    const named = [...issuers(packet.subarray(6, hashedEnd)), ...issuers(packet.subarray(hashedEnd + 2, unhashedEnd))];
    // The signer must be named, and only as this key (its fingerprint or its key id).
    if (!named.length || named.some(id => id !== key.fingerprint && id !== key.fingerprint.slice(-16))) return false;
    const value = mpi(packet, unhashedEnd + 2);
    if (value.end !== packet.length) return false;
    const trailer = Buffer.alloc(6);
    trailer.writeUInt8(4, 0);
    trailer.writeUInt8(0xff, 1);
    trailer.writeUInt32BE(hashedEnd, 2);
    const signed = Buffer.concat([data, packet.subarray(0, hashedEnd), trailer]);
    // The quick check bytes must match before the RSA check.
    const digest = createHash(hash).update(signed).digest();
    if (digest[0] !== packet[unhashedEnd] || digest[1] !== packet[unhashedEnd + 1]) return false;
    // RSA signatures are left-padded to the modulus length.
    const size = ((key.key.asymmetricKeyDetails?.modulusLength ?? 0) + 7) >> 3;
    if (value.value.length > size) return false;
    const padded = Buffer.concat([Buffer.alloc(size - value.value.length), value.value]);
    return verify(hash, signed, key.key, padded);
  } catch {
    return false;
  }
}
