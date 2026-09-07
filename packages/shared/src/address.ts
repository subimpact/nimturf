import { blake2b } from '@noble/hashes/blake2';

/**
 * Nimiq address derivation, implemented directly rather than by pulling in the
 * multi-megabyte `@nimiq/core` WASM client, which would not fit comfortably in
 * a Cloudflare Worker bundle. `worker/test/nimiq-crypto.test.ts` cross-checks
 * every function here against the official client over hundreds of random
 * keypairs, so this stays a size optimisation and never a behaviour change.
 */

/** Nimiq's custom base32 alphabet. Excludes I, O, W and Z to avoid ambiguity. */
export const NIMIQ_BASE32_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY';

/** Country-style prefix on every user-friendly Nimiq address. */
const CCODE = 'NQ';

/** A raw Nimiq address is the first 20 bytes of the public key's Blake2b hash. */
export const ADDRESS_BYTES = 20;

/** Encodes bytes with Nimiq's base32 alphabet. */
export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += NIMIQ_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += NIMIQ_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes a Nimiq base32 string back to bytes. Returns null on bad input. */
export function fromBase32(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input) {
    const idx = NIMIQ_BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/**
 * The IBAN mod-97-10 checksum Nimiq borrows for its addresses. Letters map to
 * their position in the alphabet plus 9 (A = 10), and the number is reduced in
 * 6-digit chunks to stay inside safe integer range.
 */
function ibanCheck(str: string): number {
  let num = '';
  for (const c of str.toUpperCase()) {
    const code = c.charCodeAt(0);
    num += code >= 48 && code <= 57 ? c : String(code - 55);
  }
  let tmp = '';
  for (let i = 0; i < Math.ceil(num.length / 6); i++) {
    tmp = String(Number(tmp + num.substr(i * 6, 6)) % 97);
  }
  return Number(tmp);
}

/** Formats 20 raw address bytes as a spaced user-friendly address. */
export function toUserFriendlyAddress(bytes: Uint8Array, withSpaces = true): string {
  if (bytes.length !== ADDRESS_BYTES) {
    throw new Error(`Nimiq address must be ${ADDRESS_BYTES} bytes, got ${bytes.length}`);
  }
  const base32 = toBase32(bytes);
  const check = `00${98 - ibanCheck(`${base32}${CCODE}00`)}`.slice(-2);
  const res = `${CCODE}${check}${base32}`;
  return withSpaces ? res.replace(/.{4}/g, '$& ').trim() : res;
}

/** Derives the raw 20-byte address from a 32-byte Ed25519 public key. */
export function publicKeyToAddressBytes(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) {
    throw new Error(`Nimiq public key must be 32 bytes, got ${publicKey.length}`);
  }
  return blake2b(publicKey, { dkLen: 32 }).subarray(0, ADDRESS_BYTES);
}

/** Derives the user-friendly address from a 32-byte Ed25519 public key. */
export function publicKeyToAddress(publicKey: Uint8Array): string {
  return toUserFriendlyAddress(publicKeyToAddressBytes(publicKey));
}

/**
 * Canonical form used as the database key: uppercase, no spaces. Wallets hand
 * back addresses with spaces and mixed case, and one player must never end up
 * with two accounts because of formatting.
 */
export function normaliseAddress(address: string): string {
  return address.replace(/\s+/g, '').toUpperCase();
}

/** Re-adds the conventional 4-character grouping for display. */
export function formatAddress(address: string): string {
  return normaliseAddress(address).replace(/.{4}/g, '$& ').trim();
}

/**
 * Validates a user-friendly Nimiq address, including its checksum. Rejecting
 * malformed addresses early keeps junk out of the database and out of the
 * leaderboard.
 */
export function isValidAddress(address: string): boolean {
  const compact = normaliseAddress(address);
  if (!/^NQ\d{2}[0-9A-Z]{32}$/.test(compact)) return false;
  if (!compact.slice(4).split('').every((c) => NIMIQ_BASE32_ALPHABET.includes(c))) return false;
  return ibanCheck(`${compact.slice(4)}${compact.slice(0, 4)}`) === 1;
}
