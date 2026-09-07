import { WORLD_SIZE, type Siege, type SnapshotResponse, type Tile } from '@nimturf/shared';
import { Minus, Plus, Crosshair } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TILE_PX, getAtlas, ownerColour, terrainVariant } from '@/lib/pixel';
import { cn } from '@/lib/utils';

/**
 * The world map.
 *
 * Rendered on a single canvas from the generated sprite atlas. Tiles are drawn
 * at an integer pixel size so the art never lands on a half pixel, which is
 * what keeps pixel art looking deliberate rather than blurry at any zoom.
 */

const MIN_TILE = 8;
const MAX_TILE = 44;

interface GameMapProps {
  snapshot: SnapshotResponse;
  selectedTileId: number | null;
  myAddress: string | null;
  onSelect: (tileId: number | null) => void;
}

interface View {
  tile: number; // pixels per tile
  x: number; // screen offset
  y: number;
}

export const GameMap = memo(function GameMap({
  snapshot,
  selectedTileId,
  myAddress,
  onSelect,
}: GameMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Interaction state lives in refs: it changes every pointer move and must
  // not trigger a React render.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const pinchStart = useRef<{ distance: number; tile: number } | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  const siegeByTile = useMemo(() => {
    const map = new Map<number, Siege>();
    for (const s of snapshot.sieges) map.set(s.tileId, s);
    return map;
  }, [snapshot.sieges]);

  /** Keeps the map from being panned entirely off screen. */
  const clampView = useCallback((next: View, w: number, h: number): View => {
    const world = WORLD_SIZE * next.tile;
    // Centre when the world is smaller than the viewport, otherwise allow
    // panning but always keep a quarter of the map in frame.
    const x = world <= w ? Math.round((w - world) / 2) : Math.min(w * 0.25, Math.max(w - world - w * 0.25, next.x));
    const y = world <= h ? Math.round((h - world) / 2) : Math.min(h * 0.25, Math.max(h - world - h * 0.25, next.y));
    return { ...next, x: Math.round(x), y: Math.round(y) };
  }, []);

  // Track the container size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  /** Centres the view on a tile at the given zoom. */
  const centreOn = useCallback(
    (tileId: number | null, tilePx: number, w: number, h: number): View => {
      const cx = tileId === null ? WORLD_SIZE / 2 : (tileId % WORLD_SIZE) + 0.5;
      const cy = tileId === null ? WORLD_SIZE / 2 : Math.floor(tileId / WORLD_SIZE) + 0.5;
      return clampView({ tile: tilePx, x: w / 2 - cx * tilePx, y: h / 2 - cy * tilePx }, w, h);
    },
    [clampView],
  );

  /**
   * Default zoom: fit the board's width so the entire city is visible at once.
   * A territory game where you cannot see the territory is unplayable, so
   * seeing everything wins over filling every pixel; the area outside the
   * board is painted as deliberate out-of-bounds ground rather than left as
   * dead space.
   */
  const coverTile = useCallback(
    (w: number, h: number) =>
      Math.max(MIN_TILE, Math.min(MAX_TILE, Math.floor(Math.min(w, h) / WORLD_SIZE) || MIN_TILE)),
    [],
  );

  useEffect(() => {
    if (view || size.w === 0 || size.h === 0) return;
    const mine = myAddress ? snapshot.tiles.find((t) => t.owner === myAddress) : undefined;
    setView(centreOn(mine ? mine.id : null, coverTile(size.w, size.h), size.w, size.h));
  }, [view, size, snapshot.tiles, myAddress, centreOn, coverTile]);

  // Re-clamp when the viewport changes.
  useEffect(() => {
    if (!view || size.w === 0) return;
    setView((v) => (v ? clampView(v, size.w, size.h) : v));
  }, [size, clampView]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const v = viewRef.current;
    if (!canvas || !v || size.w === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pixelW = Math.floor(size.w * dpr);
    const pixelH = Math.floor(size.h * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const atlas = getAtlas();
    const t = v.tile;
    const seed = snapshot.meta.seed;
    const world = WORLD_SIZE * t;

    // Out of bounds: a flat, slightly lighter void than the page, with a hard
    // border around the board so the city has an edge rather than fading out.
    ctx.fillStyle = '#070910';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.strokeStyle = '#242b45';
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(v.x) - 1, Math.round(v.y) - 1, world + 2, world + 2);

    // Only draw the tiles actually on screen.
    const firstX = Math.max(0, Math.floor((-v.x) / t));
    const lastX = Math.min(WORLD_SIZE - 1, Math.ceil((size.w - v.x) / t));
    const firstY = Math.max(0, Math.floor((-v.y) / t));
    const lastY = Math.min(WORLD_SIZE - 1, Math.ceil((size.h - v.y) / t));

    const tileAt = (x: number, y: number): Tile | undefined =>
      x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE ? undefined : snapshot.tiles[y * WORLD_SIZE + x];

    // Pass 1: terrain and buildings.
    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        const tile = tileAt(x, y);
        if (!tile) continue;
        const dx = Math.round(v.x + x * t);
        const dy = Math.round(v.y + y * t);

        const terrain = atlas.terrain(tile.terrain, terrainVariant(seed, tile.id));
        ctx.drawImage(atlas.canvas, terrain.sx, terrain.sy, TILE_PX, TILE_PX, dx, dy, t, t);

        if (tile.owner) {
          const colourIndex = snapshot.players[tile.owner]?.colorIndex ?? 0;
          const building = atlas.building(colourIndex, tile.level);
          ctx.drawImage(atlas.canvas, building.sx, building.sy, TILE_PX, TILE_PX, dx, dy, t, t);
        }
      }
    }

    // Pass 2: territory outlines. Drawing an edge only where the neighbour has
    // a different owner turns scattered tiles into readable territories.
    const edge = Math.max(1, Math.round(t / 12));
    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        const tile = tileAt(x, y);
        if (!tile?.owner) continue;
        const dx = Math.round(v.x + x * t);
        const dy = Math.round(v.y + y * t);
        const colourIndex = snapshot.players[tile.owner]?.colorIndex ?? 0;
        ctx.fillStyle = ownerColour(colourIndex);

        if (tileAt(x, y - 1)?.owner !== tile.owner) ctx.fillRect(dx, dy, t, edge);
        if (tileAt(x, y + 1)?.owner !== tile.owner) ctx.fillRect(dx, dy + t - edge, t, edge);
        if (tileAt(x - 1, y)?.owner !== tile.owner) ctx.fillRect(dx, dy, edge, t);
        if (tileAt(x + 1, y)?.owner !== tile.owner) ctx.fillRect(dx + t - edge, dy, edge, t);
      }
    }

    // Pass 3: overlays.
    const now = Date.now();
    const pulse = Math.floor(now / 550) % 2 === 0;
    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        const tile = tileAt(x, y);
        if (!tile) continue;
        const dx = Math.round(v.x + x * t);
        const dy = Math.round(v.y + y * t);

        if (tile.deedUntil > now) {
          ctx.drawImage(atlas.canvas, atlas.deedSeal.sx, atlas.deedSeal.sy, TILE_PX, TILE_PX, dx, dy, t, t);
        }

        if (siegeByTile.has(tile.id) && pulse) {
          ctx.drawImage(atlas.canvas, atlas.raidMarker.sx, atlas.raidMarker.sy, TILE_PX, TILE_PX, dx, dy, t, t);
          ctx.strokeStyle = '#e0533f';
          ctx.lineWidth = Math.max(1, edge);
          ctx.strokeRect(dx + 0.5, dy + 0.5, t - 1, t - 1);
        }

        // A soft marker on the player's own turf, so it is findable at a glance.
        if (myAddress && tile.owner === myAddress && t >= 14) {
          ctx.fillStyle = 'rgba(255,255,255,0.16)';
          ctx.fillRect(dx + Math.round(t / 2) - 1, dy + 2, 2, 2);
        }
      }
    }

    // Pass 4: selection frame, drawn last so it is never hidden.
    if (selectedTileId !== null) {
      const sx = selectedTileId % WORLD_SIZE;
      const sy = Math.floor(selectedTileId / WORLD_SIZE);
      const dx = Math.round(v.x + sx * t);
      const dy = Math.round(v.y + sy * t);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(dx - 1, dy - 1, t + 2, t + 2);
      ctx.strokeStyle = '#0a0c14';
      ctx.lineWidth = 1;
      ctx.strokeRect(dx - 2.5, dy - 2.5, t + 5, t + 5);
    }
  }, [size, snapshot, selectedTileId, siegeByTile, myAddress]);

  // Redraw on change, and keep a light animation loop running only while
  // there are raids to animate.
  useEffect(() => {
    draw();
    if (snapshot.sieges.length === 0) return;
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      // The pulse only changes twice a second; no need to redraw at 60fps.
      if (ts - last > 250) {
        draw();
        last = ts;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw, snapshot.sieges.length]);

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  const tileFromScreen = useCallback(
    (clientX: number, clientY: number): number | null => {
      const canvas = canvasRef.current;
      const v = viewRef.current;
      if (!canvas || !v) return null;
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((clientX - rect.left - v.x) / v.tile);
      const y = Math.floor((clientY - rect.top - v.y) / v.tile);
      if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) return null;
      return y * WORLD_SIZE + x;
    },
    [],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        tile: viewRef.current?.tile ?? MIN_TILE,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const previous = pointers.current.get(e.pointerId);
    if (!previous) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two fingers: pinch to zoom about the midpoint.
    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = distance / pinchStart.current.distance;
      const nextTile = Math.max(MIN_TILE, Math.min(MAX_TILE, Math.round(pinchStart.current.tile * ratio)));
      dragged.current = true;
      setView((v) => {
        if (!v || nextTile === v.tile) return v;
        const canvas = canvasRef.current;
        if (!canvas) return v;
        const rect = canvas.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - rect.left;
        const my = (a.y + b.y) / 2 - rect.top;
        // Keep the point under the fingers fixed while scaling.
        const wx = (mx - v.x) / v.tile;
        const wy = (my - v.y) / v.tile;
        return clampView({ tile: nextTile, x: mx - wx * nextTile, y: my - wy * nextTile }, size.w, size.h);
      });
      return;
    }

    if (pointers.current.size !== 1) return;
    const dx = e.clientX - previous.x;
    const dy = e.clientY - previous.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragged.current = true;
    setView((v) => (v ? clampView({ ...v, x: v.x + dx, y: v.y + dy }, size.w, size.h) : v));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;

    // A tap that did not pan is a selection.
    if (wasSingle && !dragged.current) {
      onSelect(tileFromScreen(e.clientX, e.clientY));
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 2 : -2;
    setView((v) => {
      if (!v) return v;
      const nextTile = Math.max(MIN_TILE, Math.min(MAX_TILE, v.tile + step));
      if (nextTile === v.tile) return v;
      const canvas = canvasRef.current;
      if (!canvas) return v;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const wx = (mx - v.x) / v.tile;
      const wy = (my - v.y) / v.tile;
      return clampView({ tile: nextTile, x: mx - wx * nextTile, y: my - wy * nextTile }, size.w, size.h);
    });
  };

  const zoom = (delta: number) =>
    setView((v) => {
      if (!v) return v;
      const nextTile = Math.max(MIN_TILE, Math.min(MAX_TILE, v.tile + delta));
      const cx = (size.w / 2 - v.x) / v.tile;
      const cy = (size.h / 2 - v.y) / v.tile;
      return clampView({ tile: nextTile, x: size.w / 2 - cx * nextTile, y: size.h / 2 - cy * nextTile }, size.w, size.h);
    });

  const findMyTurf = () => {
    const mine = myAddress ? snapshot.tiles.find((t) => t.owner === myAddress) : undefined;
    setView(centreOn(mine ? mine.id : null, Math.max(viewRef.current?.tile ?? 0, coverTile(size.w, size.h)), size.w, size.h));
    if (mine) onSelect(mine.id);
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        className={cn('pixelated absolute inset-0 h-full w-full touch-none', 'cursor-crosshair')}
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        role="application"
        aria-label="NimTurf world map. Drag to pan, pinch or scroll to zoom, tap a block to inspect it."
      />

      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-1.5">
        <Button
          size="icon"
          variant="secondary"
          className="shadow-pixel size-9"
          onClick={() => zoom(4)}
          aria-label="Zoom in"
        >
          <Plus className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="shadow-pixel size-9"
          onClick={() => zoom(-4)}
          aria-label="Zoom out"
        >
          <Minus className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="shadow-pixel size-9"
          onClick={findMyTurf}
          aria-label="Centre on my turf"
        >
          <Crosshair className="size-4" />
        </Button>
      </div>
    </div>
  );
});
