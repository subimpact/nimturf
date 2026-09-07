import {
  formatTurf,
  requiredPressure,
  siegeDurationSeconds,
  tileDefense,
  type Siege,
  type Tile,
} from '@nimturf/shared';
import { Swords, Shield, Clock, AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';

/** Formats a duration in seconds as a short human string. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * The raid interface.
 *
 * Because NimTurf has no randomness, this dialog can tell the player exactly
 * what their commitment buys before they spend it: the number they must beat,
 * whether they currently beat it, and how long the raid will take. Showing
 * that up front is the whole point - the game is a resource decision, not a
 * gamble, and the UI should make that impossible to miss.
 */
export function RaidDialog({
  open,
  onOpenChange,
  tile,
  label,
  availableScrap,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tile: Tile;
  label: string;
  availableScrap: number;
  onConfirm: (pressure: number) => void;
  busy: boolean;
}) {
  const defense = useMemo(() => tileDefense(tile), [tile]);
  // Open at whatever is needed to win outright, when affordable.
  const suggested = Math.min(availableScrap, Math.max(Math.floor(defense * 1.1), 1));
  const [pressure, setPressure] = useState(suggested);

  // Re-seed the slider whenever the dialog opens on a different tile.
  const [seenTile, setSeenTile] = useState(tile.id);
  if (seenTile !== tile.id) {
    setSeenTile(tile.id);
    setPressure(suggested);
  }

  const winning = pressure > defense;
  const duration = siegeDurationSeconds(pressure, defense);
  const canAfford = pressure > 0 && pressure <= availableScrap;
  const minimum = Math.floor(defense / 10);
  const tooSmall = pressure < minimum;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Swords className="size-4 text-raid" />
            Raid block {label}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Commit TURF to take this block. No dice: whoever has committed more when the timer ends wins.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="border border-border bg-muted/40 p-2">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Shield className="size-3" /> Must beat
              </div>
              <div className="tabular mt-0.5 text-sm font-bold">{formatTurf(defense)}</div>
            </div>
            <div className="border border-border bg-muted/40 p-2">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="size-3" /> Resolves in
              </div>
              <div className="tabular mt-0.5 text-sm font-bold">{formatDuration(duration)}</div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">Your commitment</span>
              <span className="tabular font-bold text-turf">{formatTurf(pressure)} TURF</span>
            </div>
            <Slider
              min={0}
              max={Math.max(availableScrap, 1)}
              step={Math.max(1, Math.floor(Math.max(availableScrap, 1) / 200))}
              value={[Math.min(pressure, availableScrap)]}
              onValueChange={([v]) => setPressure(v ?? 0)}
              aria-label="TURF to commit to the raid"
            />
            <div className="tabular mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>0</span>
              <span>you hold {formatTurf(availableScrap)}</span>
            </div>
          </div>

          <div className="flex gap-1.5">
            {[1, 1.25, 2].map((multiple) => {
              const amount = Math.floor(defense * multiple);
              return (
                <Button
                  key={multiple}
                  size="sm"
                  variant="secondary"
                  className="h-7 flex-1 text-[10px]"
                  disabled={amount > availableScrap}
                  onClick={() => setPressure(Math.min(amount, availableScrap))}
                >
                  {multiple === 1 ? 'Match' : `${multiple}x`}
                </Button>
              );
            })}
          </div>

          {/* The deterministic verdict, stated plainly. */}
          <div
            className={`border p-2 text-xs ${
              winning ? 'border-turf/40 bg-turf/10 text-turf' : 'border-raid/40 bg-raid/10 text-raid'
            }`}
          >
            {winning
              ? `This takes the block unless the defender commits ${formatTurf(pressure - defense)} more TURF before the timer ends.`
              : `Not enough. You need more than ${formatTurf(defense)} TURF to take this block.`}
          </div>

          <p className="flex gap-1.5 text-[10px] leading-snug text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            Your TURF is committed straight away. If the raid fails you get 40% of it back, so a bad raid
            costs you but never wipes you out.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={!canAfford || tooSmall || busy}
            onClick={() => onConfirm(pressure)}
          >
            <Swords className="size-3.5" />
            {busy ? 'Sending...' : tooSmall ? `Commit at least ${formatTurf(minimum)}` : 'Launch raid'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The defender's counterpart: commit TURF to hold a block. Shows the exact
 * shortfall so the choice is concrete rather than a guess.
 */
export function ReinforceDialog({
  open,
  onOpenChange,
  siege,
  label,
  availableScrap,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siege: Siege;
  label: string;
  availableScrap: number;
  onConfirm: (amount: number) => void;
  busy: boolean;
}) {
  const needed = Math.max(0, siege.pressure - requiredPressure(siege) + 1);
  const suggested = Math.min(availableScrap, Math.max(needed, 1));
  const [amount, setAmount] = useState(suggested);

  const [seen, setSeen] = useState(siege.id);
  if (seen !== siege.id) {
    setSeen(siege.id);
    setAmount(suggested);
  }

  const holds = siege.pressure <= requiredPressure({ ...siege, reinforcement: siege.reinforcement + amount });
  const remaining = Math.max(0, siege.resolvesAt - Date.now()) / 1000;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Shield className="size-4 text-primary" />
            Defend block {label}
          </DialogTitle>
          <DialogDescription className="text-xs">
            A rival has committed {formatTurf(siege.pressure)} TURF. Out-commit them before the timer ends and
            the block stays yours.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="border border-border bg-muted/40 p-2">
              <div className="text-[10px] text-muted-foreground">Attacker</div>
              <div className="tabular mt-0.5 font-bold text-raid">{formatTurf(siege.pressure)}</div>
            </div>
            <div className="border border-border bg-muted/40 p-2">
              <div className="text-[10px] text-muted-foreground">Your defence</div>
              <div className="tabular mt-0.5 font-bold text-primary">
                {formatTurf(siege.baseDefense + siege.reinforcement)}
              </div>
            </div>
            <div className="border border-border bg-muted/40 p-2">
              <div className="text-[10px] text-muted-foreground">Time left</div>
              <div className="tabular mt-0.5 font-bold">{formatDuration(remaining)}</div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">Reinforce with</span>
              <span className="tabular font-bold text-turf">{formatTurf(amount)} TURF</span>
            </div>
            <Slider
              min={0}
              max={Math.max(availableScrap, 1)}
              step={Math.max(1, Math.floor(Math.max(availableScrap, 1) / 200))}
              value={[Math.min(amount, availableScrap)]}
              onValueChange={([v]) => setAmount(v ?? 0)}
              aria-label="TURF to commit to the defence"
            />
          </div>

          <div
            className={`border p-2 text-xs ${
              holds ? 'border-turf/40 bg-turf/10 text-turf' : 'border-raid/40 bg-raid/10 text-raid'
            }`}
          >
            {holds
              ? 'This holds the block, unless the attacker commits more before the timer ends.'
              : needed > availableScrap
                ? `You need ${formatTurf(needed)} TURF to hold this and only have ${formatTurf(availableScrap)}.`
                : `Not enough yet - commit at least ${formatTurf(needed)} TURF.`}
          </div>

          <p className="text-[10px] leading-snug text-muted-foreground">
            Defending is cheap: hold the block and you get 70% of your reinforcement back.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={amount <= 0 || amount > availableScrap || busy}
            onClick={() => onConfirm(amount)}
          >
            <Shield className="size-3.5" />
            {busy ? 'Sending...' : 'Commit defence'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
