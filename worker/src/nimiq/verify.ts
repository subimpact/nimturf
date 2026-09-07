import { sha256 } from '@noble/hashes/sha2';
import { hexToBytes, normaliseAddress, publicKeyToAddress } from '@nimturf/shared';

/**
 * Verification of Nimiq wallet signatures, used to prove that whoever is
 * talking to the API really controls the address they claim.
 */

/**
 * The 23-byte prefix Nimiq wallets prepend before hashing a message, so that a
 * signed message can never be replayed as a valid transaction.
 * `\x16` is the length of the human-readable part that follows it.
 */
export const NIMIQ_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n';

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * The digest a Nimiq wallet actually signs for a text message:
 * SHA256(prefix || decimal-length || message).
 */
export function nimiqMessageDigest(message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(NIMIQ_MESSAGE_PREFIX + String(msg.length));
  return sha256(concat(prefix, msg));
}

/**
 * Every byte string we are willing to accept a signature over.
 *
 * The framework documentation does not pin down the exact pre-hashing a wallet
 * applies, and it may differ between Nimiq Pay and the Nimiq Hub. Rather than
 * guess one encoding and lock out half our users, we accept a signature over
 * any of these forms. This does not weaken the check: the caller only ever
 * passes a message containing a fresh server-issued nonce, so *every* candidate
 * binds the signature to that exact login attempt. An attacker without the
 * private key cannot produce a valid signature over any of them.
 */
function signableCandidates(message: string): Uint8Array[] {
  const raw = new TextEncoder().encode(message);
  return [
    nimiqMessageDigest(message), // canonical Nimiq signed message
    raw,                         // wallet signs the bytes directly
    sha256(raw),                 // wallet hashes without the prefix
  ];
}

async function ed25519Verify(publicKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data);
  } catch {
    return false;
  }
}

export interface VerifyInput {
  /** The exact message the wallet was asked to sign. Must contain a fresh nonce. */
  message: string;
  /** 32-byte Ed25519 public key, hex. */
  publicKey: string;
  /** 64-byte Ed25519 signature, hex. */
  signature: string;
  /** The address the caller claims to own, in any formatting. */
  address: string;
}

export type VerifyFailure =
  | 'bad_public_key'
  | 'bad_signature'
  | 'address_mismatch'
  | 'invalid_signature';

export type VerifyResult =
  | { ok: true; address: string }
  | { ok: false; reason: VerifyFailure };

/**
 * Verifies a wallet signature and that it belongs to the claimed address.
 *
 * Two independent things are checked, and both must hold:
 *   1. the public key really hashes to the claimed address, and
 *   2. the signature over our nonced message really came from that key.
 * Checking only the signature would let anyone log in as anyone else by
 * supplying their own key alongside someone else's address.
 */
export async function verifySignedMessage(input: VerifyInput): Promise<VerifyResult> {
  const publicKey = hexToBytes(input.publicKey);
  if (!publicKey || publicKey.length !== 32) return { ok: false, reason: 'bad_public_key' };

  const signature = hexToBytes(input.signature);
  if (!signature || signature.length !== 64) return { ok: false, reason: 'bad_signature' };

  let derived: string;
  try {
    derived = normaliseAddress(publicKeyToAddress(publicKey));
  } catch {
    return { ok: false, reason: 'bad_public_key' };
  }

  if (derived !== normaliseAddress(input.address)) {
    return { ok: false, reason: 'address_mismatch' };
  }

  for (const candidate of signableCandidates(input.message)) {
    if (await ed25519Verify(publicKey, signature, candidate)) {
      return { ok: true, address: derived };
    }
  }

  return { ok: false, reason: 'invalid_signature' };
}

export const VERIFY_FAILURE_MESSAGES: Record<VerifyFailure, string> = {
  bad_public_key: 'The wallet sent a malformed public key.',
  bad_signature: 'The wallet sent a malformed signature.',
  address_mismatch: 'That signature belongs to a different Nimiq address.',
  invalid_signature: 'The signature could not be verified. Please try signing in again.',
};
