import { MAX_LEVEL, TERRAINS, hash32, type Terrain } from '@nimturf/shared';

/**
 * Procedural pixel-art sprite atlas.
 *
 * Every sprite is drawn one pixel at a time into an offscreen canvas at
 * startup, so the game ships no image assets: the art is code. That keeps the
 * payload tiny, stays crisp at any integer zoom, and means all of it is
 * original work under the project's own licence.
 *
 * Layout (16x16 cells):
 *   row 0        terrain, 4 deterministic variants per type
 *   rows 1..8    buildings, one row per owner colour, levels 1..10 across
 *   row 9        overlays: deed seal, raid marker, selection frame
 */

export const TILE_PX = 16;
const VARIANTS = 4;
const OWNER_COLOURS = 8;

/** Owner palette, matched to the --owner-N custom properties in index.css. */
export const OWNER_HEX = [
  '#1f9ce4',
  '#e0533f',
  '#21bca5',
  '#e9b213',
  '#a06ce0',
  '#e07ab8',
  '#7fc93a',
  '#e08a2e',
] as const;

/** 4x4 Bayer matrix: gives texture an authentic ordered-dither look. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${((clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).padStart(6, '0')}`;
}

/** Lightens (amount > 0) or darkens (amount < 0) a colour. */
export function shade(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  return rgbToHex({ r: r + (t - r) * p, g: g + (t - g) * p, b: b + (t - b) * p });
}

/** Per-terrain palettes: base, dither highlight, and detail accents. */
const TERRAIN_PALETTE: Record<Terrain, { base: string; dither: string; detail: string; accent: string }> = {
  concrete: { base: '#2c3145', dither: '#353b53', detail: '#454c68', accent: '#1e2233' },
  park: { base: '#1f3a2b', dither: '#27492f', detail: '#3c6b3a', accent: '#16281f' },
  docks: { base: '#16324a', dither: '#1c4260', detail: '#2f6d8f', accent: '#0f2436' },
  market: { base: '#4a3520', dither: '#5c4227', detail: '#8a5f2e', accent: '#33240f' },
  tower: { base: '#26293a', dither: '#2e3247', detail: '#3b4058', accent: '#1a1c28' },
};

type Ctx = CanvasRenderingContext2D;

/** Sets a single pixel. All sprite drawing is built from this. */
function px(ctx: Ctx, x: number, y: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, 1, 1);
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, w, h);
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function drawTerrain(ctx: Ctx, ox: number, oy: number, terrain: Terrain, variant: number): void {
  const pal = TERRAIN_PALETTE[terrain];
  rect(ctx, ox, oy, TILE_PX, TILE_PX, pal.base);

  // Ordered dither, seeded per variant so the four variants differ.
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const noise = hash32(variant + 1, x, y) % 16;
      if (noise > BAYER[y % 4][x % 4]) px(ctx, ox + x, oy + y, pal.dither);
    }
  }

  switch (terrain) {
    case 'concrete': {
      // Kerb lines suggesting a street grid.
      for (let x = 0; x < TILE_PX; x++) px(ctx, ox + x, oy + (variant % 2 === 0 ? 7 : 8), pal.accent);
      for (let y = 0; y < TILE_PX; y++) px(ctx, ox + (variant < 2 ? 7 : 8), oy + y, pal.accent);
      break;
    }
    case 'park': {
      // A few deterministic shrubs.
      for (let i = 0; i < 5; i++) {
        const h = hash32(variant + 11, i, 3);
        const bx = h % 13;
        const by = (h >> 8) % 13;
        rect(ctx, ox + bx, oy + by, 2, 2, pal.detail);
        px(ctx, ox + bx, oy + by + 2, pal.accent);
      }
      break;
    }
    case 'docks': {
      // Horizontal wave crests plus a plank edge.
      for (let y = 2; y < TILE_PX; y += 4) {
        const offset = hash32(variant + 21, y, 0) % 4;
        for (let x = 0; x < TILE_PX; x += 4) px(ctx, ox + ((x + offset) % TILE_PX), oy + y, pal.detail);
      }
      rect(ctx, ox, oy + 14, TILE_PX, 2, '#3a2f22');
      for (let x = 1; x < TILE_PX; x += 3) px(ctx, ox + x, oy + 15, '#241d14');
      break;
    }
    case 'market': {
      // A single inset stall with a striped awning. Keeping it inset by two
      // pixels is what stops a block of markets reading as one long banner.
      const top = 4 + (variant % 2);
      const left = 2;
      const width = TILE_PX - 4;
      for (let x = 0; x < width; x++) {
        rect(ctx, ox + left + x, oy + top, 1, 2, x % 2 === 0 ? '#c4482f' : '#e8e0cf');
      }
      // Awning scallops and posts, so the stall has a silhouette.
      rect(ctx, ox + left, oy + top + 2, width, 1, pal.accent);
      rect(ctx, ox + left, oy + top + 2, 1, 5, pal.detail);
      rect(ctx, ox + left + width - 1, oy + top + 2, 1, 5, pal.detail);
      // Counter and crates.
      rect(ctx, ox + left + 1, oy + top + 5, width - 2, 2, '#8a5f2e');
      rect(ctx, ox + 4, oy + 12, 3, 2, pal.detail);
      rect(ctx, ox + 9, oy + 12, 2, 2, pal.detail);
      break;
    }
    case 'tower': {
      // Vertical concrete ribs.
      for (let x = 1; x < TILE_PX; x += 5) {
        for (let y = 0; y < TILE_PX; y++) px(ctx, ox + x + (variant % 2), oy + y, pal.detail);
      }
      break;
    }
  }

  /*
   * A faint edge on two sides of every tile. Without it, neighbouring tiles of
   * the same terrain merge into one continuous mass and the board stops
   * reading as a grid of city blocks - which is the thing players are actually
   * claiming and fighting over.
   */
  const edge = shade(pal.base, -0.35);
  for (let i = 0; i < TILE_PX; i++) {
    px(ctx, ox + i, oy + TILE_PX - 1, edge);
    px(ctx, ox + TILE_PX - 1, oy + i, edge);
  }
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/**
 * A building whose footprint and height grow with level, so a player can read
 * the whole board's development at a glance without any numbers.
 */
function drawBuilding(ctx: Ctx, ox: number, oy: number, level: number, colour: string): void {
  const l = Math.max(1, Math.min(MAX_LEVEL, level));

  // Width 6 -> 12, height 4 -> 13 across the ten levels.
  const w = Math.round(6 + ((12 - 6) * (l - 1)) / (MAX_LEVEL - 1));
  const h = Math.round(4 + ((13 - 4) * (l - 1)) / (MAX_LEVEL - 1));
  const x = ox + Math.floor((TILE_PX - w) / 2);
  const y = oy + TILE_PX - h - 1;

  const wall = colour;
  const lit = shade(colour, 0.32);
  const dark = shade(colour, -0.45);
  const outline = shade(colour, -0.7);

  // Body with a lit left edge and shaded right edge for a sense of volume.
  rect(ctx, x, y, w, h, wall);
  rect(ctx, x, y, 1, h, lit);
  rect(ctx, x + w - 1, y, 1, h, dark);
  rect(ctx, x, y, w, 1, lit);
  // Ground shadow.
  rect(ctx, x, oy + TILE_PX - 1, w, 1, outline);

  // Windows: a 2px grid, inset by one pixel, lit in warm gold.
  const glow = '#ffd76b';
  for (let wy = y + 2; wy < y + h - 1; wy += 3) {
    for (let wx = x + 2; wx < x + w - 2; wx += 3) {
      // Deterministic: some windows are dark, which reads as inhabited.
      const on = hash32(l * 7 + 5, wx - x, wy - y) % 5 !== 0;
      px(ctx, wx, wy, on ? glow : outline);
    }
  }

  // A roof aerial once the block is genuinely tall.
  if (l >= 7) {
    rect(ctx, x + Math.floor(w / 2), y - 2, 1, 2, dark);
    px(ctx, x + Math.floor(w / 2), y - 3, glow);
  }
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/** A gold wax seal: marks a tile with an on-chain deed. */
function drawDeedSeal(ctx: Ctx, ox: number, oy: number): void {
  const gold = '#e9b213';
  const light = '#ffdc6a';
  const dark = '#8a6408';
  rect(ctx, ox + 10, oy + 1, 5, 5, gold);
  rect(ctx, ox + 10, oy + 1, 5, 1, light);
  rect(ctx, ox + 10, oy + 5, 5, 1, dark);
  px(ctx, ox + 12, oy + 3, dark);
  px(ctx, ox + 11, oy + 6, dark);
  px(ctx, ox + 13, oy + 6, dark);
}

/** Crossed-swords style marker for a tile under raid. */
function drawRaidMarker(ctx: Ctx, ox: number, oy: number): void {
  const red = '#e0533f';
  const light = '#ff9b8a';
  for (let i = 0; i < 5; i++) {
    px(ctx, ox + 1 + i, oy + 1 + i, red);
    px(ctx, ox + 5 - i, oy + 1 + i, light);
  }
  px(ctx, ox + 3, oy + 3, '#fff1ee');
}

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

export interface Atlas {
  canvas: HTMLCanvasElement;
  /** Source rect for a terrain sprite. */
  terrain(terrain: Terrain, variant: number): { sx: number; sy: number };
  /** Source rect for a building sprite. */
  building(colorIndex: number, level: number): { sx: number; sy: number };
  deedSeal: { sx: number; sy: number };
  raidMarker: { sx: number; sy: number };
}

let atlas: Atlas | null = null;

/**
 * Builds the atlas once and caches it. Called lazily so it never runs during
 * module import, which keeps it out of the critical path for first paint.
 */
export function getAtlas(): Atlas {
  if (atlas) return atlas;

  const cols = Math.max(TERRAINS.length * VARIANTS, MAX_LEVEL);
  const rows = 1 + OWNER_COLOURS + 1;

  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE_PX;
  canvas.height = rows * TILE_PX;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot render the NimTurf map (no 2D canvas).');
  ctx.imageSmoothingEnabled = false;

  // Row 0: terrain.
  TERRAINS.forEach((terrain, ti) => {
    for (let v = 0; v < VARIANTS; v++) {
      drawTerrain(ctx, (ti * VARIANTS + v) * TILE_PX, 0, terrain, v);
    }
  });

  // Rows 1..8: buildings per owner colour.
  for (let c = 0; c < OWNER_COLOURS; c++) {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      drawBuilding(ctx, (level - 1) * TILE_PX, (1 + c) * TILE_PX, level, OWNER_HEX[c]);
    }
  }

  // Last row: overlays.
  const overlayRow = (1 + OWNER_COLOURS) * TILE_PX;
  drawDeedSeal(ctx, 0, overlayRow);
  drawRaidMarker(ctx, TILE_PX, overlayRow);

  atlas = {
    canvas,
    terrain: (terrain, variant) => {
      const ti = TERRAINS.indexOf(terrain);
      const safeIndex = ti < 0 ? 0 : ti;
      return { sx: (safeIndex * VARIANTS + (variant % VARIANTS)) * TILE_PX, sy: 0 };
    },
    building: (colorIndex, level) => ({
      sx: (Math.max(1, Math.min(MAX_LEVEL, level)) - 1) * TILE_PX,
      sy: (1 + (((colorIndex % OWNER_COLOURS) + OWNER_COLOURS) % OWNER_COLOURS)) * TILE_PX,
    }),
    deedSeal: { sx: 0, sy: overlayRow },
    raidMarker: { sx: TILE_PX, sy: overlayRow },
  };

  return atlas;
}

/** Which of the four terrain variants a given tile uses. Stable per tile. */
export function terrainVariant(seed: number, tileId: number): number {
  return hash32(seed ^ 0x5bf03635, tileId, 7) % VARIANTS;
}

/** The CSS colour for an owner index. */
export function ownerColour(colorIndex: number): string {
  return OWNER_HEX[((colorIndex % OWNER_COLOURS) + OWNER_COLOURS) % OWNER_COLOURS];
}
