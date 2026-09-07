import type { Terrain } from './constants';

export type TileId = number; // y * WORLD_SIZE + x

export interface Tile {
  id: TileId;
  x: number;
  y: number;
  terrain: Terrain;
  /** Owning player address, or null when unclaimed. */
  owner: string | null;
  level: number;
  /** ms epoch the tile last had its yield banked. */
  settledAt: number;
  /** ms epoch the tile last changed hands (drives capture immunity). */
  capturedAt: number;
  /** ms epoch a deed on this tile expires, or 0 for none. */
  deedUntil: number;
  /** Nimiq transaction hash that minted the active deed, for public audit. */
  deedTxHash: string | null;
}

export interface Player {
  address: string;
  /** Short display name, defaults to a shortened address. */
  name: string;
  /** Banked balance in scrap. Live balance = banked + unsettled accrual. */
  scrap: number;
  tileCount: number;
  createdAt: number;
  settledAt: number;
  /** Lifetime scrap earned - the leaderboard's primary sort key. */
  lifetimeScrap: number;
  allianceId: string | null;
  /** Cosmetic pixel palette index chosen by the player. */
  colorIndex: number;
}

export type SiegeState = 'active' | 'won' | 'held';

export interface Siege {
  id: string;
  tileId: TileId;
  attacker: string;
  /** Defender address at the time the siege opened, or null for a neutral tile. */
  defender: string | null;
  /** Scrap committed by the attacker. */
  pressure: number;
  /** Scrap committed by the defender on top of the tile's innate defense. */
  reinforcement: number;
  /** Innate defense of the tile, snapshotted when the siege opened so that
   * both sides can see the exact number they need to beat. */
  baseDefense: number;
  startedAt: number;
  resolvesAt: number;
  state: SiegeState;
  resolvedAt: number | null;
}

export interface WorldMeta {
  seasonId: string;
  seed: number;
  startedAt: number;
  endsAt: number;
}

/** A single row of the public leaderboard. */
export interface LeaderboardEntry {
  rank: number;
  address: string;
  name: string;
  tileCount: number;
  lifetimeScrap: number;
  yieldPerSec: number;
  colorIndex: number;
}

/** Everything the client needs to render and simulate the world locally. */
export interface WorldSnapshot {
  meta: WorldMeta;
  tiles: Tile[];
  sieges: Siege[];
  players: Record<string, Pick<Player, 'address' | 'name' | 'colorIndex'>>;
  /** Server time when the snapshot was taken, so the client can correct clock skew. */
  now: number;
}

/** A player-visible record of something that happened, including while away. */
export interface GameEvent {
  id: number;
  address: string;
  kind: string;
  message: string;
  tile_id: number | null;
  created_at: number;
}

/**
 * The signed-in player's own live state. `scrap` and `lifetimeScrap` already
 * include income accrued since the last settle, so the client can display a
 * truthful balance without the server having to write on every read.
 */
export interface MeState {
  address: string;
  name: string;
  colorIndex: number;
  scrap: number;
  yieldPerSec: number;
  tileCount: number;
  lifetimeScrap: number;
  settledAt: number;
  createdAt: number;
  activeSieges: number;
}

/** The full payload behind GET /api/world. */
export interface SnapshotResponse extends WorldSnapshot {
  me: MeState | null;
  events: GameEvent[];
}

/** Envelope used by every API response, so the client has one error path. */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
