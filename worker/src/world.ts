import { DurableObject } from 'cloudflare:workers';
import {
  DEED_DURATION_SECONDS,
  DEED_PRICE_LUNA,
  FREE_FIRST_CLAIM,
  MAX_CONCURRENT_SIEGES,
  MAX_LEVEL,
  STARTING_SCRAP,
  TILE_COUNT,
  WORLD_SIZE,
  accrue,
  checkSiege,
  claimCost,
  encodeDeedData,
  formatTurf,
  generateTerrain,
  neighbourIds,
  normaliseAddress,
  playerYieldPerSec,
  resolveSiege,
  siegeDurationSeconds,
  tileDefense,
  tileLabel,
  tileYieldPerSec,
  upgradeCost,
  type GameEvent,
  type LeaderboardEntry,
  type MeState,
  type Siege,
  type SnapshotResponse,
  type Terrain,
  type Tile,
  type WorldSnapshot,
} from '@nimturf/shared';
import { SIEGE_REJECTION_MESSAGES } from '@nimturf/shared';
import { CHALLENGE_TTL_SECONDS } from './auth';

/**
 * The World Durable Object: the single authoritative owner of all game state.
 *
 * Everything that can change the game runs inside here. Because a Durable
 * Object processes one request at a time against its own SQLite database, two
 * players cannot claim the same tile or spend the same TURF twice, without any
 * explicit locking. The browser is never trusted with a balance: it can only
 * ask for an action, and this class decides what actually happened.
 */

/** Number of distinct territory colours available. Mirrors OWNER_HEX in the UI. */
const PLAYER_COLOURS = 8;

export interface WorldEnv {
  SEASON_ID: string;
  WORLD_SEED: string;
  TREASURY_ADDRESS?: string;
}

export type ActionError = { code: string; message: string };
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

function fail(code: string, message: string): { ok: false; error: ActionError } {
  return { ok: false, error: { code, message } };
}

interface PlayerRow {
  // Index signature required by the Durable Object SQL cursor generic.
  [key: string]: SqlStorageValue;
  address: string;
  name: string;
  scrap: number;
  settled_at: number;
  lifetime_scrap: number;
  created_at: number;
  color_index: number;
  alliance_id: string | null;
}

interface TileRow {
  // Index signature required by the Durable Object SQL cursor generic.
  [key: string]: SqlStorageValue;
  id: number;
  terrain: string;
  owner: string | null;
  level: number;
  captured_at: number;
  deed_until: number;
  deed_tx: string | null;
}

interface DeedRow { [key: string]: SqlStorageValue; tile_id: number; address: string }
interface DeedLogRow { [key: string]: SqlStorageValue; tx_hash: string; address: string; tile_id: number; minted_at: number }
interface ChallengeRow { [key: string]: SqlStorageValue; issued_at: number; expires_at: number }
interface NamedPlayerRow { [key: string]: SqlStorageValue; address: string; name: string; color_index: number }
interface CountRow { [key: string]: SqlStorageValue; n: number }
interface NextRow { [key: string]: SqlStorageValue; next: number | null }
interface ValueRow { [key: string]: SqlStorageValue; value: string }
interface AddressRow { [key: string]: SqlStorageValue; address: string }

interface EventSqlRow {
  [key: string]: SqlStorageValue;
  id: number;
  address: string;
  kind: string;
  message: string;
  tile_id: number | null;
  created_at: number;
}

interface SiegeRow {
  // Index signature required by the Durable Object SQL cursor generic.
  [key: string]: SqlStorageValue;
  id: string;
  tile_id: number;
  attacker: string;
  defender: string | null;
  pressure: number;
  reinforcement: number;
  base_defense: number;
  started_at: number;
  resolves_at: number;
  state: string;
  resolved_at: number | null;
}

export class World extends DurableObject<WorldEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: WorldEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Schema creation and seeding must finish before any request is served.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.seedIfEmpty();
    });
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        address        TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        scrap          INTEGER NOT NULL,
        settled_at     INTEGER NOT NULL,
        lifetime_scrap INTEGER NOT NULL,
        created_at     INTEGER NOT NULL,
        color_index    INTEGER NOT NULL DEFAULT 0,
        alliance_id    TEXT
      );
      CREATE TABLE IF NOT EXISTS tiles (
        id          INTEGER PRIMARY KEY,
        terrain     TEXT NOT NULL,
        owner       TEXT,
        level       INTEGER NOT NULL DEFAULT 1,
        captured_at INTEGER NOT NULL DEFAULT 0,
        deed_until  INTEGER NOT NULL DEFAULT 0,
        deed_tx     TEXT
      );
      CREATE INDEX IF NOT EXISTS tiles_owner ON tiles(owner);
      CREATE TABLE IF NOT EXISTS sieges (
        id           TEXT PRIMARY KEY,
        tile_id      INTEGER NOT NULL,
        attacker     TEXT NOT NULL,
        defender     TEXT,
        pressure     INTEGER NOT NULL,
        reinforcement INTEGER NOT NULL DEFAULT 0,
        base_defense INTEGER NOT NULL,
        started_at   INTEGER NOT NULL,
        resolves_at  INTEGER NOT NULL,
        state        TEXT NOT NULL,
        resolved_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS sieges_state ON sieges(state, resolves_at);
      CREATE INDEX IF NOT EXISTS sieges_tile ON sieges(tile_id, state);
      -- Every accepted deed transaction, so a hash can never be redeemed twice.
      CREATE TABLE IF NOT EXISTS deeds (
        tx_hash   TEXT PRIMARY KEY,
        address   TEXT NOT NULL,
        tile_id   INTEGER NOT NULL,
        minted_at INTEGER NOT NULL
      );
      -- Single-use login challenges.
      CREATE TABLE IF NOT EXISTS challenges (
        nonce      TEXT PRIMARY KEY,
        issued_at  INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        address    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        message    TEXT NOT NULL,
        tile_id    INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_address ON events(address, id DESC);
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private get seed(): number {
    const n = Number(this.env.WORLD_SEED);
    return Number.isFinite(n) ? Math.trunc(n) : 1;
  }

  /** Lays out the season's map. Runs once per Durable Object. */
  private seedIfEmpty(): void {
    const [{ n }] = this.sql.exec<CountRow>('SELECT COUNT(*) AS n FROM tiles').toArray();
    if (n > 0) return;

    const terrain = generateTerrain(this.seed);
    for (let id = 0; id < TILE_COUNT; id++) {
      this.sql.exec('INSERT INTO tiles (id, terrain) VALUES (?, ?)', id, terrain[id]);
    }
    this.sql.exec(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
      'started_at',
      String(Date.now()),
    );
  }

  // -------------------------------------------------------------------------
  // Loading helpers
  // -------------------------------------------------------------------------

  /** Loads every tile into an array indexed by tile id, as the engine expects. */
  private loadTiles(): Tile[] {
    const rows = this.sql.exec<TileRow>('SELECT * FROM tiles ORDER BY id').toArray();
    const tiles: Tile[] = new Array(TILE_COUNT);
    for (const r of rows) {
      tiles[r.id] = {
        id: r.id,
        x: r.id % WORLD_SIZE,
        y: Math.floor(r.id / WORLD_SIZE),
        terrain: r.terrain as Terrain,
        owner: r.owner,
        level: r.level,
        settledAt: 0,
        capturedAt: r.captured_at,
        deedUntil: r.deed_until,
        deedTxHash: r.deed_tx,
      };
    }
    return tiles;
  }

  private writeTile(tile: Tile): void {
    this.sql.exec(
      'UPDATE tiles SET owner = ?, level = ?, captured_at = ?, deed_until = ?, deed_tx = ? WHERE id = ?',
      tile.owner,
      tile.level,
      tile.capturedAt,
      tile.deedUntil,
      tile.deedTxHash,
      tile.id,
    );
  }

  private getPlayer(address: string): PlayerRow | null {
    const rows = this.sql.exec<PlayerRow>('SELECT * FROM players WHERE address = ?', address).toArray();
    return rows[0] ?? null;
  }

  /** Maps alliance id to its members, so ally adjacency can be applied. */
  private allySetFor(address: string): Set<string> | null {
    const player = this.getPlayer(address);
    if (!player?.alliance_id) return null;
    const rows = this.sql
      .exec<AddressRow>('SELECT address FROM players WHERE alliance_id = ? AND address != ?', player.alliance_id, address)
      .toArray();
    return new Set(rows.map((r) => r.address));
  }

  /**
   * Income per second for every landowner, computed in a single pass over the
   * board. Settling one player or all of them costs the same, which keeps the
   * leaderboard cheap no matter how many people are playing.
   */
  private ratesByOwner(tiles: readonly Tile[], now: number): Map<string, number> {
    const rates = new Map<string, number>();
    for (const tile of tiles) {
      if (!tile.owner) continue;
      const rate = tileYieldPerSec(tile, tiles, now, null);
      rates.set(tile.owner, (rates.get(tile.owner) ?? 0) + rate);
    }
    return rates;
  }

  /**
   * Banks a player's accrued income up to `now`.
   *
   * This MUST be called for every affected player before any change that
   * alters their income - otherwise the new rate would be applied
   * retroactively to time already elapsed, which is how idle games leak value.
   */
  private settle(address: string, rate: number, now: number): void {
    const player = this.getPlayer(address);
    if (!player) return;
    const earned = accrue(rate, player.settled_at, now);
    if (earned <= 0) {
      // Still advance the clock so a later rate change is not applied backwards.
      this.sql.exec('UPDATE players SET settled_at = ? WHERE address = ?', now, address);
      return;
    }
    this.sql.exec(
      'UPDATE players SET scrap = scrap + ?, lifetime_scrap = lifetime_scrap + ?, settled_at = ? WHERE address = ?',
      earned,
      earned,
      now,
      address,
    );
  }

  /** Settles every player. Used before reads that must be globally accurate. */
  private settleAll(tiles: readonly Tile[], now: number): void {
    const rates = this.ratesByOwner(tiles, now);
    const players = this.sql.exec<AddressRow>('SELECT address FROM players').toArray();
    for (const { address } of players) {
      this.settle(address, rates.get(address) ?? 0, now);
    }
  }

  private addEvent(address: string, kind: string, message: string, tileId: number | null, now: number): void {
    this.sql.exec(
      'INSERT INTO events (address, kind, message, tile_id, created_at) VALUES (?, ?, ?, ?, ?)',
      address,
      kind,
      message,
      tileId,
      now,
    );
    // Keep only a recent window per player so storage cannot grow unbounded.
    this.sql.exec(
      'DELETE FROM events WHERE address = ? AND id NOT IN (SELECT id FROM events WHERE address = ? ORDER BY id DESC LIMIT 50)',
      address,
      address,
    );
  }

  private tileCount(address: string): number {
    const [{ n }] = this.sql
      .exec<CountRow>('SELECT COUNT(*) AS n FROM tiles WHERE owner = ?', address)
      .toArray();
    return n;
  }

  // -------------------------------------------------------------------------
  // Sieges: resolution and scheduling
  // -------------------------------------------------------------------------

  /**
   * Resolves every siege whose clock has run out.
   *
   * Called both from the alarm and at the start of every request. Doing both
   * means the world is always consistent when someone looks at it, even if an
   * alarm were delayed or dropped - the outcome is identical either way,
   * because it is a pure function of the committed resources.
   */
  private resolveDueSieges(now: number): void {
    for (let guard = 0; guard < 500; guard++) {
      const due = this.sql
        .exec<SiegeRow>(
          "SELECT * FROM sieges WHERE state = 'active' AND resolves_at <= ? ORDER BY resolves_at LIMIT 1",
          now,
        )
        .toArray();
      if (due.length === 0) return;

      const row = due[0];
      // Recompute the board for each siege: an earlier resolution may have
      // changed who owns what, and therefore everyone's income rate.
      const tiles = this.loadTiles();
      const tile = tiles[row.tile_id];
      const rates = this.ratesByOwner(tiles, now);

      const siege: Siege = this.toSiege(row);

      // Bank income for everyone involved BEFORE ownership changes.
      this.settle(siege.attacker, rates.get(siege.attacker) ?? 0, now);
      if (siege.defender) this.settle(siege.defender, rates.get(siege.defender) ?? 0, now);
      if (tile?.owner && tile.owner !== siege.defender) {
        this.settle(tile.owner, rates.get(tile.owner) ?? 0, now);
      }

      // Defensive: if the tile somehow became unowned, void the siege and
      // return the attacker's stake rather than silently eating it.
      if (!tile || !tile.owner) {
        this.credit(siege.attacker, siege.pressure);
        if (siege.defender) this.credit(siege.defender, siege.reinforcement);
        this.finishSiege(row.id, 'held', now);
        this.addEvent(siege.attacker, 'siege_void', 'Your raid was called off - nobody holds that tile any more. Your TURF was returned.', row.tile_id, now);
        continue;
      }

      const outcome = resolveSiege(siege, tile);
      const defenderAddress = tile.owner;

      if (outcome.captured) {
        tile.owner = siege.attacker;
        tile.level = outcome.newLevel;
        tile.capturedAt = now;
        // A capture cancels any deed: the deed protected the previous holder.
        tile.deedUntil = 0;
        tile.deedTxHash = null;
        this.writeTile(tile);

        this.addEvent(siege.attacker, 'siege_won', `You captured tile ${tileLabel(row.tile_id)}.`, row.tile_id, now);
        this.addEvent(defenderAddress, 'tile_lost', `You lost tile ${tileLabel(row.tile_id)} to a raid.`, row.tile_id, now);
      } else {
        if (outcome.attackerRefund > 0) this.credit(siege.attacker, outcome.attackerRefund);
        if (outcome.defenderRefund > 0) this.credit(defenderAddress, outcome.defenderRefund);

        this.addEvent(siege.attacker, 'siege_lost', `Your raid on ${tileLabel(row.tile_id)} was repelled.`, row.tile_id, now);
        this.addEvent(defenderAddress, 'tile_held', `You held ${tileLabel(row.tile_id)} against a raid.`, row.tile_id, now);
      }

      this.finishSiege(row.id, outcome.captured ? 'won' : 'held', now);
    }
  }

  private finishSiege(id: string, state: 'won' | 'held', now: number): void {
    this.sql.exec('UPDATE sieges SET state = ?, resolved_at = ? WHERE id = ?', state, now, id);
  }

  private credit(address: string, amount: number): void {
    if (amount <= 0) return;
    this.sql.exec(
      'UPDATE players SET scrap = scrap + ?, lifetime_scrap = lifetime_scrap + ? WHERE address = ?',
      amount,
      amount,
      address,
    );
  }

  private toSiege(row: SiegeRow): Siege {
    return {
      id: row.id,
      tileId: row.tile_id,
      attacker: row.attacker,
      defender: row.defender,
      pressure: row.pressure,
      reinforcement: row.reinforcement,
      baseDefense: row.base_defense,
      startedAt: row.started_at,
      resolvesAt: row.resolves_at,
      state: row.state as Siege['state'],
      resolvedAt: row.resolved_at,
    };
  }

  /** Points the alarm at the next siege that needs resolving. */
  private async scheduleNextAlarm(): Promise<void> {
    const rows = this.sql
      .exec<NextRow>("SELECT MIN(resolves_at) AS next FROM sieges WHERE state = 'active'")
      .toArray();
    const next = rows[0]?.next ?? null;
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.resolveDueSieges(now);
    await this.scheduleNextAlarm();
  }

  /** Brings the world up to date. Every public entry point starts here. */
  private async tick(now: number): Promise<void> {
    this.resolveDueSieges(now);
    this.sql.exec('DELETE FROM challenges WHERE expires_at < ?', now);
    await this.scheduleNextAlarm();
  }

  // -------------------------------------------------------------------------
  // Login challenges
  // -------------------------------------------------------------------------

  /** Records a single-use login nonce. */
  async storeChallenge(nonce: string, now: number): Promise<void> {
    this.sql.exec('DELETE FROM challenges WHERE expires_at < ?', now);
    this.sql.exec(
      'INSERT OR REPLACE INTO challenges (nonce, issued_at, expires_at) VALUES (?, ?, ?)',
      nonce,
      now,
      now + CHALLENGE_TTL_SECONDS * 1000,
    );
  }

  /**
   * Consumes a login nonce, returning the moment it was issued.
   *
   * Deleting the row as part of the same single-threaded turn is what makes a
   * signature single-use: a replayed login attempt finds nothing to consume.
   */
  async consumeChallenge(nonce: string, now: number): Promise<{ issuedAt: number } | null> {
    const rows = this.sql
      .exec<ChallengeRow>('SELECT issued_at, expires_at FROM challenges WHERE nonce = ?', nonce)
      .toArray();
    this.sql.exec('DELETE FROM challenges WHERE nonce = ?', nonce);
    const row = rows[0];
    if (!row || row.expires_at < now) return null;
    return { issuedAt: row.issued_at };
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  /** Creates the player's account on first sign-in. Idempotent. */
  async ensurePlayer(rawAddress: string, now: number): Promise<void> {
    const address = normaliseAddress(rawAddress);
    if (this.getPlayer(address)) return;
    this.sql.exec(
      'INSERT INTO players (address, name, scrap, settled_at, lifetime_scrap, created_at, color_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
      address,
      this.defaultName(address),
      STARTING_SCRAP,
      now,
      0,
      now,
      this.defaultColour(address),
    );
    this.addEvent(address, 'welcome', 'Welcome to NimTurf. Claim your first block - it is free.', null, now);
  }

  private defaultName(address: string): string {
    return address.slice(2, 8);
  }

  /**
   * Picks the least-used colour for a new player.
   *
   * Colour is how a player recognises their own territory on the map, so two
   * neighbours sharing one is a real usability problem. Hashing the address
   * collided often with only eight colours; counting actual usage guarantees
   * every colour is taken once before any is reused, and the address hash only
   * breaks ties so the choice stays deterministic.
   */
  private defaultColour(address: string): number {
    const rows = this.sql
      .exec<CountRow>('SELECT color_index AS n FROM players')
      .toArray();
    const used = new Array<number>(PLAYER_COLOURS).fill(0);
    for (const row of rows) {
      const idx = ((row.n % PLAYER_COLOURS) + PLAYER_COLOURS) % PLAYER_COLOURS;
      used[idx] += 1;
    }

    let hash = 0;
    for (const c of address) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;

    let best = hash % PLAYER_COLOURS;
    for (let offset = 0; offset < PLAYER_COLOURS; offset++) {
      const candidate = (hash + offset) % PLAYER_COLOURS;
      if (used[candidate] < used[best]) best = candidate;
    }
    return best;
  }


  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The player's own live state: banked TURF plus income accrued since. */
  private meState(address: string, tiles: readonly Tile[], now: number): MeState | null {
    const player = this.getPlayer(address);
    if (!player) return null;
    const allies = this.allySetFor(address);
    const rate = playerYieldPerSec(tiles, address, now, allies);
    const pending = accrue(rate, player.settled_at, now);
    return {
      address: player.address,
      name: player.name,
      colorIndex: player.color_index,
      scrap: player.scrap + pending,
      yieldPerSec: rate,
      tileCount: this.tileCount(address),
      lifetimeScrap: player.lifetime_scrap + pending,
      settledAt: player.settled_at,
      createdAt: player.created_at,
      activeSieges: this.activeSiegeCount(address),
    };
  }

  private activeSiegeCount(address: string): number {
    const [{ n }] = this.sql
      .exec<CountRow>("SELECT COUNT(*) AS n FROM sieges WHERE attacker = ? AND state = 'active'", address)
      .toArray();
    return n;
  }

  /** Everything the client needs for one render of the world. */
  async snapshot(rawAddress: string | null, now: number): Promise<SnapshotResponse> {
    await this.tick(now);
    const tiles = this.loadTiles();
    const address = rawAddress ? normaliseAddress(rawAddress) : null;

    const siegeRows = this.sql
      .exec<SiegeRow>("SELECT * FROM sieges WHERE state = 'active' ORDER BY resolves_at")
      .toArray();

    // Only players who actually hold land need to be named on the map.
    const playerRows = this.sql
      .exec<NamedPlayerRow>(
        'SELECT address, name, color_index FROM players WHERE address IN (SELECT DISTINCT owner FROM tiles WHERE owner IS NOT NULL)',
      )
      .toArray();

    const players: WorldSnapshot['players'] = {};
    for (const p of playerRows) {
      players[p.address] = { address: p.address, name: p.name, colorIndex: p.color_index };
    }

    return {
      meta: {
        seasonId: this.env.SEASON_ID,
        seed: this.seed,
        startedAt: Number(this.metaValue('started_at') ?? 0),
        endsAt: 0,
      },
      tiles,
      sieges: siegeRows.map((r) => this.toSiege(r)),
      players,
      now,
      me: address ? this.meState(address, tiles, now) : null,
      events: address ? this.recentEvents(address) : [],
    };
  }

  private metaValue(key: string): string | null {
    const rows = this.sql.exec<ValueRow>('SELECT value FROM meta WHERE key = ?', key).toArray();
    return rows[0]?.value ?? null;
  }

  private recentEvents(address: string): GameEvent[] {
    const rows = this.sql
      .exec<EventSqlRow>('SELECT * FROM events WHERE address = ? ORDER BY id DESC LIMIT 20', address)
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      kind: r.kind,
      message: r.message,
      tile_id: r.tile_id,
      created_at: r.created_at,
    }));
  }

  /** The public leaderboard, ranked by lifetime TURF earned. */
  async leaderboard(limit: number, now: number): Promise<LeaderboardEntry[]> {
    await this.tick(now);
    const tiles = this.loadTiles();
    // Settle everyone first so the ranking reflects income already earned
    // rather than only what happened to be banked by someone's last action.
    this.settleAll(tiles, now);

    const rates = this.ratesByOwner(tiles, now);
    const rows = this.sql
      .exec<PlayerRow>('SELECT * FROM players ORDER BY lifetime_scrap DESC LIMIT ?', Math.max(1, Math.min(limit, 100)))
      .toArray();

    return rows.map((p, i) => ({
      rank: i + 1,
      address: p.address,
      name: p.name,
      tileCount: this.tileCount(p.address),
      lifetimeScrap: p.lifetime_scrap,
      yieldPerSec: rates.get(p.address) ?? 0,
      colorIndex: p.color_index,
    }));
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Claims an unowned tile. A player's very first claim is free. */
  async claim(rawAddress: string, tileId: number, now: number): Promise<ActionResult<MeState>> {
    await this.tick(now);
    const address = normaliseAddress(rawAddress);
    if (!this.getPlayer(address)) return fail('no_player', 'Sign in before claiming territory.');
    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= TILE_COUNT) {
      return fail('bad_tile', 'That tile does not exist.');
    }

    const tiles = this.loadTiles();
    const tile = tiles[tileId];
    if (tile.owner) {
      return fail('owned', tile.owner === address ? 'You already hold that block.' : 'Someone else holds that block - raid it instead.');
    }

    const owned = this.tileCount(address);
    // A player's very first claim ignores adjacency - they have no territory
    // to be adjacent to yet - and is free when FREE_FIRST_CLAIM is set.
    const isFirstEver = owned === 0;
    if (!isFirstEver) {
      const adjacent = neighbourIds(tileId).some((nid) => tiles[nid]?.owner === address);
      if (!adjacent) return fail('not_adjacent', 'You can only expand into blocks next to territory you already hold.');
    }

    const cost = isFirstEver && FREE_FIRST_CLAIM ? 0 : claimCost(tile, owned);

    // Bank income at the OLD rate before the new tile changes it.
    const rates = this.ratesByOwner(tiles, now);
    this.settle(address, rates.get(address) ?? 0, now);

    const player = this.getPlayer(address)!;
    if (player.scrap < cost) {
      return fail('insufficient', `You need ${formatTurf(cost)} TURF to claim that block and you have ${formatTurf(player.scrap)}.`);
    }

    if (cost > 0) this.sql.exec('UPDATE players SET scrap = scrap - ? WHERE address = ?', cost, address);
    tile.owner = address;
    tile.level = 1;
    // Deliberately does NOT set capturedAt. Capture immunity exists to give
    // someone breathing room after a tile is taken from them by force;
    // peacefully claiming neutral ground earns no shield, otherwise players
    // could blanket the map in untouchable tiles.
    this.writeTile(tile);

    const after = this.loadTiles();
    return { ok: true, data: this.meState(address, after, now)! };
  }

  /** Spends TURF to raise a tile's level, and with it its income and defense. */
  async upgrade(rawAddress: string, tileId: number, now: number): Promise<ActionResult<MeState>> {
    await this.tick(now);
    const address = normaliseAddress(rawAddress);
    if (!this.getPlayer(address)) return fail('no_player', 'Sign in before building.');
    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= TILE_COUNT) {
      return fail('bad_tile', 'That tile does not exist.');
    }

    const tiles = this.loadTiles();
    const tile = tiles[tileId];
    if (tile.owner !== address) return fail('not_owner', 'You can only build on blocks you hold.');
    if (tile.level >= MAX_LEVEL) return fail('max_level', 'That block is already fully built up.');

    const cost = upgradeCost(tile);
    if (cost === null) return fail('max_level', 'That block is already fully built up.');

    const rates = this.ratesByOwner(tiles, now);
    this.settle(address, rates.get(address) ?? 0, now);

    const player = this.getPlayer(address)!;
    if (player.scrap < cost) {
      return fail('insufficient', `Building there costs ${formatTurf(cost)} TURF and you have ${formatTurf(player.scrap)}.`);
    }

    this.sql.exec('UPDATE players SET scrap = scrap - ? WHERE address = ?', cost, address);
    tile.level += 1;
    this.writeTile(tile);

    const after = this.loadTiles();
    return { ok: true, data: this.meState(address, after, now)! };
  }

  /**
   * Opens a raid on an adjacent enemy tile.
   *
   * The committed pressure is escrowed immediately, so a player can never
   * commit the same TURF to two raids at once.
   */
  async openSiege(
    rawAddress: string,
    tileId: number,
    pressure: number,
    now: number,
  ): Promise<ActionResult<{ me: MeState; siege: Siege }>> {
    await this.tick(now);
    const address = normaliseAddress(rawAddress);
    if (!this.getPlayer(address)) return fail('no_player', 'Sign in before raiding.');
    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= TILE_COUNT) {
      return fail('bad_tile', 'That tile does not exist.');
    }

    const wanted = Math.floor(Number(pressure));
    const tiles = this.loadTiles();
    const tile = tiles[tileId];

    const rates = this.ratesByOwner(tiles, now);
    this.settle(address, rates.get(address) ?? 0, now);
    const player = this.getPlayer(address)!;

    const [{ n: onTile }] = this.sql
      .exec<CountRow>("SELECT COUNT(*) AS n FROM sieges WHERE tile_id = ? AND state = 'active'", tileId)
      .toArray();

    const rejection = checkSiege({
      tile,
      tiles,
      attacker: address,
      attackerScrap: player.scrap,
      pressure: wanted,
      activeSiegesByAttacker: this.activeSiegeCount(address),
      maxConcurrentSieges: MAX_CONCURRENT_SIEGES,
      tileHasActiveSiege: onTile > 0,
      now,
    });
    if (rejection) return fail(rejection, SIEGE_REJECTION_MESSAGES[rejection]);

    const baseDefense = tileDefense(tile);
    const duration = siegeDurationSeconds(wanted, baseDefense);
    const id = crypto.randomUUID();

    this.sql.exec('UPDATE players SET scrap = scrap - ? WHERE address = ?', wanted, address);
    this.sql.exec(
      'INSERT INTO sieges (id, tile_id, attacker, defender, pressure, reinforcement, base_defense, started_at, resolves_at, state) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
      id,
      tileId,
      address,
      tile.owner,
      wanted,
      baseDefense,
      now,
      now + duration * 1000,
      'active',
    );

    if (tile.owner) {
      this.addEvent(
        tile.owner,
        'under_siege',
        `${this.getPlayer(address)?.name ?? 'A rival'} is raiding ${tileLabel(tileId)}. Reinforce it before the timer runs out.`,
        tileId,
        now,
      );
    }

    await this.scheduleNextAlarm();

    const row = this.sql.exec<SiegeRow>('SELECT * FROM sieges WHERE id = ?', id).toArray()[0];
    const after = this.loadTiles();
    return { ok: true, data: { me: this.meState(address, after, now)!, siege: this.toSiege(row) } };
  }

  /** Commits extra TURF to defend a tile currently under raid. */
  async reinforce(
    rawAddress: string,
    siegeId: string,
    amount: number,
    now: number,
  ): Promise<ActionResult<{ me: MeState; siege: Siege }>> {
    await this.tick(now);
    const address = normaliseAddress(rawAddress);
    if (!this.getPlayer(address)) return fail('no_player', 'Sign in before defending.');

    const rows = this.sql.exec<SiegeRow>('SELECT * FROM sieges WHERE id = ?', siegeId).toArray();
    const row = rows[0];
    if (!row) return fail('no_siege', 'That raid no longer exists.');
    if (row.state !== 'active') return fail('resolved', 'That raid has already been resolved.');

    const tiles = this.loadTiles();
    const tile = tiles[row.tile_id];
    if (tile.owner !== address) return fail('not_owner', 'You can only reinforce blocks you hold.');

    const wanted = Math.floor(Number(amount));
    if (!Number.isFinite(wanted) || wanted <= 0) return fail('bad_amount', 'Enter how much TURF to commit.');

    const rates = this.ratesByOwner(tiles, now);
    this.settle(address, rates.get(address) ?? 0, now);
    const player = this.getPlayer(address)!;
    if (player.scrap < wanted) {
      return fail('insufficient', `You only have ${formatTurf(player.scrap)} TURF to commit.`);
    }

    this.sql.exec('UPDATE players SET scrap = scrap - ? WHERE address = ?', wanted, address);
    this.sql.exec('UPDATE sieges SET reinforcement = reinforcement + ? WHERE id = ?', wanted, siegeId);

    const updated = this.sql.exec<SiegeRow>('SELECT * FROM sieges WHERE id = ?', siegeId).toArray()[0];
    const after = this.loadTiles();
    return { ok: true, data: { me: this.meState(address, after, now)!, siege: this.toSiege(updated) } };
  }

  /** Renames a player. */
  async setName(rawAddress: string, name: string, now: number): Promise<ActionResult<MeState>> {
    const address = normaliseAddress(rawAddress);
    if (!this.getPlayer(address)) return fail('no_player', 'Sign in first.');
    const clean = name.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16);
    if (clean.length < 2) return fail('bad_name', 'Pick a name of at least 2 characters.');
    this.sql.exec('UPDATE players SET name = ? WHERE address = ?', clean, address);
    return { ok: true, data: this.meState(address, this.loadTiles(), now)! };
  }

  /** Changes a player's pixel palette. */
  async setColour(rawAddress: string, colorIndex: number, now: number): Promise<ActionResult<MeState>> {
    const address = normaliseAddress(rawAddress);
    if (!this.getPlayer(address)) return fail('no_player', 'Sign in first.');
    const idx = Math.max(0, Math.min(PLAYER_COLOURS - 1, Math.floor(Number(colorIndex) || 0)));
    this.sql.exec('UPDATE players SET color_index = ? WHERE address = ?', idx, address);
    return { ok: true, data: this.meState(address, this.loadTiles(), now)! };
  }


  // -------------------------------------------------------------------------
  // Deeds - the on-chain layer
  // -------------------------------------------------------------------------

  /**
   * Returns the exact payment a deed for this tile requires.
   *
   * Deliberately refuses while the tile is under raid: a player must not be
   * able to spend NIM to escape a siege they are losing. NIM buys permanence
   * and yield in peacetime, never a rescue mid-fight, so the war stays decided
   * by play rather than by wallet size.
   */
  async prepareDeed(
    rawAddress: string,
    tileId: number,
    now: number,
  ): Promise<ActionResult<{ treasury: string; valueLuna: number; data: string; label: string }>> {
    await this.tick(now);
    const address = normaliseAddress(rawAddress);
    if (!this.getPlayer(address)) return fail('no_player', 'Sign in first.');

    const treasury = this.env.TREASURY_ADDRESS ? normaliseAddress(this.env.TREASURY_ADDRESS) : '';
    if (!treasury) return fail('no_treasury', 'Deeds are temporarily unavailable: no treasury address is configured.');

    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= TILE_COUNT) {
      return fail('bad_tile', 'That tile does not exist.');
    }

    const tiles = this.loadTiles();
    const tile = tiles[tileId];
    if (tile.owner !== address) return fail('not_owner', 'You can only deed blocks you hold.');
    if (tile.deedUntil > now) return fail('already_deeded', 'That block already has an active deed.');

    const [{ n }] = this.sql
      .exec<CountRow>("SELECT COUNT(*) AS n FROM sieges WHERE tile_id = ? AND state = 'active'", tileId)
      .toArray();
    if (n > 0) {
      return fail('under_siege', 'You cannot deed a block while it is under raid. Reinforce it instead.');
    }

    return {
      ok: true,
      data: {
        treasury,
        valueLuna: DEED_PRICE_LUNA,
        data: encodeDeedData(this.env.SEASON_ID, tileId),
        label: tileLabel(tileId),
      },
    };
  }

  /**
   * Records a deed after its NIM transaction has been confirmed on chain.
   *
   * The caller (the Worker) is responsible for having actually verified the
   * transaction against the Nimiq network first; this method enforces the
   * game-side rules and, critically, that one transaction hash can only ever
   * be redeemed once.
   */
  async grantDeed(
    rawAddress: string,
    tileId: number,
    txHash: string,
    now: number,
  ): Promise<ActionResult<{ me: MeState; deedUntil: number }>> {
    await this.tick(now);
    const address = normaliseAddress(rawAddress);
    if (!this.getPlayer(address)) return fail('no_player', 'Sign in first.');

    const hash = txHash.trim().toLowerCase();
    const existing = this.sql
      .exec<DeedRow>('SELECT tile_id, address FROM deeds WHERE tx_hash = ?', hash)
      .toArray()[0];
    if (existing) {
      // Idempotent: replaying the same claim for the same tile is a no-op
      // success, which makes the client safe to retry on a flaky connection.
      if (existing.address === address && existing.tile_id === tileId) {
        const tiles = this.loadTiles();
        return { ok: true, data: { me: this.meState(address, tiles, now)!, deedUntil: tiles[tileId].deedUntil } };
      }
      return fail('tx_used', 'That transaction has already been used to mint a deed.');
    }

    const tiles = this.loadTiles();
    const tile = tiles[tileId];
    if (tile.owner !== address) return fail('not_owner', 'You can only deed blocks you hold.');

    const [{ n }] = this.sql
      .exec<CountRow>("SELECT COUNT(*) AS n FROM sieges WHERE tile_id = ? AND state = 'active'", tileId)
      .toArray();
    if (n > 0) return fail('under_siege', 'You cannot deed a block while it is under raid.');

    // A deed raises the tile's yield, so bank income at the old rate first.
    const rates = this.ratesByOwner(tiles, now);
    this.settle(address, rates.get(address) ?? 0, now);

    tile.deedUntil = now + DEED_DURATION_SECONDS * 1000;
    tile.deedTxHash = hash;
    this.writeTile(tile);

    this.sql.exec(
      'INSERT INTO deeds (tx_hash, address, tile_id, minted_at) VALUES (?, ?, ?, ?)',
      hash,
      address,
      tileId,
      now,
    );
    this.addEvent(
      address,
      'deed_minted',
      `Deed minted on ${tileLabel(tileId)}. It is raid-proof and earns more for the next 7 days.`,
      tileId,
      now,
    );

    const after = this.loadTiles();
    return { ok: true, data: { me: this.meState(address, after, now)!, deedUntil: tile.deedUntil } };
  }

  /** Public audit trail: every deed ever minted, with its transaction hash. */
  async deedLog(limit = 50): Promise<Array<{ txHash: string; address: string; tileId: number; label: string; mintedAt: number }>> {
    const rows = this.sql
      .exec<DeedLogRow>(
        'SELECT * FROM deeds ORDER BY minted_at DESC LIMIT ?',
        Math.max(1, Math.min(limit, 200)),
      )
      .toArray();
    return rows.map((r) => ({
      txHash: r.tx_hash,
      address: r.address,
      tileId: r.tile_id,
      label: tileLabel(r.tile_id),
      mintedAt: r.minted_at,
    }));
  }

}
