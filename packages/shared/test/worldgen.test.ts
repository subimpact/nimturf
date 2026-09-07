import { describe, expect, it } from 'vitest';
import { TERRAINS, WORLD_SIZE } from '../src/constants';
import { generateTerrain, hash32, inBounds, neighbourIds, terrainAt, tileId, tileXY } from '../src/worldgen';

describe('worldgen', () => {
  it('is deterministic: the same seed always produces the same map', () => {
    const a = generateTerrain(12345);
    const b = generateTerrain(12345);
    expect(a).toEqual(b);
  });

  it('produces different maps for different seeds', () => {
    const a = generateTerrain(1);
    const b = generateTerrain(2);
    expect(a).not.toEqual(b);
  });

  it('hash32 stays within uint32 and is stable', () => {
    for (let i = 0; i < 50; i++) {
      const h = hash32(7, i, i * 3);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
      expect(hash32(7, i, i * 3)).toBe(h);
    }
  });

  it('only ever emits known terrain types', () => {
    const map = generateTerrain(99);
    expect(map).toHaveLength(WORLD_SIZE * WORLD_SIZE);
    for (const t of map) expect(TERRAINS).toContain(t);
  });

  it('uses every terrain type on a full map, so no terrain is dead content', () => {
    const map = generateTerrain(4242);
    const present = new Set(map);
    for (const t of TERRAINS) expect(present).toContain(t);
  });

  it('round-trips tile ids and coordinates', () => {
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        expect(tileXY(tileId(x, y))).toEqual({ x, y });
      }
    }
  });

  it('terrainAt agrees with the generated map at every tile', () => {
    const seed = 555;
    const map = generateTerrain(seed);
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        expect(map[tileId(x, y)]).toBe(terrainAt(seed, x, y));
      }
    }
  });

  it('gives corners 2 neighbours, edges 3 and the interior 4', () => {
    expect(neighbourIds(tileId(0, 0))).toHaveLength(2);
    expect(neighbourIds(tileId(WORLD_SIZE - 1, WORLD_SIZE - 1))).toHaveLength(2);
    expect(neighbourIds(tileId(0, 5))).toHaveLength(3);
    expect(neighbourIds(tileId(5, 5))).toHaveLength(4);
  });

  it('never returns out-of-bounds neighbours', () => {
    for (let i = 0; i < WORLD_SIZE * WORLD_SIZE; i++) {
      for (const n of neighbourIds(i)) {
        const { x, y } = tileXY(n);
        expect(inBounds(x, y)).toBe(true);
        expect(n).not.toBe(i);
      }
    }
  });

  it('neighbour relationships are symmetric', () => {
    for (let i = 0; i < WORLD_SIZE * WORLD_SIZE; i++) {
      for (const n of neighbourIds(i)) {
        expect(neighbourIds(n)).toContain(i);
      }
    }
  });

  it('gives every season a fair strategic menu, on any seed', () => {
    /*
     * This is a fairness guard, not a cosmetic one. Markets are the highest
     * yielding ground and towers the most defensible, so a seed that happens
     * to generate almost no markets would hand out a materially different -
     * and worse - game before anyone had moved. Checking many seeds keeps
     * that from slipping back in.
     */
    for (let seed = 1; seed <= 60; seed++) {
      const map = generateTerrain(seed * 7919);
      const counts = new Map<string, number>();
      for (const t of map) counts.set(t, (counts.get(t) ?? 0) + 1);
      const share = (t: string) => (counts.get(t) ?? 0) / map.length;

      // Every terrain is common enough to build a strategy around. This is
      // the part that actually matters for fairness, and it is guaranteed by
      // assigning terrain in fixed proportions rather than by threshold.
      for (const t of TERRAINS) {
        expect(share(t), `seed ${seed} ${t}`).toBeGreaterThan(0.08);
      }

      // And the board still reads as a city: ordinary built-up ground is the
      // most common terrain on every seed.
      const largest = TERRAINS.reduce((a, b) => (share(a) >= share(b) ? a : b));
      expect(largest, `seed ${seed} most common terrain`).toBe('concrete');
      expect(share('concrete'), `seed ${seed} concrete`).toBeGreaterThan(0.3);
    }
  });

  it('runs a waterfront across the board, creating contested chokepoints', () => {
    const map = generateTerrain(20260907);
    // Docks should appear on most columns: it is a river, not a puddle.
    let columnsWithDocks = 0;
    for (let x = 0; x < WORLD_SIZE; x++) {
      for (let y = 0; y < WORLD_SIZE; y++) {
        if (map[tileId(x, y)] === 'docks') {
          columnsWithDocks++;
          break;
        }
      }
    }
    expect(columnsWithDocks).toBeGreaterThan(WORLD_SIZE * 0.7);
  });

});
