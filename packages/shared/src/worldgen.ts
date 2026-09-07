import { TERRAINS, WORLD_SIZE, type Terrain } from './constants';
import type { TileId } from './types';

/**
 * Deterministic world generation.
 *
 * The map is a pure function of the season seed, so every player and the
 * server derive byte-identical terrain without shipping the map around. Note
 * this is *generation*, not gameplay: the board is fixed and fully visible
 * before anyone moves, exactly like the board of a strategy game. No gameplay
 * outcome in NimTurf is ever decided by a random number.
 */

/** 32-bit integer hash. Uses Math.imul so it is exact in every JS engine. */
export function hash32(seed: number, x: number, y: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** hash32 mapped to [0, 1). */
function unit(seed: number, x: number, y: number): number {
  return hash32(seed, x, y) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise sampled on a lattice of the given cell size. */
function valueNoise(seed: number, x: number, y: number, cell: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = smooth((x - gx * cell) / cell);
  const fy = smooth((y - gy * cell) / cell);

  const v00 = unit(seed, gx, gy);
  const v10 = unit(seed, gx + 1, gy);
  const v01 = unit(seed, gx, gy + 1);
  const v11 = unit(seed, gx + 1, gy + 1);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Raw "built-up density" for a tile: two octaves of value noise. Districts
 * rather than salt-and-pepper noise, plus a fine detail octave.
 */
function density(seed: number, x: number, y: number): number {
  const base = valueNoise(seed, x, y, 6);
  const detail = valueNoise(seed ^ 0x9e3779b9, x, y, 3);
  return base * 0.7 + detail * 0.3;
}

/** How central a tile is: 1 at the middle of the board, 0 at the edge. */
function centralityAt(x: number, y: number): number {
  const cx = (WORLD_SIZE - 1) / 2;
  const distance = Math.max(Math.abs(x - cx), Math.abs(y - cx)) / cx;
  return 1 - distance;
}

/** True for tiles on the deterministic waterfront that crosses the board. */
function isDocks(seed: number, x: number, y: number): boolean {
  const riverY =
    (Math.sin((x / WORLD_SIZE) * Math.PI * 2 + (seed % 360) / 57.29) * 0.5 + 0.5) * (WORLD_SIZE - 6) + 3;
  return Math.abs(y - riverY) < 1.1;
}

/**
 * Generates the terrain for a season.
 *
 * Terrain is assigned by *rank*, not by absolute noise thresholds. The mean of
 * the noise field shifts from seed to seed, and an earlier version that keyed
 * off absolute thresholds produced boards ranging from 25% parks to 1.5% -
 * and occasionally a board with almost no markets at all. Since markets are
 * the highest-yielding ground and towers the most defensible, that handed out
 * materially different games before anyone had moved. Ranking the tiles makes
 * the proportions the same on every seed while keeping the layout unique, so
 * each season plays differently but never unfairly.
 */
export function generateTerrain(seed: number): Terrain[] {
  const out: Terrain[] = new Array(WORLD_SIZE * WORLD_SIZE);

  // The waterfront is positional, so it is settled first and excluded from
  // the ranking below.
  const ranked: number[] = [];
  const densities = new Float64Array(WORLD_SIZE * WORLD_SIZE);

  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const id = tileId(x, y);
      if (isDocks(seed, x, y)) {
        out[id] = 'docks';
        continue;
      }
      densities[id] = density(seed, x, y);
      ranked.push(id);
    }
  }

  // Deterministic order: by density, with the tile id breaking ties so the
  // result never depends on sort implementation details.
  ranked.sort((a, b) => densities[a] - densities[b] || a - b);

  const total = ranked.length;
  const percentile = new Float64Array(WORLD_SIZE * WORLD_SIZE);
  for (let i = 0; i < total; i++) percentile[ranked[i]] = total <= 1 ? 0.5 : i / (total - 1);

  /*
   * Each terrain gets a fixed share of the non-waterfront tiles, taken by
   * rank. Selecting by proportion rather than by threshold is what makes the
   * board fair on every seed: an earlier version could hand out a season with
   * only seven market tiles when the river happened to run through the centre
   * and swallow the ground markets would otherwise occupy.
   */
  const MARKET_SHARE = 0.12;
  const PARK_SHARE = 0.26;
  const TOWER_SHARE = 0.35;

  const remaining = new Set(ranked);
  const take = (
    pool: Set<number>,
    count: number,
    score: (id: number) => number,
    terrain: Terrain,
  ): void => {
    const candidates = [...pool].sort((a, b) => score(b) - score(a) || a - b);
    for (const id of candidates.slice(0, Math.max(0, count))) {
      out[id] = terrain;
      pool.delete(id);
    }
  };

  // Markets: the densest central ground. Centrality is weighted heavily so
  // they still cluster downtown rather than scattering.
  take(remaining, Math.round(total * MARKET_SHARE), (id) => {
    const { x, y } = tileXY(id);
    return percentile[id] * 0.55 + centralityAt(x, y) * 0.45;
  }, 'market');

  // Parks: the least built-up ground left.
  take(remaining, Math.round(remaining.size * PARK_SHARE), (id) => -percentile[id], 'park');

  // Towers: the densest of what remains, biased to the outskirts.
  take(remaining, Math.round(remaining.size * TOWER_SHARE), (id) => {
    const { x, y } = tileXY(id);
    return percentile[id] * 0.7 + (1 - centralityAt(x, y)) * 0.3;
  }, 'tower');

  // Everything else is ordinary city block.
  for (const id of remaining) out[id] = 'concrete';

  return out;
}

/**
 * Terrain of a single tile.
 *
 * Terrain is assigned by rank across the whole board, so a single tile cannot
 * be derived in isolation; the map for a seed is generated once and cached.
 * Seeds are per season, so this cache holds one or two entries in practice.
 */
const terrainCache = new Map<number, Terrain[]>();

export function terrainAt(seed: number, x: number, y: number): Terrain {
  let map = terrainCache.get(seed);
  if (!map) {
    map = generateTerrain(seed);
    // Guard against unbounded growth if this is ever called with many seeds.
    if (terrainCache.size > 8) terrainCache.clear();
    terrainCache.set(seed, map);
  }
  return map[tileId(x, y)];
}

export function tileId(x: number, y: number): TileId {
  return y * WORLD_SIZE + x;
}

export function tileXY(id: TileId): { x: number; y: number } {
  return { x: id % WORLD_SIZE, y: Math.floor(id / WORLD_SIZE) };
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < WORLD_SIZE && y < WORLD_SIZE;
}

/** Orthogonally adjacent tile ids. Diagonals deliberately do not count, which
 * makes territory shape matter. */
export function neighbourIds(id: TileId): TileId[] {
  const { x, y } = tileXY(id);
  const out: TileId[] = [];
  if (inBounds(x - 1, y)) out.push(tileId(x - 1, y));
  if (inBounds(x + 1, y)) out.push(tileId(x + 1, y));
  if (inBounds(x, y - 1)) out.push(tileId(x, y - 1));
  if (inBounds(x, y + 1)) out.push(tileId(x, y + 1));
  return out;
}

export { TERRAINS };

/**
 * Short human label for a tile, e.g. "E5". Used in the UI and in the event
 * messages the server writes, so both must derive it the same way.
 */
export function tileLabel(id: TileId): string {
  const { x, y } = tileXY(id);
  return `${String.fromCharCode(65 + (x % 26))}${y + 1}`;
}
