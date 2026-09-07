import { describe, expect, it } from 'vitest';
import {
  CAPTURE_IMMUNITY_SECONDS,
  MAX_CONCURRENT_SIEGES,
  SIEGE_BASE_SECONDS,
  SIEGE_DEFENSE_REFUND_BP,
  SIEGE_LOSS_REFUND_BP,
  SIEGE_MAX_SECONDS,
  SIEGE_MIN_SECONDS,
} from '../src/constants';
import { tileDefense } from '../src/economy';
import {
  attackerIsWinning,
  checkSiege,
  requiredPressure,
  resolveSiege,
  siegeDurationSeconds,
  SIEGE_REJECTION_MESSAGES,
  type SiegeCheckInput,
} from '../src/siege';
import { makeSiege, makeWorld, setTile } from './helpers';

const ME = 'NQ01 ME';
const THEM = 'NQ02 THEM';

describe('siegeDurationSeconds', () => {
  it('resolves in the base time when pressure exactly matches defense', () => {
    expect(siegeDurationSeconds(1000, 1000)).toBe(SIEGE_BASE_SECONDS);
  });

  it('resolves faster the more pressure is committed', () => {
    const light = siegeDurationSeconds(1000, 4000);
    const heavy = siegeDurationSeconds(8000, 4000);
    expect(heavy).toBeLessThan(light);
  });

  it('is monotonically non-increasing in pressure', () => {
    let prev = Infinity;
    for (let p = 100; p <= 100_000; p += 500) {
      const d = siegeDurationSeconds(p, 20_000);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
  });

  it('clamps to the minimum and maximum siege window', () => {
    expect(siegeDurationSeconds(Number.MAX_SAFE_INTEGER, 1)).toBe(SIEGE_MIN_SECONDS);
    expect(siegeDurationSeconds(1, Number.MAX_SAFE_INTEGER)).toBe(SIEGE_MAX_SECONDS);
  });

  it('never divides by zero or returns a non-integer', () => {
    for (const [p, d] of [[0, 0], [0, 100], [100, 0], [-5, -5]]) {
      const s = siegeDurationSeconds(p, d);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(SIEGE_MIN_SECONDS);
    }
  });
});

describe('resolveSiege - deterministic outcomes', () => {
  it('captures the tile when pressure exceeds defense plus reinforcement', () => {
    const tiles = makeWorld();
    const tile = setTile(tiles, 5, 5, { terrain: 'concrete', owner: THEM, level: 4 });
    const siege = makeSiege({ baseDefense: 1000, reinforcement: 500, pressure: 1501 });
    const out = resolveSiege(siege, tile);
    expect(out.captured).toBe(true);
    expect(out.newLevel).toBe(3);
    expect(out.attackerRefund).toBe(0);
    expect(out.defenderRefund).toBe(0);
  });

  it('holds the tile when pressure exactly equals the requirement', () => {
    const tiles = makeWorld();
    const tile = setTile(tiles, 5, 5, { terrain: 'concrete', owner: THEM, level: 4 });
    const siege = makeSiege({ baseDefense: 1000, reinforcement: 500, pressure: 1500 });
    // A tie favours the defender - attackers must strictly beat the defense.
    expect(resolveSiege(siege, tile).captured).toBe(false);
  });

  it('refunds part of the attacker pressure on a failed siege', () => {
    const tiles = makeWorld();
    const tile = setTile(tiles, 5, 5, { terrain: 'concrete', owner: THEM, level: 4 });
    const siege = makeSiege({ baseDefense: 5000, reinforcement: 0, pressure: 1000 });
    const out = resolveSiege(siege, tile);
    expect(out.captured).toBe(false);
    expect(out.attackerRefund).toBe(Math.floor((1000 * SIEGE_LOSS_REFUND_BP) / 10000));
    expect(out.attackerRefund).toBeLessThan(1000);
    expect(out.newLevel).toBe(4);
  });

  it('refunds most of the defender reinforcement when they hold', () => {
    const tiles = makeWorld();
    const tile = setTile(tiles, 5, 5, { terrain: 'concrete', owner: THEM, level: 4 });
    const siege = makeSiege({ baseDefense: 1000, reinforcement: 2000, pressure: 1500 });
    const out = resolveSiege(siege, tile);
    expect(out.captured).toBe(false);
    expect(out.defenderRefund).toBe(Math.floor((2000 * SIEGE_DEFENSE_REFUND_BP) / 10000));
  });

  it('never drops a captured tile below level 1', () => {
    const tiles = makeWorld();
    const tile = setTile(tiles, 5, 5, { terrain: 'concrete', owner: THEM, level: 1 });
    const siege = makeSiege({ baseDefense: 10, reinforcement: 0, pressure: 9999 });
    expect(resolveSiege(siege, tile).newLevel).toBe(1);
  });

  it('is pure - resolving the same siege repeatedly gives the same result', () => {
    const tiles = makeWorld();
    const tile = setTile(tiles, 5, 5, { terrain: 'docks', owner: THEM, level: 6 });
    const siege = makeSiege({ baseDefense: 4000, reinforcement: 1200, pressure: 5300 });
    const first = resolveSiege(siege, tile);
    for (let i = 0; i < 20; i++) expect(resolveSiege(siege, tile)).toEqual(first);
  });

  it('outcome depends only on committed resources, never on chance', () => {
    // Sweep the whole decision boundary: the result must flip exactly once,
    // at the point where pressure passes the requirement.
    const tiles = makeWorld();
    const tile = setTile(tiles, 5, 5, { terrain: 'concrete', owner: THEM, level: 3 });
    const baseDefense = 2000;
    const reinforcement = 750;
    const required = requiredPressure({ baseDefense, reinforcement });
    let flips = 0;
    let prev = false;
    for (let p = 0; p <= required * 2; p += 1) {
      const captured = resolveSiege(makeSiege({ baseDefense, reinforcement, pressure: p }), tile).captured;
      if (captured !== prev) flips++;
      prev = captured;
      expect(captured).toBe(p > required);
    }
    expect(flips).toBe(1);
  });

  it('attackerIsWinning agrees with the eventual outcome at all times', () => {
    const tiles = makeWorld();
    const tile = setTile(tiles, 5, 5, { terrain: 'tower', owner: THEM, level: 5 });
    for (const pressure of [0, 100, 5000, 50_000, 500_000]) {
      for (const reinforcement of [0, 250, 9000]) {
        const siege = makeSiege({ baseDefense: 12_000, reinforcement, pressure });
        expect(attackerIsWinning(siege)).toBe(resolveSiege(siege, tile).captured);
      }
    }
  });
});

describe('checkSiege - legality', () => {
  function baseInput(tiles = makeWorld(), overrides: Partial<SiegeCheckInput> = {}): SiegeCheckInput {
    const tile = setTile(tiles, 5, 5, { terrain: 'concrete', owner: THEM, level: 3 });
    setTile(tiles, 4, 5, { owner: ME }); // adjacency for the attacker
    return {
      tile,
      tiles,
      attacker: ME,
      attackerScrap: 1_000_000,
      pressure: 5_000,
      activeSiegesByAttacker: 0,
      maxConcurrentSieges: MAX_CONCURRENT_SIEGES,
      tileHasActiveSiege: false,
      now: 10_000_000,
      ...overrides,
    };
  }

  it('allows a legal siege', () => {
    expect(checkSiege(baseInput())).toBeNull();
  });

  it('rejects raiding an unowned tile', () => {
    const tiles = makeWorld();
    const input = baseInput(tiles);
    input.tile.owner = null;
    expect(checkSiege(input)).toBe('unowned_tile');
  });

  it('rejects raiding your own tile', () => {
    const tiles = makeWorld();
    const input = baseInput(tiles);
    input.tile.owner = ME;
    expect(checkSiege(input)).toBe('own_tile');
  });

  it('rejects a tile that is not adjacent to your territory', () => {
    const tiles = makeWorld();
    const tile = setTile(tiles, 15, 15, { terrain: 'concrete', owner: THEM, level: 3 });
    expect(checkSiege(baseInput(tiles, { tile }))).toBe('not_adjacent');
  });

  it('rejects a tile already under siege', () => {
    expect(checkSiege(baseInput(makeWorld(), { tileHasActiveSiege: true }))).toBe('already_under_siege');
  });

  it('rejects a deed-protected tile', () => {
    const tiles = makeWorld();
    const input = baseInput(tiles);
    input.tile.deedUntil = input.now + 60_000;
    expect(checkSiege(input)).toBe('deed_protected');
  });

  it('rejects a tile still inside its capture immunity window', () => {
    const tiles = makeWorld();
    const input = baseInput(tiles);
    input.tile.capturedAt = input.now - CAPTURE_IMMUNITY_SECONDS * 1000 + 1;
    expect(checkSiege(input)).toBe('capture_immunity');

    input.tile.capturedAt = input.now - CAPTURE_IMMUNITY_SECONDS * 1000 - 1;
    expect(checkSiege(input)).toBeNull();
  });

  it('rejects committing more scrap than you hold', () => {
    expect(checkSiege(baseInput(makeWorld(), { attackerScrap: 10, pressure: 5000 }))).toBe('insufficient_scrap');
  });

  it('rejects zero, negative and non-finite pressure', () => {
    for (const pressure of [0, -1, NaN, Infinity]) {
      expect(checkSiege(baseInput(makeWorld(), { pressure }))).not.toBeNull();
    }
  });

  it('rejects pressure too small to matter', () => {
    const tiles = makeWorld();
    const input = baseInput(tiles);
    const floor = Math.floor(tileDefense(input.tile) / 10);
    expect(checkSiege({ ...input, pressure: Math.max(1, floor - 1) })).toBe('pressure_too_low');
  });

  it('rejects exceeding the concurrent siege limit', () => {
    expect(
      checkSiege(baseInput(makeWorld(), { activeSiegesByAttacker: MAX_CONCURRENT_SIEGES })),
    ).toBe('too_many_sieges');
  });

  it('has a human-readable message for every rejection reason', () => {
    const reasons: (keyof typeof SIEGE_REJECTION_MESSAGES)[] = [
      'not_adjacent', 'own_tile', 'unowned_tile', 'already_under_siege', 'capture_immunity',
      'deed_protected', 'insufficient_scrap', 'pressure_too_low', 'too_many_sieges',
    ];
    for (const r of reasons) {
      expect(SIEGE_REJECTION_MESSAGES[r]).toBeTruthy();
      expect(SIEGE_REJECTION_MESSAGES[r].length).toBeGreaterThan(10);
    }
  });
});
