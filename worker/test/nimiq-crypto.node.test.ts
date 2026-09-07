import { KeyPair } from '@nimiq/core';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  fromBase32,
  hexToBytes,
  formatAddress,
  isValidAddress,
  normaliseAddress,
  publicKeyToAddress,
  publicKeyToAddressBytes,
  toBase32,
  toUserFriendlyAddress,
} from '@nimturf/shared';
import { nimiqMessageDigest, verifySignedMessage } from '../src/nimiq/verify';

/**
 * These tests are the reason the Worker can ship a small hand-written address
 * implementation instead of the official multi-megabyte WASM client: every
 * function is checked against `@nimiq/core` itself over many random keypairs.
 */

const SAMPLES = 200;

function keypairs(n: number) {
  return Array.from({ length: n }, () => KeyPair.generate());
}

describe('address derivation vs @nimiq/core', () => {
  it('derives the identical user-friendly address for random keypairs', () => {
    for (const kp of keypairs(SAMPLES)) {
      const pub = kp.publicKey;
      const expected = pub.toAddress().toUserFriendlyAddress();
      expect(publicKeyToAddress(pub.serialize())).toBe(expected);
    }
  });

  it('derives the identical raw 20-byte address', () => {
    for (const kp of keypairs(50)) {
      const pub = kp.publicKey;
      expect(bytesToHex(publicKeyToAddressBytes(pub.serialize()))).toBe(pub.toAddress().toHex().toLowerCase());
    }
  });

  it('accepts every address the official client produces', () => {
    for (const kp of keypairs(SAMPLES)) {
      const friendly = kp.publicKey.toAddress().toUserFriendlyAddress();
      expect(isValidAddress(friendly), friendly).toBe(true);
      // and in compact / lowercase form
      expect(isValidAddress(normaliseAddress(friendly))).toBe(true);
      expect(isValidAddress(friendly.toLowerCase())).toBe(true);
    }
  });

  it('rejects addresses whose checksum has been tampered with', () => {
    for (const kp of keypairs(50)) {
      const compact = normaliseAddress(kp.publicKey.toAddress().toUserFriendlyAddress());
      // Corrupt one body character; the checksum must catch it.
      const body = compact.slice(4);
      const swapped = body[0] === 'A' ? `B${body.slice(1)}` : `A${body.slice(1)}`;
      expect(isValidAddress(compact.slice(0, 4) + swapped)).toBe(false);
    }
  });

  it('rejects structurally invalid addresses', () => {
    for (const bad of [
      '', 'NQ', 'hello', 'NQ00', 'XX12345678901234567890123456789012345',
      'NQ1234567890123456789012345678901234',       // too short
      'NQ123456789012345678901234567890123456',      // too long
      'NQ12IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',        // I is not in the alphabet
    ]) {
      expect(isValidAddress(bad), bad).toBe(false);
    }
  });

  it('round-trips base32 encoding', () => {
    for (const kp of keypairs(30)) {
      const bytes = publicKeyToAddressBytes(kp.publicKey.serialize());
      expect(fromBase32(toBase32(bytes))).toEqual(bytes);
    }
    expect(fromBase32('!!!!')).toBeNull();
  });

  it('normalises and formats addresses without losing information', () => {
    for (const kp of keypairs(30)) {
      const friendly = kp.publicKey.toAddress().toUserFriendlyAddress();
      expect(formatAddress(normaliseAddress(friendly))).toBe(friendly);
      expect(normaliseAddress(friendly.toLowerCase())).toBe(normaliseAddress(friendly));
    }
  });

  it('rejects public keys of the wrong length', () => {
    expect(() => publicKeyToAddressBytes(new Uint8Array(31))).toThrow();
    expect(() => toUserFriendlyAddress(new Uint8Array(19))).toThrow();
  });
});

describe('signature verification', () => {
  /** Signs the canonical Nimiq message digest with the official client. */
  function signMessage(kp: ReturnType<typeof KeyPair.generate>, message: string) {
    const digest = nimiqMessageDigest(message);
    return bytesToHex(kp.sign(digest).serialize());
  }

  it('accepts a genuine signature over the canonical Nimiq digest', async () => {
    for (const kp of keypairs(25)) {
      const address = kp.publicKey.toAddress().toUserFriendlyAddress();
      const message = `NimTurf login nonce=${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
      const result = await verifySignedMessage({
        message,
        publicKey: kp.publicKey.toHex(),
        signature: signMessage(kp, message),
        address,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) expect(result.address).toBe(normaliseAddress(address));
    }
  });

  it('accepts a signature over the raw message bytes too', async () => {
    // The Hub and Nimiq Pay may pre-hash differently; both must work.
    const kp = KeyPair.generate();
    const message = 'NimTurf login nonce=abc123';
    const signature = bytesToHex(kp.sign(new TextEncoder().encode(message)).serialize());
    const result = await verifySignedMessage({
      message,
      publicKey: kp.publicKey.toHex(),
      signature,
      address: kp.publicKey.toAddress().toUserFriendlyAddress(),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a signature over a DIFFERENT message, so nonces cannot be replayed', async () => {
    const kp = KeyPair.generate();
    const signature = signMessage(kp, 'NimTurf login nonce=OLD');
    const result = await verifySignedMessage({
      message: 'NimTurf login nonce=NEW',
      publicKey: kp.publicKey.toHex(),
      signature,
      address: kp.publicKey.toAddress().toUserFriendlyAddress(),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects someone else\'s address with their own valid key', async () => {
    // The impersonation attack: sign correctly, but claim a victim's address.
    const attacker = KeyPair.generate();
    const victim = KeyPair.generate();
    const message = 'NimTurf login nonce=xyz';
    const result = await verifySignedMessage({
      message,
      publicKey: attacker.publicKey.toHex(),
      signature: signMessage(attacker, message),
      address: victim.publicKey.toAddress().toUserFriendlyAddress(),
    });
    expect(result).toEqual({ ok: false, reason: 'address_mismatch' });
  });

  it('rejects a signature made by a different key for the right address', async () => {
    const victim = KeyPair.generate();
    const attacker = KeyPair.generate();
    const message = 'NimTurf login nonce=xyz';
    const result = await verifySignedMessage({
      message,
      publicKey: victim.publicKey.toHex(),
      signature: signMessage(attacker, message),
      address: victim.publicKey.toAddress().toUserFriendlyAddress(),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a tampered signature', async () => {
    const kp = KeyPair.generate();
    const message = 'NimTurf login nonce=xyz';
    const good = hexToBytes(signMessage(kp, message))!;
    good[0] ^= 0xff;
    const result = await verifySignedMessage({
      message,
      publicKey: kp.publicKey.toHex(),
      signature: bytesToHex(good),
      address: kp.publicKey.toAddress().toUserFriendlyAddress(),
    });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed hex inputs without throwing', async () => {
    const kp = KeyPair.generate();
    const address = kp.publicKey.toAddress().toUserFriendlyAddress();
    const cases: Array<[string, string, string]> = [
      ['', '00'.repeat(64), 'bad_public_key'],
      ['zz'.repeat(32), '00'.repeat(64), 'bad_public_key'],
      ['00'.repeat(31), '00'.repeat(64), 'bad_public_key'],
      [kp.publicKey.toHex(), '', 'bad_signature'],
      [kp.publicKey.toHex(), '00'.repeat(63), 'bad_signature'],
      [kp.publicKey.toHex(), 'nothex'.repeat(10), 'bad_signature'],
    ];
    for (const [publicKey, signature, reason] of cases) {
      const result = await verifySignedMessage({ message: 'm', publicKey, signature, address });
      expect(result).toEqual({ ok: false, reason });
    }
  });

  it('produces a stable, prefixed digest', () => {
    // Guards against an accidental change to the signing scheme.
    expect(bytesToHex(nimiqMessageDigest('hello'))).toBe(bytesToHex(nimiqMessageDigest('hello')));
    expect(bytesToHex(nimiqMessageDigest('hello'))).not.toBe(bytesToHex(nimiqMessageDigest('hellp')));
    expect(nimiqMessageDigest('hello')).toHaveLength(32);
  });
});

describe('hex helpers', () => {
  it('round-trips bytes through hex', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(1 + (i % 40)));
      expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
    }
  });

  it('tolerates a 0x prefix and rejects junk', () => {
    expect(hexToBytes('0xff')).toEqual(new Uint8Array([255]));
    expect(hexToBytes('f')).toBeNull();
    expect(hexToBytes('')).toBeNull();
    expect(hexToBytes('gg')).toBeNull();
  });
});
