import {
  ADJACENCY_BONUS_BP,
  ADJACENCY_MAX,
  ALLY_ADJACENCY_BONUS_BP,
  BASE_CLAIM_SCRAP,
  BASE_DEFENSE_SCRAP,
  BP,
  CLAIM_ESCALATION_BP,
  DEED_YIELD_BONUS_BP,
  LEVEL_DEFENSE_BP,
  LEVEL_YIELD_BP,
  MAX_LEVEL,
  OFFLINE_CAP_SECONDS,
  TERRAIN_STATS,
  UPGRADE_COST_SCRAP,
} from './constants';
import type { Tile } from './types';
import { neighbourIds } from './worldgen';

/**
 * The economy is deliberately expressed in integers end to end. Every helper
 * here is a pure function of its arguments, which is what lets the browser
 * predict the exact number the server will later confirm.
 */

/** Number of orthogonal neighbours of `tile` owned by `address`, and by allies. */
export function countAdjacency(
  tile: Tile,
  tiles: readonly Tile[],
  address: string,
  allyAddresses: ReadonlySet<string> | null,
): { own: number; ally: number } {
  let own = 0;
  let ally = 0;
  for (const nid of neighbourIds(tile.id)) {
    const owner = tiles[nid]?.owner;
    if (!owner) continue;
    if (owner === address) own++;
    else if (allyAddresses?.has(owner)) ally++;
  }
  return { own, ally };
}

/**
 * Scrap per second produced by one tile.
 *
 * yield = terrainBase x levelMultiplier x (1 + adjacency) x (1 + deed)
 */
export function tileYieldPerSec(
  tile: Tile,
  tiles: readonly Tile[],
  now: number,
  allyAddresses: ReadonlySet<string> | null = null,
): number {
  if (!tile.owner) return 0;

  const base = TERRAIN_STATS[tile.terrain].yieldScrap;
  const level = clampLevel(tile.level);

  const { own, ally } = countAdjacency(tile, tiles, tile.owner, allyAddresses);
  const adjacency =
    Math.min(own, ADJACENCY_MAX) * ADJACENCY_BONUS_BP +
    Math.min(Math.max(ADJACENCY_MAX - own, 0), ally) * ALLY_ADJACENCY_BONUS_BP;

  const deed = tile.deedUntil > now ? DEED_YIELD_BONUS_BP : 0;

  let v = base * LEVEL_YIELD_BP[level];          // scrap * bp
  v = Math.floor((v * (BP + adjacency)) / BP);   // apply adjacency
  v = Math.floor((v * (BP + deed)) / BP);        // apply deed
  return Math.floor(v / BP);                     // back to scrap/sec
}

/** Total scrap per second across every tile owned by `address`. */
export function playerYieldPerSec(
  tiles: readonly Tile[],
  address: string,
  now: number,
  allyAddresses: ReadonlySet<string> | null = null,
): number {
  let total = 0;
  for (const tile of tiles) {
    if (tile.owner === address) total += tileYieldPerSec(tile, tiles, now, allyAddresses);
  }
  return total;
}

/**
 * Scrap accrued between `settledAt` and `now` at a fixed rate.
 *
 * Time away is capped at OFFLINE_CAP_SECONDS. Capping per settle rather than
 * per session means an active player never loses anything, while someone
 * returning after a week gets a healthy - but not game-breaking - lump sum.
 */
export function accrue(ratePerSec: number, settledAt: number, now: number): number {
  if (now <= settledAt || ratePerSec <= 0) return 0;
  const elapsedMs = Math.min(now - settledAt, OFFLINE_CAP_SECONDS * 1000);
  return Math.floor((ratePerSec * elapsedMs) / 1000);
}

/**
 * Clamps a tile level into range. Non-finite input deliberately falls back to
 * the minimum rather than the maximum, so corrupted state can never award a
 * free max-level tile.
 */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(Math.max(Math.trunc(level), 1), MAX_LEVEL);
}

/** Cost to upgrade a tile from its current level to the next one. */
export function upgradeCost(tile: Tile): number | null {
  const level = clampLevel(tile.level);
  if (level >= MAX_LEVEL) return null;
  const terrainBp = TERRAIN_STATS[tile.terrain].claimBp;
  return Math.floor((UPGRADE_COST_SCRAP[level] * terrainBp) / BP);
}

/**
 * Cost to claim an unowned tile. Rises 8% (compounding) per tile already held,
 * so wide empires pay for their width and tall play stays viable.
 */
export function claimCost(tile: Tile, ownedTileCount: number): number {
  const terrainBp = TERRAIN_STATS[tile.terrain].claimBp;
  let cost = Math.floor((BASE_CLAIM_SCRAP * terrainBp) / BP);
  // Compounding escalation, applied with integer math for determinism.
  for (let i = 0; i < ownedTileCount; i++) {
    cost = Math.floor((cost * (BP + CLAIM_ESCALATION_BP)) / BP);
    // Guard against unbounded growth on absurd empires.
    if (cost > Number.MAX_SAFE_INTEGER / 2) break;
  }
  return cost;
}

/** The scrap an attacker must exceed to take this tile, before reinforcement. */
export function tileDefense(tile: Tile): number {
  const level = clampLevel(tile.level);
  const terrainBp = TERRAIN_STATS[tile.terrain].defenseBp;
  let v = BASE_DEFENSE_SCRAP * LEVEL_DEFENSE_BP[level];
  v = Math.floor((v * terrainBp) / BP);
  return Math.floor(v / BP);
}

/**
 * Formats a TURF amount for display.
 *
 * Big numbers get a suffix, small ones keep enough decimals to still show
 * movement - a counter that appears frozen makes an idle game feel broken.
 */
export function formatTurf(turf: number): string {
  if (!Number.isFinite(turf)) return '0';
  const v = turf;
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(2)}K`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** Formats a scrap/second rate for the HUD. */
export function formatRate(scrapPerSec: number): string {
  return `${formatTurf(scrapPerSec)}/s`;
}
