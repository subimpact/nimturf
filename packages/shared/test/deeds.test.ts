import { describe, expect, it } from 'vitest';
import { DEED_DATA_PREFIX, DEED_PRICE_LUNA } from '../src/constants';
import {
  DEED_FORMAT_VERSION,
  MAX_TX_DATA_BYTES,
  deedPriceLuna,
  encodeDeedData,
  formatNim,
  parseDeedData,
} from '../src/deeds';
import { TILE_COUNT } from '../src/constants';

describe('deed transaction data', () => {
  it('round-trips a claim through encode and parse', () => {
    const data = encodeDeedData('S1', 319);
    expect(data).toBe(`${DEED_DATA_PREFIX}:${DEED_FORMAT_VERSION}:S1:319`);
    expect(parseDeedData(data)).toEqual({ version: DEED_FORMAT_VERSION, seasonId: 'S1', tileId: 319 });
  });

  it('round-trips every tile id in the world', () => {
    for (let id = 0; id < TILE_COUNT; id++) {
      const parsed = parseDeedData(encodeDeedData('S1', id));
      expect(parsed?.tileId).toBe(id);
    }
  });

  it('always fits inside the 64-byte Nimiq data field', () => {
    const data = encodeDeedData('SEASON1234567890'.slice(0, 16), TILE_COUNT - 1);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(MAX_TX_DATA_BYTES);
  });

  it('rejects invalid season ids and tile ids when encoding', () => {
    expect(() => encodeDeedData('', 1)).toThrow();
    expect(() => encodeDeedData('has:colon', 1)).toThrow();
    expect(() => encodeDeedData('way-too-long-season-id', 1)).toThrow();
    expect(() => encodeDeedData('S1', -1)).toThrow();
    expect(() => encodeDeedData('S1', 1.5)).toThrow();
    expect(() => encodeDeedData('S1', NaN)).toThrow();
  });

  it('ignores transactions that are not NimTurf deeds', () => {
    // Unrelated payments to the treasury must never be mistaken for a deed.
    for (const bad of [
      null, undefined, '', 'hello', 'NIMTURF', 'NIMTURF:1:S1',
      'NIMTURF:1:S1:319:extra', 'OTHER:1:S1:319', 'NIMTURF:0:S1:319',
      'NIMTURF:x:S1:319', 'NIMTURF:1::319', 'NIMTURF:1:S1:abc',
      'NIMTURF:1:S1:-4', 'NIMTURF:1:S1:1.5', 'NIMTURF:1:has:colon',
    ]) {
      expect(parseDeedData(bad as string), `should reject: ${String(bad)}`).toBeNull();
    }
  });

  it('tolerates surrounding whitespace from the chain', () => {
    expect(parseDeedData('  NIMTURF:1:S1:7  ')?.tileId).toBe(7);
  });

  it('does not confuse a different season for the current one', () => {
    const parsed = parseDeedData(encodeDeedData('S2', 10));
    expect(parsed?.seasonId).toBe('S2');
  });
});

describe('deed pricing', () => {
  it('exposes a fixed, non-random price', () => {
    expect(deedPriceLuna()).toBe(DEED_PRICE_LUNA);
    expect(deedPriceLuna()).toBe(deedPriceLuna());
  });

  it('formats Luna as NIM', () => {
    expect(formatNim(200_000)).toBe('2');
    expect(formatNim(150_000)).toBe('1.5');
    expect(formatNim(1)).toBe('0.00001');
  });
});
