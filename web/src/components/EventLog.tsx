import type { GameEvent } from '@nimturf/shared';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

/** Colour-codes an event by whether it went the player's way. */
function toneFor(kind: string): string {
  if (kind === 'siege_won' || kind === 'tile_held' || kind === 'deed_minted') return 'border-turf/40 text-turf';
  if (kind === 'tile_lost' || kind === 'siege_lost' || kind === 'under_siege') return 'border-raid/40 text-raid';
  return 'border-border text-muted-foreground';
}

function timeAgo(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * What happened while you were away.
 *
 * An idle game is only worth reopening if it can tell you what changed, so
 * raids, losses and holds are all reported here rather than silently applied.
 */
export function EventLog({
  open,
  onOpenChange,
  events,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: GameEvent[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Bell className="size-4" />
            While you were out
          </DialogTitle>
        </DialogHeader>

        {events.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Nothing has happened yet.</p>
        ) : (
          <ScrollArea className="h-72">
            <ul className="space-y-1 pr-3">
              {events.map((event) => (
                <li key={event.id} className={`border bg-muted/30 px-2 py-1.5 text-[11px] ${toneFor(event.kind)}`}>
                  <p className="leading-snug">{event.message}</p>
                  <span className="text-[9px] text-muted-foreground">{timeAgo(event.created_at)}</span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Small bell with an unread count, for the HUD. */
export function EventButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button size="icon" variant="ghost" className="relative size-8" onClick={onClick} aria-label="Recent events">
      <Bell className="size-4" />
      {count > 0 ? (
        <span className="absolute right-0.5 top-0.5 flex size-3.5 items-center justify-center bg-raid text-[8px] font-bold text-white">
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </Button>
  );
}
