import { describe, expect, it } from 'vitest';
import {
  ADJACENCY_MAX,
  BASE_DEFENSE_SCRAP,
  DEED_YIELD_BONUS_BP,
  MAX_LEVEL,
  OFFLINE_CAP_SECONDS,
  TERRAIN_STATS,
} from '../src/constants';
import {
  accrue,
  claimCost,
  clampLevel,
  countAdjacency,
  formatRate,
  formatTurf,
  playerYieldPerSec,
  tileDefense,
  tileYieldPerSec,
  upgradeCost,
} from '../src/economy';
import { makeWorld, setTile } from './helpers';

const ME = 'NQ01 ME';
const THEM = 'NQ02 THEM';

describe('tileYieldPerSec', () => {
  it('yields nothing for an unowned tile', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 5, 5, { terrain: 'market', owner: null });
    expect(tileYieldPerSec(t, tiles, 0)).toBe(0);
  });

  it('pays the terrain base rate at level 1 with no neighbours', () => {
    const tiles = makeWorld();
    // Isolate the tile: clear its neighbours so adjacency cannot apply.
    const t = setTile(tiles, 5, 5, { terrain: 'concrete', owner: ME, level: 1 });
    expect(tileYieldPerSec(t, tiles, 0)).toBe(TERRAIN_STATS.concrete.yieldScrap);
  });

  it('scales yield up with level, monotonically', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 5, 5, { terrain: 'concrete', owner: ME, level: 1 });
    let prev = 0;
    for (let level = 1; level <= MAX_LEVEL; level++) {
      t.level = level;
      const y = tileYieldPerSec(t, tiles, 0);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
  });

  it('adds an adjacency bonus for each owned orthogonal neighbour', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 5, 5, { terrain: 'concrete', owner: ME, level: 1 });
    const alone = tileYieldPerSec(t, tiles, 0);

    setTile(tiles, 4, 5, { owner: ME });
    const withOne = tileYieldPerSec(t, tiles, 0);
    expect(withOne).toBeGreaterThan(alone);

    setTile(tiles, 6, 5, { owner: ME });
    const withTwo = tileYieldPerSec(t, tiles, 0);
    expect(withTwo).toBeGreaterThan(withOne);
  });

  it('ignores diagonal neighbours, so territory shape matters', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 5, 5, { terrain: 'concrete', owner: ME, level: 1 });
    const alone = tileYieldPerSec(t, tiles, 0);
    setTile(tiles, 4, 4, { owner: ME });
    setTile(tiles, 6, 6, { owner: ME });
    expect(tileYieldPerSec(t, tiles, 0)).toBe(alone);
  });

  it('gives an enemy neighbour no bonus', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 5, 5, { terrain: 'concrete', owner: ME, level: 1 });
    const alone = tileYieldPerSec(t, tiles, 0);
    setTile(tiles, 4, 5, { owner: THEM });
    expect(tileYieldPerSec(t, tiles, 0)).toBe(alone);
  });

  it('gives allies half the adjacency bonus of your own tiles', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 5, 5, { terrain: 'concrete', owner: ME, level: 5 });
    const alone = tileYieldPerSec(t, tiles, 0);

    setTile(tiles, 4, 5, { owner: THEM });
    const withAlly = tileYieldPerSec(t, tiles, 0, new Set([THEM]));
    expect(withAlly).toBeGreaterThan(alone);

    setTile(tiles, 4, 5, { owner: ME });
    const withOwn = tileYieldPerSec(t, tiles, 0);
    expect(withAlly).toBeLessThan(withOwn);
  });

  it('caps the adjacency bonus at four neighbours', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 5, 5, { terrain: 'concrete', owner: ME, level: 8 });
    for (const [x, y] of [[4, 5], [6, 5], [5, 4], [5, 6]]) setTile(tiles, x, y, { owner: ME });
    const { own } = countAdjacency(t, tiles, ME, null);
    expect(own).toBe(ADJACENCY_MAX);
  });

  it('applies the deed bonus only while the deed is unexpired', () => {
    const tiles = makeWorld();
    const now = 1_000_000;
    const t = setTile(tiles, 5, 5, { terrain: 'concrete', owner: ME, level: 6 });
    const plain = tileYieldPerSec(t, tiles, now);

    t.deedUntil = now + 1000;
    const deeded = tileYieldPerSec(t, tiles, now);
    expect(deeded).toBeGreaterThan(plain);
    // +25% within integer rounding.
    expect(deeded).toBeCloseTo(Math.floor((plain * (10000 + DEED_YIELD_BONUS_BP)) / 10000), -1);

    t.deedUntil = now - 1;
    expect(tileYieldPerSec(t, tiles, now)).toBe(plain);
  });

  it('always returns an integer', () => {
    const tiles = makeWorld();
    for (const terrain of Object.keys(TERRAIN_STATS) as (keyof typeof TERRAIN_STATS)[]) {
      const t = setTile(tiles, 10, 10, { terrain, owner: ME, level: 7, deedUntil: 9e15 });
      setTile(tiles, 9, 10, { owner: ME });
      const y = tileYieldPerSec(t, tiles, 0);
      expect(Number.isInteger(y)).toBe(true);
    }
  });
});

describe('playerYieldPerSec', () => {
  it('sums only the tiles the player owns', () => {
    const tiles = makeWorld();
    setTile(tiles, 1, 1, { terrain: 'concrete', owner: ME, level: 1 });
    setTile(tiles, 20, 20, { terrain: 'concrete', owner: ME, level: 1 });
    setTile(tiles, 10, 10, { terrain: 'market', owner: THEM, level: 9 });

    const mine = playerYieldPerSec(tiles, ME, 0);
    expect(mine).toBe(TERRAIN_STATS.concrete.yieldScrap * 2);
  });

  it('is zero for a player with no tiles', () => {
    expect(playerYieldPerSec(makeWorld(), 'NOBODY', 0)).toBe(0);
  });
});

describe('accrue', () => {
  it('pays rate x elapsed seconds', () => {
    expect(accrue(10, 0, 5000)).toBe(50);
  });

  it('pays nothing for zero or negative elapsed time', () => {
    expect(accrue(10, 5000, 5000)).toBe(0);
    expect(accrue(10, 5000, 4000)).toBe(0);
  });

  it('pays nothing at a zero rate', () => {
    expect(accrue(0, 0, 999999)).toBe(0);
  });

  it('caps offline earnings at the offline cap', () => {
    const capped = accrue(10, 0, OFFLINE_CAP_SECONDS * 1000 * 10);
    expect(capped).toBe(10 * OFFLINE_CAP_SECONDS);
  });

  it('never rewards more than the cap even for huge gaps', () => {
    expect(accrue(1, 0, Number.MAX_SAFE_INTEGER)).toBe(OFFLINE_CAP_SECONDS);
  });

  it('returns an integer for fractional millisecond gaps', () => {
    expect(Number.isInteger(accrue(7, 0, 1234))).toBe(true);
  });
});

describe('costs', () => {
  it('upgrade cost rises with level and stops at max level', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 3, 3, { terrain: 'concrete', owner: ME, level: 1 });
    let prev = 0;
    for (let level = 1; level < MAX_LEVEL; level++) {
      t.level = level;
      const c = upgradeCost(t)!;
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
    t.level = MAX_LEVEL;
    expect(upgradeCost(t)).toBeNull();
  });

  it('claim cost escalates with the number of tiles already held', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 3, 3, { terrain: 'concrete' });
    const first = claimCost(t, 0);
    const eleventh = claimCost(t, 10);
    expect(eleventh).toBeGreaterThan(first);
    // Costs must remain finite and safe for very large empires.
    expect(Number.isFinite(claimCost(t, 5000))).toBe(true);
  });

  it('claim cost is monotonic in tile count', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 3, 3, { terrain: 'concrete' });
    let prev = 0;
    for (let n = 0; n < 60; n++) {
      const c = claimCost(t, n);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it('prices high-yield terrain higher to claim', () => {
    const tiles = makeWorld();
    const market = setTile(tiles, 3, 3, { terrain: 'market' });
    const park = setTile(tiles, 4, 3, { terrain: 'park' });
    expect(claimCost(market, 0)).toBeGreaterThan(claimCost(park, 0));
  });
});

describe('tileDefense', () => {
  it('matches the base value for a level-1 concrete tile', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 3, 3, { terrain: 'concrete', level: 1 });
    expect(tileDefense(t)).toBe(BASE_DEFENSE_SCRAP);
  });

  it('rises with level', () => {
    const tiles = makeWorld();
    const t = setTile(tiles, 3, 3, { terrain: 'concrete', level: 1 });
    let prev = 0;
    for (let level = 1; level <= MAX_LEVEL; level++) {
      t.level = level;
      const d = tileDefense(t);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it('makes towers tougher than markets, the core terrain trade-off', () => {
    const tiles = makeWorld();
    const tower = setTile(tiles, 3, 3, { terrain: 'tower', level: 5 });
    const market = setTile(tiles, 4, 3, { terrain: 'market', level: 5 });
    expect(tileDefense(tower)).toBeGreaterThan(tileDefense(market));
    expect(TERRAIN_STATS.market.yieldScrap).toBeGreaterThan(TERRAIN_STATS.tower.yieldScrap);
  });
});

describe('clampLevel', () => {
  it('clamps out-of-range and non-finite levels', () => {
    expect(clampLevel(0)).toBe(1);
    expect(clampLevel(-5)).toBe(1);
    expect(clampLevel(MAX_LEVEL + 10)).toBe(MAX_LEVEL);
    expect(clampLevel(NaN)).toBe(1);
    // Non-finite input falls back to the *minimum*, never the maximum: a
    // corrupted level must never hand someone a free max-level tile.
    expect(clampLevel(Infinity)).toBe(1);
    expect(clampLevel(3.7)).toBe(3);
  });
});

describe('formatting', () => {
  it('keeps small amounts readable without looking frozen', () => {
    expect(formatTurf(0)).toBe('0.00');
    expect(formatTurf(7)).toBe('7.00');
    expect(formatTurf(12.5)).toBe('12.5');
    expect(formatTurf(900)).toBe('900');
  });

  it('abbreviates large amounts', () => {
    expect(formatTurf(15_000)).toBe('15.00K');
    expect(formatTurf(2_500_000)).toBe('2.50M');
    expect(formatTurf(3_000_000_000)).toBe('3.00B');
    expect(formatTurf(4_000_000_000_000)).toBe('4.00T');
  });

  it('never renders a non-finite balance', () => {
    expect(formatTurf(NaN)).toBe('0');
    expect(formatTurf(Infinity)).toBe('0');
  });

  it('formats rates with a per-second suffix', () => {
    expect(formatRate(12)).toBe('12.0/s');
    expect(formatRate(4200)).toBe('4200/s');
    expect(formatRate(42_000)).toBe('42.00K/s');
  });
});
