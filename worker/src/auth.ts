import { bytesToHex } from '@nimturf/shared';

/**
 * Stateless session tokens.
 *
 * A session is just the player's address plus an expiry, HMAC-signed with a
 * server secret. Nothing secret lives in the token, and a tampered token fails
 * verification, so the API can authenticate a request without a round trip to
 * storage.
 */

const encoder = new TextEncoder();

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    const str = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Constant-time comparison, so token checking cannot be timed. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Issues a session token for an address. */
export async function createSessionToken(address: string, secret: string, now = Date.now()): Promise<string> {
  const payload = JSON.stringify({ a: address, e: Math.floor(now / 1000) + SESSION_TTL_SECONDS });
  const body = base64UrlEncode(encoder.encode(payload));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `${body}.${base64UrlEncode(sig)}`;
}

/** Returns the address a token authenticates, or null if it is invalid or expired. */
export async function verifySessionToken(token: string, secret: string, now = Date.now()): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sigPart] = parts;

  const provided = base64UrlDecode(sigPart);
  if (!provided) return null;

  const key = await hmacKey(secret);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  if (!timingSafeEqual(provided, expected)) return null;

  const raw = base64UrlDecode(body);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as { a?: unknown; e?: unknown };
    if (typeof parsed.a !== 'string' || typeof parsed.e !== 'number') return null;
    if (parsed.e * 1000 <= now) return null;
    return parsed.a;
  } catch {
    return null;
  }
}

/** How long a login challenge stays valid. Short, to limit replay windows. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

export function createNonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The exact text the user is asked to sign in their wallet.
 *
 * It is written to be readable in a wallet confirmation dialog: someone should
 * be able to tell at a glance that they are signing in to NimTurf and not
 * authorising a payment. The nonce is what makes each signature single-use.
 */
export function buildChallengeMessage(input: { nonce: string; seasonId: string; issuedAt: number }): string {
  return [
    'NimTurf sign-in',
    `Season: ${input.seasonId}`,
    `Nonce: ${input.nonce}`,
    `Issued: ${new Date(input.issuedAt).toISOString()}`,
    'Signing this proves you own this address. It does not move any funds.',
  ].join('\n');
}


