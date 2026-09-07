import { formatTurf, requiredPressure, tileLabel, type SnapshotResponse } from '@nimturf/shared';
import { History, Shield, Swords, Users, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDuration } from '@/components/RaidDialog';
import { Button } from '@/components/ui/button';
import { useGame } from '@/hooks/useGame';
import { ownerColour } from '@/lib/pixel';

/**
 * The panel below the map.
 *
 * The board is square and phone screens are not, so rather than leave the
 * leftover space empty this carries the things a player needs between taps:
 * what they earn, and above all which raids are running and how long is left.
 * A raid has a deadline, so it is the one thing the game must never make
 * somebody hunt for.
 */
/** Colours an event line by whether it went the player's way. */
function eventTone(kind: string): string {
  if (kind === 'siege_won' || kind === 'tile_held' || kind === 'deed_minted') return 'border-turf/70 text-turf';
  if (kind === 'tile_lost' || kind === 'siege_lost' || kind === 'under_siege') return 'border-raid/70 text-raid';
  return 'border-border text-muted-foreground';
}

export function StatusStrip({
  snapshot,
  onSelectTile,
}: {
  snapshot: SnapshotResponse;
  onSelectTile: (tileId: number) => void;
}) {
  const { me, liveScrap, ratePerSec, signedIn, signIn, busy } = useGame();

  // A one-second tick, purely so the raid countdowns move.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (snapshot.sieges.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.sieges.length]);

  const claimed = snapshot.tiles.filter((t) => t.owner).length;
  const bosses = Object.keys(snapshot.players).length;

  const myRaids = me
    ? snapshot.sieges.filter(
        (s) => s.attacker === me.address || snapshot.tiles[s.tileId]?.owner === me.address,
      )
    : [];

  if (!signedIn) {
    return (
      <div className="flex h-full flex-col justify-between gap-3 p-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Blocks taken" value={`${claimed}`} sub={`of ${snapshot.tiles.length}`} />
          <Stat label="Bosses" value={`${bosses}`} sub="holding turf" />
          <Stat label="Live raids" value={`${snapshot.sieges.length}`} sub="right now" />
        </div>

        <div className="border border-border bg-muted/30 p-3 text-center">
          <p className="text-xs font-bold">You are watching the city</p>
          <p className="mx-auto mt-1 max-w-xs text-[10px] leading-snug text-muted-foreground">
            Sign in with your Nimiq wallet to claim your first block. It is free, and takes one tap.
          </p>
          <Button size="sm" className="mt-2 h-8 w-full gap-1.5 text-xs" onClick={() => void signIn()} disabled={busy}>
            <Wallet className="size-3.5" />
            {busy ? 'Connecting...' : 'Sign in with Nimiq'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="TURF" value={formatTurf(liveScrap)} sub={ratePerSec > 0 ? `+${formatTurf(ratePerSec)}/s` : 'idle'} accent />
        <Stat label="Blocks" value={`${me?.tileCount ?? 0}`} sub={`${claimed} taken citywide`} />
        <Stat label="Earned" value={formatTurf(me?.lifetimeScrap ?? 0)} sub="all season" />
      </div>

      {myRaids.length > 0 ? (
        <div className="shrink-0">
          <h2 className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-display text-muted-foreground">
            <Swords className="size-3" /> Your raids
          </h2>
          <ul className="space-y-1 overflow-y-auto">
            {myRaids.map((siege) => {
              const attacking = siege.attacker === me?.address;
              const winning = siege.pressure > requiredPressure(siege);
              // "Good for me" depends on which side of the raid you are on.
              const favourable = attacking ? winning : !winning;
              const remaining = Math.max(0, siege.resolvesAt - Date.now()) / 1000;
              return (
                <li key={siege.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTile(siege.tileId)}
                    className={`flex w-full items-center gap-2 border px-2 py-1.5 text-left text-[11px] ${
                      favourable ? 'border-turf/40 bg-turf/10' : 'border-raid/40 bg-raid/10'
                    }`}
                  >
                    {attacking ? (
                      <Swords className="size-3 shrink-0 text-raid" />
                    ) : (
                      <Shield className="size-3 shrink-0 text-primary" />
                    )}
                    <span className="font-bold">{tileLabel(siege.tileId)}</span>
                    <span className="tabular text-muted-foreground">
                      {formatTurf(siege.pressure)} vs {formatTurf(siege.baseDefense + siege.reinforcement)}
                    </span>
                    <span className={`tabular ml-auto shrink-0 font-bold ${favourable ? 'text-turf' : 'text-raid'}`}>
                      {favourable ? 'winning' : 'losing'} · {formatDuration(remaining)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* What changed while you were away: the reason to reopen the game. */}
      {snapshot.events.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <h2 className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-display text-muted-foreground">
            <History className="size-3" /> Latest
          </h2>
          <ul className="space-y-1">
            {snapshot.events.slice(0, 5).map((event) => (
              <li
                key={event.id}
                className={`border-l-2 bg-muted/20 px-2 py-1 text-[10px] leading-snug ${eventTone(event.kind)}`}
              >
                {event.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <h2 className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-display text-muted-foreground">
            <Users className="size-3" /> The city
          </h2>
          {me && me.tileCount === 0 ? (
            <p className="border border-primary/40 bg-primary/10 p-2 text-[11px] leading-snug text-primary">
              Tap any empty block on the map to claim it. Your first one is free.
            </p>
          ) : (
            <ul className="space-y-1">
              {Object.values(snapshot.players)
                .slice(0, 4)
                .map((player) => {
                  const held = snapshot.tiles.filter((t) => t.owner === player.address).length;
                  return (
                    <li
                      key={player.address}
                      className="flex items-center gap-2 border border-border bg-muted/30 px-2 py-1 text-[11px]"
                    >
                      <span
                        className="pixelated size-3 shrink-0 border border-border/60"
                        style={{ background: ownerColour(player.colorIndex) }}
                        aria-hidden
                      />
                      <span className="truncate">{player.name}</span>
                      <span className="tabular ml-auto text-muted-foreground">{held} blk</span>
                    </li>
                  );
                })}
              {Object.keys(snapshot.players).length === 0 ? (
                <li className="text-[11px] text-muted-foreground">Nobody holds a block yet.</li>
              ) : null}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="border border-border bg-muted/30 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-display text-muted-foreground">{label}</div>
      <div className={`tabular truncate text-sm font-bold ${accent ? 'text-turf' : ''}`}>{value}</div>
      {sub ? <div className="tabular truncate text-[9px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
