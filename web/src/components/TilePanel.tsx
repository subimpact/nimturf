import {
  MAX_LEVEL,
  TERRAIN_STATS,
  claimCost,
  formatNim,
  formatTurf,
  neighbourIds,
  tileDefense,
  tileLabel,
  tileYieldPerSec,
  upgradeCost,
  type Siege,
  type SnapshotResponse,
  type Tile,
} from '@nimturf/shared';
import { Coins, Flag, Hammer, Scroll, Shield, Swords, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { RaidDialog, ReinforceDialog, formatDuration } from '@/components/RaidDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useGame } from '@/hooks/useGame';
import { ownerColour } from '@/lib/pixel';

/**
 * The tile inspector.
 *
 * Every cost and consequence is computed here with the same shared rules the
 * server uses, so the panel can show a real number before the player commits
 * rather than making them find out by trying.
 */
export function TilePanel({
  tile,
  snapshot,
  onClose,
}: {
  tile: Tile;
  snapshot: SnapshotResponse;
  onClose: () => void;
}) {
  const { me, liveScrap, claim, upgrade, raid, reinforce, mintDeed, busy, signedIn, signIn, config, deedProgress } =
    useGame();

  const [raidOpen, setRaidOpen] = useState(false);
  const [defendOpen, setDefendOpen] = useState(false);

  const label = tileLabel(tile.id);
  const terrain = TERRAIN_STATS[tile.terrain];
  const now = snapshot.now;

  const siege: Siege | undefined = useMemo(
    () => snapshot.sieges.find((s) => s.tileId === tile.id),
    [snapshot.sieges, tile.id],
  );

  const isMine = Boolean(me && tile.owner === me.address);
  const ownerName = tile.owner ? (snapshot.players[tile.owner]?.name ?? tile.owner.slice(2, 8)) : null;
  const ownerColourIndex = tile.owner ? (snapshot.players[tile.owner]?.colorIndex ?? 0) : 0;

  const yieldPerSec = useMemo(() => tileYieldPerSec(tile, snapshot.tiles as Tile[], now), [tile, snapshot.tiles, now]);
  const defense = useMemo(() => tileDefense(tile), [tile]);

  const adjacentOwned = useMemo(
    () => (me ? neighbourIds(tile.id).filter((n) => snapshot.tiles[n]?.owner === me.address).length : 0),
    [me, tile.id, snapshot.tiles],
  );

  const isFirstClaim = (me?.tileCount ?? 0) === 0;
  const adjacentToMine = adjacentOwned > 0;
  const cost = isFirstClaim ? 0 : claimCost(tile, me?.tileCount ?? 0);
  const buildCost = upgradeCost(tile);
  const deedActive = tile.deedUntil > now;

  /** Explains why claiming is unavailable, or null when it is available. */
  const claimBlocker = (() => {
    if (!signedIn) return 'Sign in to claim territory.';
    if (!isFirstClaim && !adjacentToMine) return 'Only blocks next to your turf can be claimed.';
    if (liveScrap < cost) return `You need ${formatTurf(cost)} TURF.`;
    return null;
  })();

  const buildBlocker = (() => {
    if (tile.level >= MAX_LEVEL) return 'Fully built up.';
    if (buildCost === null) return 'Fully built up.';
    if (liveScrap < buildCost) return `You need ${formatTurf(buildCost)} TURF.`;
    return null;
  })();

  return (
    <>
      <div className="z-20 shrink-0 border-t border-border bg-card/98 backdrop-blur">
        {/* Header: which block, what it is, who holds it. */}
        <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2">
          <div
            className="pixelated mt-0.5 size-7 shrink-0 border border-border"
            style={{ background: tile.owner ? ownerColour(ownerColourIndex) : 'var(--muted)' }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold tracking-display">{label}</span>
              <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                {terrain.label}
              </Badge>
              {tile.owner ? (
                <Badge variant="outline" className="h-4 px-1 text-[9px]">
                  Lv {tile.level}
                </Badge>
              ) : null}
              {deedActive ? (
                <Badge className="h-4 gap-0.5 bg-deed px-1 text-[9px] text-accent-foreground">
                  <Scroll className="size-2.5" /> Deeded
                </Badge>
              ) : null}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {tile.owner ? (isMine ? 'Held by you' : `Held by ${ownerName}`) : 'Unclaimed ground'}
              {tile.owner ? ` · ${formatTurf(yieldPerSec)}/s · defence ${formatTurf(defense)}` : null}
            </div>
          </div>
          <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>

        {/* Live raid banner, for attacker and defender alike. */}
        {siege ? (
          <div className="border-b border-raid/30 bg-raid/10 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-raid">
              <Swords className="size-3.5" />
              Under raid · resolves in {formatDuration(Math.max(0, siege.resolvesAt - Date.now()) / 1000)}
            </div>
            <div className="tabular mt-1 flex gap-3 text-[10px] text-muted-foreground">
              <span>
                attacker <span className="font-bold text-raid">{formatTurf(siege.pressure)}</span>
              </span>
              <span>
                defence{' '}
                <span className="font-bold text-primary">{formatTurf(siege.baseDefense + siege.reinforcement)}</span>
              </span>
            </div>
            {isMine ? (
              <Button
                size="sm"
                className="mt-2 h-7 w-full gap-1.5 text-xs"
                onClick={() => setDefendOpen(true)}
                disabled={busy}
              >
                <Shield className="size-3.5" /> Reinforce this block
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Actions */}
        <div className="flex flex-wrap gap-1.5 px-3 py-2">
          {!tile.owner ? (
            <ActionButton
              icon={<Flag className="size-3.5" />}
              label={isFirstClaim ? 'Claim (free)' : `Claim · ${formatTurf(cost)}`}
              blocker={claimBlocker}
              busy={busy}
              onClick={() => (signedIn ? void claim(tile.id) : void signIn())}
              primary
            />
          ) : null}

          {isMine ? (
            <>
              <ActionButton
                icon={<Hammer className="size-3.5" />}
                label={buildCost === null ? 'Max level' : `Build · ${formatTurf(buildCost)}`}
                blocker={buildBlocker}
                busy={busy}
                onClick={() => void upgrade(tile.id)}
                primary
              />
              {config?.deedsEnabled ? (
                <ActionButton
                  icon={<Scroll className="size-3.5" />}
                  label={
                    deedActive
                      ? `Deed active · ${formatDuration((tile.deedUntil - now) / 1000)}`
                      : `Deed · ${formatNim(config.deedPriceLuna)} NIM`
                  }
                  blocker={
                    deedActive
                      ? 'This block already has an active deed.'
                      : siege
                        ? 'You cannot deed a block while it is under raid.'
                        : null
                  }
                  busy={busy}
                  onClick={() => void mintDeed(tile.id)}
                  accent
                />
              ) : null}
            </>
          ) : null}

          {tile.owner && !isMine ? (
            <ActionButton
              icon={<Swords className="size-3.5" />}
              label="Raid this block"
              blocker={
                !signedIn
                  ? 'Sign in to raid.'
                  : siege
                    ? 'Already under raid.'
                    : deedActive
                      ? 'Protected by a Nimiq deed.'
                      : !adjacentToMine
                        ? 'You must hold a block next to this one.'
                        : null
              }
              busy={busy}
              onClick={() => (signedIn ? setRaidOpen(true) : void signIn())}
              danger
            />
          ) : null}
        </div>

        {/* Progress readout while a deed payment is in flight. */}
        {deedProgress ? (
          <div className="border-t border-deed/30 bg-deed/10 px-3 py-1.5 text-[10px] text-deed">{deedProgress}</div>
        ) : null}

        {/*
          A breakdown of where this block's numbers come from. It doubles as
          the tutorial: a player learns that terrain and adjacency drive
          income by seeing it itemised on a real tile, not by reading rules.
        */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-[10px]">
          <Detail label="Terrain" value={`${terrain.label} · ${formatTurf(terrain.yieldScrap)}/s base`} />
          <Detail label="Defence" value={`${formatTurf(defense)} · ${(terrain.defenseBp / 10000).toFixed(1)}x terrain`} />
          {tile.owner ? (
            <>
              <Detail
                label="Level"
                value={tile.level >= MAX_LEVEL ? `${MAX_LEVEL} (max)` : `${tile.level} of ${MAX_LEVEL}`}
              />
              <Detail label="Income" value={`${formatTurf(yieldPerSec)}/s`} />
            </>
          ) : null}
          {/* The bonus only applies to the holder, so word it accordingly. */}
          <Detail
            label={isMine ? 'Your neighbours' : 'Adjacent to you'}
            value={
              adjacentOwned === 0
                ? isMine
                  ? 'none · no bonus'
                  : 'none'
                : isMine
                  ? `${adjacentOwned} · +${Math.min(adjacentOwned, 4) * 12}% income`
                  : tile.owner
                    ? `${adjacentOwned} block${adjacentOwned === 1 ? '' : 's'}`
                    : `${adjacentOwned} · +${Math.min(adjacentOwned, 4) * 12}% if you claim it`
            }
          />
          <Detail
            label="Deed"
            value={deedActive ? `active for ${formatDuration((tile.deedUntil - now) / 1000)}` : 'none'}
          />
        </div>

        {!tile.owner ? (
          <div className="flex items-start gap-1.5 border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
            <Coins className="mt-0.5 size-3 shrink-0" />
            <span>
              Blocks touching turf you already hold earn +12% each, up to four. Compact territory beats
              scattered territory.
            </span>
          </div>
        ) : null}
      </div>

      <RaidDialog
        open={raidOpen}
        onOpenChange={setRaidOpen}
        tile={tile}
        label={label}
        availableScrap={liveScrap}
        busy={busy}
        onConfirm={async (pressure) => {
          const success = await raid(tile.id, pressure);
          if (success) setRaidOpen(false);
        }}
      />

      {siege ? (
        <ReinforceDialog
          open={defendOpen}
          onOpenChange={setDefendOpen}
          siege={siege}
          label={label}
          availableScrap={liveScrap}
          busy={busy}
          onConfirm={async (amount) => {
            const success = await reinforce(siege.id, amount);
            if (success) setDefendOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="tabular truncate text-right">{value}</span>
    </div>
  );
}

/**
 * An action with its reason for being unavailable attached.
 *
 * Disabled buttons that do not say why are one of the main ways a game feels
 * broken, so the blocker text is always rendered next to the control.
 */
function ActionButton({
  icon,
  label,
  blocker,
  busy,
  onClick,
  primary,
  danger,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  blocker: string | null;
  busy: boolean;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  accent?: boolean;
}) {
  const disabled = blocker !== null || busy;
  return (
    <div className="min-w-0 flex-1 basis-40">
      <Button
        size="sm"
        variant={danger ? 'destructive' : primary || accent ? 'default' : 'secondary'}
        className={`h-8 w-full gap-1.5 text-xs ${accent ? 'bg-deed text-accent-foreground hover:bg-deed/90' : ''}`}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
        <span className="truncate">{label}</span>
      </Button>
      {blocker ? <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{blocker}</p> : null}
    </div>
  );
}
