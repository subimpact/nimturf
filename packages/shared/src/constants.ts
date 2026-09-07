/**
 * NimTurf game constants.
 *
 * Every number that affects gameplay lives here so that the client and the
 * server share one single source of truth.
 *
 * All balances are whole TURF held as integers, and all multipliers are basis
 * points (1/10000). Keeping the economy in integers is what makes the
 * simulation exactly reproducible on the client and the server with no
 * floating-point drift. The internal field name for a balance is `scrap`,
 * which is simply the integer unit of TURF.
 */

/** Basis-point denominator. 10000bp = 1.0x */
export const BP = 10000;

/** Square world. 24x24 = 576 tiles per season. */
export const WORLD_SIZE = 24;
export const TILE_COUNT = WORLD_SIZE * WORLD_SIZE;

/** Highest upgrade level a tile can reach. */
export const MAX_LEVEL = 10;

export const TERRAINS = ['concrete', 'park', 'docks', 'market', 'tower'] as const;
export type Terrain = (typeof TERRAINS)[number];

/**
 * Per-terrain balance. `yieldScrap` is scrap/second at level 1, `defenseBp`
 * scales how expensive the tile is to take, `claimBp` scales the claim price.
 * Terrain is the core strategic trade-off: markets pay well but barely defend
 * themselves, towers are fortresses that earn little.
 */
export const TERRAIN_STATS: Record<Terrain, { yieldScrap: number; defenseBp: number; claimBp: number; label: string }> = {
  concrete: { yieldScrap: 10, defenseBp: 10000, claimBp: 10000, label: 'Concrete' },
  park:     { yieldScrap: 7,  defenseBp: 7000,  claimBp: 7000,  label: 'Park' },
  docks:    { yieldScrap: 16, defenseBp: 9000,  claimBp: 14000, label: 'Docks' },
  market:   { yieldScrap: 22, defenseBp: 6000,  claimBp: 17000, label: 'Market' },
  tower:    { yieldScrap: 9,  defenseBp: 16000, claimBp: 15000, label: 'Tower Block' },
};

/**
 * Yield multiplier per tile level, in bp. Exponential growth (~1.55x/level) is
 * what gives an incremental game its pull. A lookup table rather than
 * Math.pow keeps client and server bit-identical.
 */
export const LEVEL_YIELD_BP = [
  0,      // level 0 (unused)
  10000,  // 1  1.00x
  15500,  // 2  1.55x
  24000,  // 3
  37200,  // 4
  57700,  // 5
  89400,  // 6
  138600, // 7
  214800, // 8
  333000, // 9
  516100, // 10
] as const;

/** Defense multiplier per level, in bp. Grows slower than yield, so tall
 * stacks are lucrative but raidable - the central risk/reward decision. */
export const LEVEL_DEFENSE_BP = [
  0,
  10000, 13000, 16900, 21900, 28500, 37000, 48100, 62500, 81200, 105600,
] as const;

/** Cost in scrap to upgrade a tile FROM the given level to the next. */
export const UPGRADE_COST_SCRAP = [
  0,
  600,    // 1 -> 2
  1_600,
  4_200,
  11_000,
  28_000,
  72_000,
  186_000,
  480_000,
  1_240_000, // 9 -> 10
] as const;

/** Base scrap price to claim an unowned tile, before terrain multiplier. */
export const BASE_CLAIM_SCRAP = 900;

/** Each tile you already own raises the price of the next claim by 8%,
 * so unchecked sprawl is self-limiting without any hard cap. */
export const CLAIM_ESCALATION_BP = 800;

/** Adjacency: +12% yield per orthogonally adjacent tile you own, max 4. */
export const ADJACENCY_BONUS_BP = 1200;
export const ADJACENCY_MAX = 4;

/** Half of the adjacency bonus applies for tiles owned by your alliance. */
export const ALLY_ADJACENCY_BONUS_BP = 600;

/** Offline earnings are capped so the game rewards checking in without
 * punishing people who sleep. 8 hours of full accrual. */
export const OFFLINE_CAP_SECONDS = 8 * 60 * 60;

// ---------------------------------------------------------------------------
// Siege (the "turf war")
// ---------------------------------------------------------------------------

/**
 * Sieges are fully deterministic: no dice, no hidden information. The attacker
 * commits scrap, the defender sees it immediately and has until `resolvesAt`
 * to out-commit them. Higher pressure resolves faster, which is the core
 * timing decision - a cheap siege gives your target all day to answer.
 */
/** Innate defense of a level-1 concrete tile, in scrap. Everything else
 * scales off this, so one number tunes the whole war economy. */
export const BASE_DEFENSE_SCRAP = 1_200;

export const SIEGE_MIN_SECONDS = 5 * 60;
export const SIEGE_MAX_SECONDS = 6 * 60 * 60;
export const SIEGE_BASE_SECONDS = 45 * 60;

/** Attacker must beat defense by this margin (bp) to take the tile. */
export const SIEGE_WIN_MARGIN_BP = 10000;

/** A failed siege refunds this share of committed pressure. Losing hurts,
 * but never wipes you out - that keeps players in the game. */
export const SIEGE_LOSS_REFUND_BP = 4000;

/** A successful siege drops the captured tile by this many levels. */
export const SIEGE_CAPTURE_LEVEL_LOSS = 1;

/** Defender's reinforcement is refunded at this rate if they successfully
 * hold, so defending is cheap and always worth doing. */
export const SIEGE_DEFENSE_REFUND_BP = 7000;

/**
 * A tile cannot be raided again this soon after being *taken by force*, giving
 * the new owner time to consolidate. Peaceful claims of neutral ground do not
 * get this shield - see World.claim.
 */
export const CAPTURE_IMMUNITY_SECONDS = 30 * 60;

/** How many sieges a player can run at once, by HQ level. */
export const MAX_CONCURRENT_SIEGES = 3;

// ---------------------------------------------------------------------------
// Deeds - the on-chain layer
// ---------------------------------------------------------------------------

/**
 * A Deed is minted by a real NIM transaction whose data field records the
 * claim on the Nimiq blockchain. It makes a tile siege-immune for a period
 * and raises its yield. Deeds are a utility purchase, never a wager: the
 * price is fixed and the effect is guaranteed and identical for everyone.
 */
export const DEED_PRICE_LUNA = 200_000; // 2 NIM (1 NIM = 1e5 Luna)
export const DEED_DURATION_SECONDS = 7 * 24 * 60 * 60;
export const DEED_YIELD_BONUS_BP = 2500; // +25%

/** Prefix written into the Nimiq transaction data field. Anyone can verify a
 * deed by looking the transaction up on a Nimiq block explorer. */
export const DEED_DATA_PREFIX = 'NIMTURF';

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/**
 * Starting balance.
 *
 * Enough for the free first block plus three or four more, so a new player can
 * immediately form a contiguous plot and feel the adjacency bonus rather than
 * claiming one tile and being told to come back later. The first two minutes
 * decide whether anyone plays a second time.
 */
export const STARTING_SCRAP = 5_000;

/** Every player's first tile is free. */
export const FREE_FIRST_CLAIM = true;
