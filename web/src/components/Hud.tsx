import { formatTurf } from '@nimturf/shared';
import { HelpCircle, LogOut, Trophy, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useGame } from '@/hooks/useGame';
import { ownerColour } from '@/lib/pixel';

/**
 * The persistent top bar: what you have, what you earn, and who you are.
 * Kept to one line on mobile so it never eats into the map.
 */
export function Hud({
  onOpenLeaderboard,
  onOpenHelp,
}: {
  onOpenLeaderboard: () => void;
  onOpenHelp: () => void;
}) {
  const { me, liveScrap, ratePerSec, signedIn, signIn, signOut, busy, walletLabel, snapshot } = useGame();

  return (
    <header className="z-20 flex shrink-0 items-center gap-2 border-b border-border bg-card/95 px-2 py-2 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        {me ? (
          <div
            className="pixelated size-6 shrink-0 border border-border"
            style={{ background: ownerColour(me.colorIndex) }}
            title={`Your colour on the map`}
            aria-hidden
          />
        ) : (
          <span className="shrink-0 text-xs font-bold tracking-display text-primary">NIMTURF</span>
        )}
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            {/* Tabular digits stop the balance jittering as it ticks. */}
            <span className="tabular text-base font-bold leading-none text-turf">
              {formatTurf(liveScrap)}
            </span>
            <span className="text-[10px] leading-none text-muted-foreground">TURF</span>
          </div>
          <div className="tabular truncate text-[10px] leading-tight text-muted-foreground">
            {ratePerSec > 0 ? `+${formatTurf(ratePerSec)}/s` : 'no income yet'}
            {me ? ` · ${me.tileCount} block${me.tileCount === 1 ? '' : 's'}` : ''}
          </div>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {snapshot ? (
          <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">
            Season {snapshot.meta.seasonId}
          </Badge>
        ) : null}

        <Button size="icon" variant="ghost" className="size-8" onClick={onOpenHelp} aria-label="How to play">
          <HelpCircle className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" className="size-8" onClick={onOpenLeaderboard} aria-label="Leaderboard">
          <Trophy className="size-4" />
        </Button>

        {signedIn && me ? (
          <>
            <span className="hidden max-w-24 truncate text-xs text-muted-foreground sm:inline">{me.name}</span>
            <Button size="icon" variant="ghost" className="size-8" onClick={signOut} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </>
        ) : (
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void signIn()} disabled={busy}>
            <Wallet className="size-3.5" />
            {busy ? 'Connecting...' : `Sign in`}
            <span className="sr-only"> with {walletLabel}</span>
          </Button>
        )}
      </div>
    </header>
  );
}
