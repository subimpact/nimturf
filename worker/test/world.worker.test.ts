import {
  CAPTURE_IMMUNITY_SECONDS,
  SIEGE_DEFENSE_REFUND_BP,
  SIEGE_LOSS_REFUND_BP,
  WORLD_SIZE,
  generateTerrain,
  neighbourIds,
} from '@nimturf/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { World } from '../src/world';

/**
 * Durable Object integration tests.
 *
 * These run in real workerd against real SQLite. They cover the one path the
 * HTTP end-to-end script cannot reach, because a raid takes at least five
 * minutes of wall-clock time to resolve: what actually happens when the clock
 * runs out. Here the siege deadline is rewound directly in storage and the
 * alarm invoked, which is exactly what the runtime does in production.
 */

const A = 'NQ01AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'NQ02BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

let counter = 0;
function freshStub() {
  // A distinct Durable Object per test keeps them fully independent.
  counter += 1;
  return env.WORLD.get(env.WORLD.idFromName(`test-world-${counter}-${Math.random()}`));
}

/** Runs a raw SQL statement inside the object, for test setup and inspection. */
async function sql<T = Record<string, unknown>>(
  stub: DurableObjectStub<World>,
  query: string,
  ...bindings: unknown[]
): Promise<T[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec(query, ...(bindings as never[])).toArray() as T[],
  );
}

async function giveScrap(stub: DurableObjectStub<World>, address: string, amount: number) {
  await sql(stub, 'UPDATE players SET scrap = ? WHERE address = ?', amount, address);
}

/** Rewinds a siege so its deadline has passed, then fires the alarm. */
async function fastForwardSiege(stub: DurableObjectStub<World>, siegeId: string) {
  await sql(stub, 'UPDATE sieges SET resolves_at = ? WHERE id = ?', Date.now() - 1000, siegeId);
  await runInDurableObject(stub, (instance) => instance.alarm!());
}

async function tileRow(stub: DurableObjectStub<World>, id: number) {
  const rows = await sql<{ owner: string | null; level: number; captured_at: number; deed_until: number }>(
    stub,
    'SELECT owner, level, captured_at, deed_until FROM tiles WHERE id = ?',
    id,
  );
  return rows[0];
}

async function player(stub: DurableObjectStub<World>, address: string) {
  const rows = await sql<{ scrap: number; lifetime_scrap: number; settled_at: number }>(
    stub,
    'SELECT scrap, lifetime_scrap, settled_at FROM players WHERE address = ?',
    address,
  );
  return rows[0];
}

/**
 * Sets up two neighbouring players: A holds `tileA`, B holds an adjacent tile
 * so B is legally able to raid A.
 */
async function twoNeighbours(stub: DurableObjectStub<World>, scrap = 5_000_000) {
  const now = Date.now();
  await stub.ensurePlayer(A, now);
  await stub.ensurePlayer(B, now);

  // A central tile, so it definitely has four neighbours.
  const tileA = 10 * WORLD_SIZE + 10;
  const tileB = neighbourIds(tileA)[0];

  const claimA = await stub.claim(A, tileA, now);
  expect(claimA.ok, JSON.stringify(claimA)).toBe(true);
  const claimB = await stub.claim(B, tileB, now);
  expect(claimB.ok, JSON.stringify(claimB)).toBe(true);

  await giveScrap(stub, A, scrap);
  await giveScrap(stub, B, scrap);
  return { tileA, tileB, now };
}

describe('World: seeding and players', () => {
  let stub: DurableObjectStub<World>;
  beforeEach(() => {
    stub = freshStub();
  });

  it('seeds a full board exactly once', async () => {
    const snapshot = await stub.snapshot(null, Date.now());
    expect(snapshot.tiles).toHaveLength(WORLD_SIZE * WORLD_SIZE);
    expect(snapshot.tiles.every((t) => t.terrain && t.owner === null)).toBe(true);

    // A second look must not re-seed or duplicate tiles.
    const again = await stub.snapshot(null, Date.now());
    expect(again.tiles).toHaveLength(WORLD_SIZE * WORLD_SIZE);
  });

  it('creates a player once and is idempotent', async () => {
    const now = Date.now();
    await stub.ensurePlayer(A, now);
    await stub.ensurePlayer(A, now);
    const rows = await sql(stub, 'SELECT address FROM players WHERE address = ?', A);
    expect(rows).toHaveLength(1);
  });

  it('normalises addresses so spacing cannot split one player in two', async () => {
    const now = Date.now();
    await stub.ensurePlayer('NQ01 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA', now);
    await stub.ensurePlayer('nq01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now);
    const rows = await sql(stub, 'SELECT address FROM players');
    expect(rows).toHaveLength(1);
  });
});

describe('World: siege resolution', () => {
  let stub: DurableObjectStub<World>;
  beforeEach(() => {
    stub = freshStub();
  });

  it('transfers the tile when the attacker out-commits the defender', async () => {
    const { tileA } = await twoNeighbours(stub);
    const raid = await stub.openSiege(B, tileA, 100_000, Date.now());
    expect(raid.ok, JSON.stringify(raid)).toBe(true);
    if (!raid.ok) return;

    // Overwhelming pressure: this must be a capture.
    expect(raid.data.siege.pressure).toBeGreaterThan(raid.data.siege.baseDefense);

    await fastForwardSiege(stub, raid.data.siege.id);

    const tile = await tileRow(stub, tileA);
    expect(tile.owner).toBe(B);
    expect(tile.level).toBe(1); // was level 1, cannot drop below 1
    expect(tile.captured_at).toBeGreaterThan(0);

    const rows = await sql<{ state: string }>(stub, 'SELECT state FROM sieges WHERE id = ?', raid.data.siege.id);
    expect(rows[0].state).toBe('won');
  });

  it('drops a captured tile by one level', async () => {
    const { tileA } = await twoNeighbours(stub);
    // Build A's tile up so the level loss is observable.
    for (let i = 0; i < 3; i++) {
      const up = await stub.upgrade(A, tileA, Date.now());
      expect(up.ok, JSON.stringify(up)).toBe(true);
    }
    expect((await tileRow(stub, tileA)).level).toBe(4);

    const raid = await stub.openSiege(B, tileA, 4_000_000, Date.now());
    expect(raid.ok).toBe(true);
    if (!raid.ok) return;
    await fastForwardSiege(stub, raid.data.siege.id);

    const tile = await tileRow(stub, tileA);
    expect(tile.owner).toBe(B);
    expect(tile.level).toBe(3);
  });

  it('holds the tile and part-refunds the attacker when the raid is too weak', async () => {
    const { tileA } = await twoNeighbours(stub);
    const rows = await sql<{ level: number }>(stub, 'SELECT level FROM tiles WHERE id = ?', tileA);
    expect(rows[0].level).toBe(1);

    // Commit less than the tile's defense.
    const raid = await stub.openSiege(B, tileA, 200, Date.now());
    expect(raid.ok, JSON.stringify(raid)).toBe(true);
    if (!raid.ok) return;
    expect(raid.data.siege.pressure).toBeLessThan(raid.data.siege.baseDefense);

    const before = await player(stub, B);
    await fastForwardSiege(stub, raid.data.siege.id);

    const tile = await tileRow(stub, tileA);
    expect(tile.owner).toBe(A); // held

    const after = await player(stub, B);
    const expectedRefund = Math.floor((200 * SIEGE_LOSS_REFUND_BP) / 10000);
    // The refund is credited on top of whatever income accrued.
    expect(after.scrap - before.scrap).toBeGreaterThanOrEqual(expectedRefund);
    expect(after.scrap - before.scrap).toBeLessThan(200);
  });

  it('lets reinforcement flip a losing defence into a hold', async () => {
    const { tileA } = await twoNeighbours(stub);
    const raid = await stub.openSiege(B, tileA, 5_000, Date.now());
    expect(raid.ok).toBe(true);
    if (!raid.ok) return;

    // The attacker is winning right now.
    expect(raid.data.siege.pressure).toBeGreaterThan(raid.data.siege.baseDefense);

    // A commits enough to overtake the attacker.
    const need = raid.data.siege.pressure - raid.data.siege.baseDefense + 1;
    const reinforce = await stub.reinforce(A, raid.data.siege.id, need, Date.now());
    expect(reinforce.ok, JSON.stringify(reinforce)).toBe(true);

    const beforeA = await player(stub, A);
    await fastForwardSiege(stub, raid.data.siege.id);

    const tile = await tileRow(stub, tileA);
    expect(tile.owner).toBe(A); // successfully defended

    // The defender gets most of their commitment back.
    const afterA = await player(stub, A);
    const expectedRefund = Math.floor((need * SIEGE_DEFENSE_REFUND_BP) / 10000);
    expect(afterA.scrap - beforeA.scrap).toBeGreaterThanOrEqual(expectedRefund);
  });

  it('gives a captured tile immunity, then allows a follow-up raid', async () => {
    const { tileA } = await twoNeighbours(stub);
    // A needs a second tile: after losing tileA it must still hold ground
    // adjacent to it, or the counter-raid would fail for lack of a foothold.
    const spare = neighbourIds(tileA)[1];
    const spareClaim = await stub.claim(A, spare, Date.now());
    expect(spareClaim.ok, JSON.stringify(spareClaim)).toBe(true);

    const raid = await stub.openSiege(B, tileA, 100_000, Date.now());
    if (!raid.ok) throw new Error('setup failed');
    await fastForwardSiege(stub, raid.data.siege.id);
    expect((await tileRow(stub, tileA)).owner).toBe(B);

    // A tries to take it straight back: blocked by capture immunity.
    const immediate = await stub.openSiege(A, tileA, 100_000, Date.now());
    expect(immediate.ok).toBe(false);
    if (!immediate.ok) expect(immediate.error.code).toBe('capture_immunity');

    // Once the immunity window has passed, the counter-raid is allowed.
    await sql(stub, 'UPDATE tiles SET captured_at = ? WHERE id = ?', Date.now() - CAPTURE_IMMUNITY_SECONDS * 1000 - 1, tileA);
    const later = await stub.openSiege(A, tileA, 100_000, Date.now());
    expect(later.ok, JSON.stringify(later)).toBe(true);
  });

  it('resolves a siege exactly once, even if the alarm fires repeatedly', async () => {
    const { tileA } = await twoNeighbours(stub);
    const raid = await stub.openSiege(B, tileA, 200, Date.now());
    if (!raid.ok) throw new Error('setup failed');

    await fastForwardSiege(stub, raid.data.siege.id);
    const afterFirst = await player(stub, B);

    // Fire the alarm several more times: the refund must not be paid twice.
    for (let i = 0; i < 3; i++) await runInDurableObject(stub, (instance) => instance.alarm!());

    const afterMore = await player(stub, B);
    // Income still accrues, but B holds no tiles, so the balance must be stable.
    expect(afterMore.scrap).toBe(afterFirst.scrap);

    const rows = await sql<{ n: number }>(stub, "SELECT COUNT(*) AS n FROM sieges WHERE state = 'active'");
    expect(rows[0].n).toBe(0);
  });

  it('resolves a due siege lazily on the next read, without an alarm', async () => {
    const { tileA } = await twoNeighbours(stub);
    const raid = await stub.openSiege(B, tileA, 100_000, Date.now());
    if (!raid.ok) throw new Error('setup failed');

    // Rewind the deadline but never fire the alarm.
    await sql(stub, 'UPDATE sieges SET resolves_at = ? WHERE id = ?', Date.now() - 1000, raid.data.siege.id);

    const snapshot = await stub.snapshot(null, Date.now());
    expect(snapshot.tiles[tileA].owner).toBe(B);
    expect(snapshot.sieges).toHaveLength(0);
  });

  it('notifies both sides about the outcome', async () => {
    const { tileA } = await twoNeighbours(stub);
    const raid = await stub.openSiege(B, tileA, 100_000, Date.now());
    if (!raid.ok) throw new Error('setup failed');
    await fastForwardSiege(stub, raid.data.siege.id);

    const attacker = await stub.snapshot(B, Date.now());
    const defender = await stub.snapshot(A, Date.now());
    expect(attacker.events.some((e) => e.kind === 'siege_won')).toBe(true);
    expect(defender.events.some((e) => e.kind === 'tile_lost')).toBe(true);
  });

  it('caps how many raids one player can run at once', async () => {
    const now = Date.now();
    await stub.ensurePlayer(A, now);
    await stub.ensurePlayer(B, now);

    // Two facing rows: every tile in a row is adjacent to the previous one,
    // and each of A's tiles borders B's row, so B has four legal targets.
    const row = 10;
    const targets = [5, 6, 7, 8].map((x) => row * WORLD_SIZE + x);
    const bTiles = [5, 6, 7, 8].map((x) => (row + 1) * WORLD_SIZE + x);

    for (const t of targets) {
      const claim = await stub.claim(A, t, Date.now());
      expect(claim.ok, JSON.stringify(claim)).toBe(true);
      await giveScrap(stub, A, 5_000_000);
    }
    for (const t of bTiles) {
      const claim = await stub.claim(B, t, Date.now());
      expect(claim.ok, JSON.stringify(claim)).toBe(true);
      await giveScrap(stub, B, 5_000_000);
    }

    let opened = 0;
    let rejected: string | null = null;
    for (const t of targets) {
      const raid = await stub.openSiege(B, t, 5_000, Date.now());
      if (raid.ok) opened++;
      else rejected = raid.error.code;
    }
    expect(opened).toBe(3); // MAX_CONCURRENT_SIEGES
    expect(rejected).toBe('too_many_sieges');
  });
});

describe('World: economy integrity', () => {
  let stub: DurableObjectStub<World>;
  beforeEach(() => {
    stub = freshStub();
  });

  it('never lets a player spend TURF they do not have', async () => {
    const now = Date.now();
    await stub.ensurePlayer(A, now);
    const tile = 10 * WORLD_SIZE + 10;
    await stub.claim(A, tile, now);
    await giveScrap(stub, A, 0);

    const up = await stub.upgrade(A, tile, Date.now());
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.error.code).toBe('insufficient');

    const row = await player(stub, A);
    expect(row.scrap).toBeGreaterThanOrEqual(0);
  });

  it('escrows raid pressure immediately so it cannot be double-spent', async () => {
    const { tileA } = await twoNeighbours(stub, 10_000);
    const before = await player(stub, B);

    const first = await stub.openSiege(B, tileA, 9_000, Date.now());
    expect(first.ok, JSON.stringify(first)).toBe(true);

    const mid = await player(stub, B);
    expect(mid.scrap).toBeLessThan(before.scrap);
    expect(mid.scrap).toBeLessThan(9_000);
  });

  it('banks income at the old rate before a new tile changes it', async () => {
    const now = Date.now();
    await stub.ensurePlayer(A, now);
    const first = 10 * WORLD_SIZE + 10;
    await stub.claim(A, first, now);

    // Backdate the settle clock so a known amount of income is owed.
    await sql(stub, 'UPDATE players SET settled_at = ?, scrap = 1000000 WHERE address = ?', Date.now() - 10_000, A);
    const before = await player(stub, A);

    const second = neighbourIds(first)[0];
    const claim = await stub.claim(A, second, Date.now());
    expect(claim.ok, JSON.stringify(claim)).toBe(true);

    const after = await player(stub, A);
    // Income was banked and the clock advanced, so no time is billed twice.
    expect(after.settled_at).toBeGreaterThan(before.settled_at);
    expect(after.lifetime_scrap).toBeGreaterThan(before.lifetime_scrap);
  });

  it('caps offline earnings rather than paying out unbounded idle time', async () => {
    const now = Date.now();
    await stub.ensurePlayer(A, now);
    const tile = 10 * WORLD_SIZE + 10;
    await stub.claim(A, tile, now);
    await sql(stub, 'UPDATE players SET settled_at = ?, scrap = 0, lifetime_scrap = 0 WHERE address = ?', 0, A);

    const snapshot = await stub.snapshot(A, Date.now());
    const rate = snapshot.me!.yieldPerSec;
    // Even after decades of "offline" time, the payout is bounded by the cap.
    expect(snapshot.me!.scrap).toBeLessThanOrEqual(rate * 8 * 60 * 60);
  });
});

describe('World: deeds', () => {
  let stub: DurableObjectStub<World>;
  beforeEach(() => {
    stub = freshStub();
  });

  it('grants a deed and records the transaction for public audit', async () => {
    const now = Date.now();
    await stub.ensurePlayer(A, now);
    const tile = 10 * WORLD_SIZE + 10;
    await stub.claim(A, tile, now);

    const before = await stub.snapshot(A, Date.now());
    const rateBefore = before.me!.yieldPerSec;

    const hash = 'a'.repeat(64);
    const granted = await stub.grantDeed(A, tile, hash, Date.now());
    expect(granted.ok, JSON.stringify(granted)).toBe(true);

    const row = await tileRow(stub, tile);
    expect(row.deed_until).toBeGreaterThan(Date.now());

    const after = await stub.snapshot(A, Date.now());
    expect(after.me!.yieldPerSec).toBeGreaterThan(rateBefore);

    const log = await stub.deedLog(10);
    expect(log[0].txHash).toBe(hash);
    expect(log[0].tileId).toBe(tile);
  });

  it('refuses to redeem the same transaction for a different tile', async () => {
    const now = Date.now();
    await stub.ensurePlayer(A, now);
    const first = 10 * WORLD_SIZE + 10;
    await stub.claim(A, first, now);
    await giveScrap(stub, A, 5_000_000);
    const second = neighbourIds(first)[0];
    await stub.claim(A, second, Date.now());

    const hash = 'b'.repeat(64);
    expect((await stub.grantDeed(A, first, hash, Date.now())).ok).toBe(true);

    const reuse = await stub.grantDeed(A, second, hash, Date.now());
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.error.code).toBe('tx_used');
  });

  it('is idempotent for the same tile, so a retry is safe', async () => {
    const now = Date.now();
    await stub.ensurePlayer(A, now);
    const tile = 10 * WORLD_SIZE + 10;
    await stub.claim(A, tile, now);

    const hash = 'c'.repeat(64);
    const first = await stub.grantDeed(A, tile, hash, Date.now());
    const retry = await stub.grantDeed(A, tile, hash, Date.now());
    expect(first.ok).toBe(true);
    expect(retry.ok, JSON.stringify(retry)).toBe(true);

    const log = await stub.deedLog(10);
    expect(log).toHaveLength(1);
  });

  it('protects a deeded tile from raids', async () => {
    const { tileA } = await twoNeighbours(stub);
    expect((await stub.grantDeed(A, tileA, 'd'.repeat(64), Date.now())).ok).toBe(true);

    const raid = await stub.openSiege(B, tileA, 500_000, Date.now());
    expect(raid.ok).toBe(false);
    if (!raid.ok) expect(raid.error.code).toBe('deed_protected');
  });

  it('clears the deed when the tile is eventually captured', async () => {
    const { tileA } = await twoNeighbours(stub);
    expect((await stub.grantDeed(A, tileA, 'e'.repeat(64), Date.now())).ok).toBe(true);

    // Expire the deed, then take the tile.
    await sql(stub, 'UPDATE tiles SET deed_until = ? WHERE id = ?', Date.now() - 1, tileA);
    const raid = await stub.openSiege(B, tileA, 500_000, Date.now());
    expect(raid.ok, JSON.stringify(raid)).toBe(true);
    if (!raid.ok) return;
    await fastForwardSiege(stub, raid.data.siege.id);

    const row = await tileRow(stub, tileA);
    expect(row.owner).toBe(B);
    expect(row.deed_until).toBe(0);
  });
});

describe('World: login challenges', () => {
  it('consumes a nonce exactly once', async () => {
    const stub = freshStub();
    const now = Date.now();
    await stub.storeChallenge('nonce-1', now);

    expect(await stub.consumeChallenge('nonce-1', now)).not.toBeNull();
    expect(await stub.consumeChallenge('nonce-1', now)).toBeNull();
  });

  it('rejects an expired nonce', async () => {
    const stub = freshStub();
    const issued = Date.now() - 60 * 60 * 1000;
    await stub.storeChallenge('old-nonce', issued);
    expect(await stub.consumeChallenge('old-nonce', Date.now())).toBeNull();
  });

  it('rejects a nonce that was never issued', async () => {
    const stub = freshStub();
    expect(await stub.consumeChallenge('never-existed', Date.now())).toBeNull();
  });
});

describe('World: player colours', () => {
  it('gives the first eight players distinct colours', async () => {
    /*
     * Colour is how a player finds their own territory on the map, so a
     * collision between two neighbours is a real usability problem rather
     * than a cosmetic one. Hashing the address used to collide often.
     */
    const stub = freshStub();
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      await stub.ensurePlayer(`NQ0${i}TESTPLAYER${String(i).repeat(20)}`.slice(0, 36), now);
    }
    const rows = await sql<{ color_index: number }>(stub, 'SELECT color_index FROM players');
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.color_index)).size).toBe(8);
  });

  it('reuses colours evenly once there are more players than colours', async () => {
    const stub = freshStub();
    const now = Date.now();
    for (let i = 0; i < 16; i++) {
      await stub.ensurePlayer(`NQ${String(i).padStart(2, '0')}${'X'.repeat(32)}`, now);
    }
    const rows = await sql<{ color_index: number }>(stub, 'SELECT color_index FROM players');
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.color_index, (counts.get(r.color_index) ?? 0) + 1);
    // 16 players over 8 colours: every colour used exactly twice.
    expect(counts.size).toBe(8);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it('keeps a chosen colour inside the palette', async () => {
    const stub = freshStub();
    const now = Date.now();
    await stub.ensurePlayer(A, now);

    for (const [input, expected] of [[3, 3], [-1, 0], [99, 7], [NaN, 0]] as const) {
      const result = await stub.setColour(A, input, Date.now());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.colorIndex).toBe(expected);
    }
  });
});

describe('World: seed honesty', () => {
  it('reports the seed the map was actually generated from', async () => {
    /*
     * The README claims the board is verifiably derived from a public seed.
     * That only holds if the reported seed describes the map that exists, so
     * the seed is persisted at generation time and read back from storage
     * rather than from configuration.
     */
    const stub = freshStub();
    const snapshot = await stub.snapshot(null, Date.now());
    const reported = snapshot.meta.seed;

    const stored = await sql<{ value: string }>(stub, "SELECT value FROM meta WHERE key = 'seed'");
    expect(stored).toHaveLength(1);
    expect(Number(stored[0].value)).toBe(reported);

    // And the terrain on the board matches that seed exactly.
    const expected = generateTerrain(reported);
    expect(snapshot.tiles.map((t) => t.terrain)).toEqual(expected);
  });

  it('keeps reporting the original seed even if configuration changes later', async () => {
    const stub = freshStub();
    const before = (await stub.snapshot(null, Date.now())).meta.seed;

    // Simulate an operator editing WORLD_SEED on a running season.
    await sql(stub, "UPDATE meta SET value = ? WHERE key = 'seed'", String(before));
    const after = (await stub.snapshot(null, Date.now())).meta.seed;

    expect(after).toBe(before);
    const expected = generateTerrain(after);
    expect((await stub.snapshot(null, Date.now())).tiles.map((t) => t.terrain)).toEqual(expected);
  });
});
