import { WORLD_SIZE, type Terrain } from '../src/constants';
import type { Siege, Tile } from '../src/types';
import { generateTerrain, tileId } from '../src/worldgen';

/** Builds a full, empty world of the given seed for use in tests. */
export function makeWorld(seed = 1): Tile[] {
  const terrain = generateTerrain(seed);
  const tiles: Tile[] = [];
  for (let i = 0; i < WORLD_SIZE * WORLD_SIZE; i++) {
    tiles.push({
      id: i,
      x: i % WORLD_SIZE,
      y: Math.floor(i / WORLD_SIZE),
      terrain: terrain[i],
      owner: null,
      level: 1,
      settledAt: 0,
      capturedAt: 0,
      deedUntil: 0,
      deedTxHash: null,
    });
  }
  return tiles;
}

/** Forces a tile to a known terrain so economy tests are not coupled to worldgen. */
export function setTile(
  tiles: Tile[],
  x: number,
  y: number,
  patch: Partial<Tile> & { terrain?: Terrain },
): Tile {
  const t = tiles[tileId(x, y)];
  Object.assign(t, patch);
  return t;
}

export function makeSiege(patch: Partial<Siege> = {}): Siege {
  return {
    id: 's1',
    tileId: 0,
    attacker: 'ATTACKER',
    defender: 'DEFENDER',
    pressure: 0,
    reinforcement: 0,
    baseDefense: 1000,
    startedAt: 0,
    resolvesAt: 1000,
    state: 'active',
    resolvedAt: null,
    ...patch,
  };
}
