import { tileLabel, type Tile } from '@nimturf/shared';
import { AlertTriangle, Loader2, RefreshCw, Shield } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { EventButton, EventLog } from '@/components/EventLog';
import { GameMap } from '@/components/GameMap';
import { HowToPlay } from '@/components/HowToPlay';
import { Hud } from '@/components/Hud';
import { StatusStrip } from '@/components/StatusStrip';
import { Leaderboard } from '@/components/Leaderboard';
import { TilePanel } from '@/components/TilePanel';
import { Button } from '@/components/ui/button';
import { GameProvider, useGame } from '@/hooks/useGame';

const SEEN_HELP_KEY = 'nimturf.seenHelp';
const SEEN_EVENT_KEY = 'nimturf.lastEvent';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function Game() {
  const { status, error, snapshot, me, config, signedIn, refresh } = useGame();

  const [selectedTileId, setSelectedTileId] = useState<number | null>(null);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [lastSeenEvent, setLastSeenEvent] = useState<number>(() => Number(read(SEEN_EVENT_KEY) ?? 0));

  // Show the rules once, on a first visit, so nobody lands on a grid with no
  // idea what it is.
  useEffect(() => {
    if (status !== 'ready') return;
    if (read(SEEN_HELP_KEY)) return;
    setHelpOpen(true);
    write(SEEN_HELP_KEY, '1');
  }, [status]);

  const selectedTile: Tile | null = useMemo(() => {
    if (!snapshot || selectedTileId === null) return null;
    return (snapshot.tiles[selectedTileId] as Tile) ?? null;
  }, [snapshot, selectedTileId]);

  /** Blocks of mine currently under raid: the thing most worth interrupting for. */
  const myTilesUnderRaid = useMemo(() => {
    if (!snapshot || !me) return [];
    return snapshot.sieges.filter((s) => snapshot.tiles[s.tileId]?.owner === me.address);
  }, [snapshot, me]);

  const unreadEvents = useMemo(
    () => (snapshot?.events ?? []).filter((e) => e.id > lastSeenEvent).length,
    [snapshot?.events, lastSeenEvent],
  );

  const openEvents = () => {
    const newest = snapshot?.events?.[0]?.id ?? 0;
    setLastSeenEvent(newest);
    write(SEEN_EVENT_KEY, String(newest));
    setEventsOpen(true);
  };

  // ---- Loading ------------------------------------------------------------
  if (status === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="size-6 animate-spin text-primary" />
        <p className="text-xs tracking-display text-muted-foreground">LOADING THE CITY</p>
      </div>
    );
  }

  // ---- Hard failure: always offer a way forward, never a dead end ---------
  if (status === 'error' || !snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="size-7 text-destructive" />
        <div>
          <h1 className="text-sm font-bold tracking-display">CANNOT REACH NIMTURF</h1>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
            {error ?? 'The game server did not respond.'}
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => void refresh()}>
          <RefreshCw className="size-3.5" /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Hud onOpenLeaderboard={() => setLeaderboardOpen(true)} onOpenHelp={() => setHelpOpen(true)} />

      {/* A raid on your own turf is urgent: surface it above everything. */}
      {myTilesUnderRaid.length > 0 ? (
        <button
          type="button"
          className="animate-raid z-10 flex shrink-0 items-center gap-2 border-b border-raid/40 bg-raid/15 px-3 py-1.5 text-left text-[11px] font-bold text-raid"
          onClick={() => setSelectedTileId(myTilesUnderRaid[0].tileId)}
        >
          <Shield className="size-3.5 shrink-0" />
          <span className="truncate">
            {myTilesUnderRaid.length === 1
              ? `Block ${tileLabel(myTilesUnderRaid[0].tileId)} is under raid - tap to defend`
              : `${myTilesUnderRaid.length} of your blocks are under raid - tap to defend`}
          </span>
        </button>
      ) : null}

      <main className="relative aspect-square max-h-[58vh] w-full shrink-0">
        <GameMap
          snapshot={snapshot}
          selectedTileId={selectedTileId}
          myAddress={me?.address ?? null}
          onSelect={setSelectedTileId}
        />

        {/* Event bell floats over the map so the HUD stays one line. */}
        {signedIn ? (
          <div className="absolute left-3 top-3 z-10">
            <div className="border border-border bg-card/90 shadow-pixel backdrop-blur">
              <EventButton count={unreadEvents} onClick={openEvents} />
            </div>
          </div>
        ) : null}
      </main>

      {/* Below the map: the tile you tapped, or the city status panel. */}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border bg-card/60">
        {selectedTile ? (
          <TilePanel tile={selectedTile} snapshot={snapshot} onClose={() => setSelectedTileId(null)} />
        ) : (
          <StatusStrip snapshot={snapshot} onSelectTile={setSelectedTileId} />
        )}
      </div>

      <Leaderboard
        open={leaderboardOpen}
        onOpenChange={setLeaderboardOpen}
        myAddress={me?.address ?? null}
        network={config?.network ?? 'main'}
      />
      <HowToPlay open={helpOpen} onOpenChange={setHelpOpen} deedPriceLuna={config?.deedPriceLuna ?? 200000} />
      <EventLog open={eventsOpen} onOpenChange={setEventsOpen} events={snapshot.events ?? []} />
    </div>
  );
}

export default function App() {
  return (
    <GameProvider>
      <Game />
    </GameProvider>
  );
}
