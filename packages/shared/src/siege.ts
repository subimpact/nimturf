import {
  BP,
  CAPTURE_IMMUNITY_SECONDS,
  SIEGE_BASE_SECONDS,
  SIEGE_CAPTURE_LEVEL_LOSS,
  SIEGE_DEFENSE_REFUND_BP,
  SIEGE_LOSS_REFUND_BP,
  SIEGE_MAX_SECONDS,
  SIEGE_MIN_SECONDS,
  SIEGE_WIN_MARGIN_BP,
} from './constants';
import { tileDefense } from './economy';
import type { Siege, Tile } from './types';
import { neighbourIds } from './worldgen';

/**
 * Turf war resolution.
 *
 * NimTurf contains no random number generator anywhere in its rules. A siege
 * is a public, timed auction over a tile: the attacker commits scrap, the
 * defender sees the exact number they must beat, and whoever has committed
 * more when the clock runs out wins. Both sides can compute the outcome in
 * advance at every moment, so results are decided purely by resource
 * management, target selection and timing.
 */

/**
 * How long a siege takes. Committing more pressure resolves it faster, which
 * is the central tension: an overwhelming assault gives the defender almost
 * no time to answer but costs far more than the tile is worth, while a cheap
 * siege telegraphs itself for hours.
 */
export function siegeDurationSeconds(pressure: number, defense: number): number {
  const p = Math.max(1, Math.floor(pressure));
  const d = Math.max(1, Math.floor(defense));
  const raw = Math.floor((SIEGE_BASE_SECONDS * d) / p);
  return Math.min(Math.max(raw, SIEGE_MIN_SECONDS), SIEGE_MAX_SECONDS);
}

/** Total scrap the attacker must exceed at resolution time. */
export function requiredPressure(siege: Pick<Siege, 'baseDefense' | 'reinforcement'>): number {
  const total = siege.baseDefense + siege.reinforcement;
  return Math.floor((total * SIEGE_WIN_MARGIN_BP) / BP);
}

/** True when the attacker would currently win if the clock ran out now. */
export function attackerIsWinning(siege: Pick<Siege, 'baseDefense' | 'reinforcement' | 'pressure'>): boolean {
  return siege.pressure > requiredPressure(siege);
}

export type SiegeRejection =
  | 'not_adjacent'
  | 'own_tile'
  | 'unowned_tile'
  | 'already_under_siege'
  | 'capture_immunity'
  | 'deed_protected'
  | 'insufficient_scrap'
  | 'pressure_too_low'
  | 'too_many_sieges';

export interface SiegeCheckInput {
  tile: Tile;
  tiles: readonly Tile[];
  attacker: string;
  attackerScrap: number;
  pressure: number;
  activeSiegesByAttacker: number;
  maxConcurrentSieges: number;
  tileHasActiveSiege: boolean;
  now: number;
}

/**
 * Validates a siege before it opens. Returns null when the move is legal, or
 * a machine-readable reason the UI turns into a specific, actionable message.
 */
export function checkSiege(input: SiegeCheckInput): SiegeRejection | null {
  const { tile, tiles, attacker, attackerScrap, pressure, now } = input;

  if (!tile.owner) return 'unowned_tile';
  if (tile.owner === attacker) return 'own_tile';
  if (input.tileHasActiveSiege) return 'already_under_siege';
  if (tile.deedUntil > now) return 'deed_protected';
  if (now - tile.capturedAt < CAPTURE_IMMUNITY_SECONDS * 1000) return 'capture_immunity';
  if (input.activeSiegesByAttacker >= input.maxConcurrentSieges) return 'too_many_sieges';

  const adjacent = neighbourIds(tile.id).some((nid) => tiles[nid]?.owner === attacker);
  if (!adjacent) return 'not_adjacent';

  if (!Number.isFinite(pressure) || pressure <= 0) return 'pressure_too_low';
  if (pressure > attackerScrap) return 'insufficient_scrap';

  // A siege must be worth opening: at least a tenth of the tile's defense.
  if (pressure < Math.floor(tileDefense(tile) / 10)) return 'pressure_too_low';

  return null;
}

export interface SiegeOutcome {
  captured: boolean;
  /** Scrap returned to the attacker. */
  attackerRefund: number;
  /** Scrap returned to the defender. */
  defenderRefund: number;
  /** Level the tile ends up at. */
  newLevel: number;
}

/**
 * Resolves a siege. Pure: given the same siege it always produces the same
 * outcome, on the client and on the server alike.
 */
export function resolveSiege(siege: Siege, tile: Tile): SiegeOutcome {
  const captured = attackerIsWinning(siege);

  if (captured) {
    return {
      captured: true,
      attackerRefund: 0,
      defenderRefund: 0,
      newLevel: Math.max(1, tile.level - SIEGE_CAPTURE_LEVEL_LOSS),
    };
  }

  return {
    captured: false,
    attackerRefund: Math.floor((siege.pressure * SIEGE_LOSS_REFUND_BP) / BP),
    defenderRefund: Math.floor((siege.reinforcement * SIEGE_DEFENSE_REFUND_BP) / BP),
    newLevel: tile.level,
  };
}

/** Human-readable explanation for each rejection, shared by every surface. */
export const SIEGE_REJECTION_MESSAGES: Record<SiegeRejection, string> = {
  not_adjacent: 'You can only raid tiles next to territory you already hold.',
  own_tile: 'That tile is already yours.',
  unowned_tile: 'Nobody holds that tile - claim it instead of raiding it.',
  already_under_siege: 'That tile is already under siege. Wait for it to resolve.',
  capture_immunity: 'That tile just changed hands and is still consolidating.',
  deed_protected: 'A Nimiq deed protects that tile. It cannot be raided until the deed expires.',
  insufficient_scrap: 'You do not have enough TURF to commit that much pressure.',
  pressure_too_low: 'That is not enough pressure to be worth committing.',
  too_many_sieges: 'You are already running the maximum number of raids.',
};
