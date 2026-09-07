import { DEED_DATA_PREFIX, DEED_PRICE_LUNA } from './constants';
import type { TileId } from './types';

/**
 * Deeds: the on-chain half of NimTurf.
 *
 * Minting a deed sends a real NIM transaction whose data field records which
 * tile is being claimed. The server only grants the deed after it has found
 * that transaction on the Nimiq blockchain, so ownership of a deeded tile is
 * independently verifiable by anyone with a block explorer - the game cannot
 * fake it and neither can a player.
 */

/** Wire format version, so old deeds stay parseable if the format evolves. */
export const DEED_FORMAT_VERSION = 1;

/** Nimiq basic transactions carry at most 64 bytes of data. */
export const MAX_TX_DATA_BYTES = 64;

export interface DeedClaim {
  version: number;
  seasonId: string;
  tileId: TileId;
}

/**
 * Builds the transaction data field for a deed.
 * Example: `NIMTURF:1:S1:319`
 */
export function encodeDeedData(seasonId: string, tileId: TileId): string {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(seasonId)) {
    throw new Error(`Invalid seasonId for deed data: ${seasonId}`);
  }
  if (!Number.isInteger(tileId) || tileId < 0) {
    throw new Error(`Invalid tileId for deed data: ${tileId}`);
  }
  const data = `${DEED_DATA_PREFIX}:${DEED_FORMAT_VERSION}:${seasonId}:${tileId}`;
  if (new TextEncoder().encode(data).length > MAX_TX_DATA_BYTES) {
    throw new Error('Deed data exceeds the 64 byte Nimiq transaction data limit');
  }
  return data;
}

/**
 * Parses a transaction data field back into a deed claim.
 * Returns null for anything that is not a well-formed NimTurf deed, so
 * unrelated transactions to the treasury are ignored rather than trusted.
 */
export function parseDeedData(data: string | null | undefined): DeedClaim | null {
  if (typeof data !== 'string') return null;
  const parts = data.trim().split(':');
  if (parts.length !== 4) return null;
  const [prefix, versionRaw, seasonId, tileIdRaw] = parts;
  if (prefix !== DEED_DATA_PREFIX) return null;

  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) return null;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(seasonId)) return null;

  const tileId = Number(tileIdRaw);
  if (!Number.isInteger(tileId) || tileId < 0) return null;

  return { version, seasonId, tileId };
}

/** Luna required for a deed. Exposed as a function so pricing can later vary
 * by tile without changing any call site. */
export function deedPriceLuna(): number {
  return DEED_PRICE_LUNA;
}

/** Formats Luna as a NIM string for display. 1 NIM = 100000 Luna. */
export function formatNim(luna: number): string {
  return (luna / 1e5).toLocaleString('en-US', { maximumFractionDigits: 5 });
}
