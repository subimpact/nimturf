import { formatNim } from '@nimturf/shared';
import { Flag, Hammer, Scroll, Shield, Swords } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

/**
 * The rules, in the order a new player needs them.
 *
 * Shown automatically on a first visit. The last section is deliberate: it
 * states plainly that nothing here is decided by chance, because that is both
 * the design principle and the thing players most want to know before they
 * commit resources to a fight.
 */
export function HowToPlay({
  open,
  onOpenChange,
  deedPriceLuna,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deedPriceLuna: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="text-base tracking-display">NIMTURF</DialogTitle>
        </DialogHeader>

        <p className="text-xs leading-relaxed text-muted-foreground">
          One city, 576 blocks, everyone playing on the same map. Claim ground, build it up, and take your
          rivals' blocks when you can hold them.
        </p>

        <ScrollArea className="h-72">
          <div className="space-y-3 pr-3">
            <Step
              icon={<Flag className="size-3.5 text-primary" />}
              title="Claim a block"
              body="Your first block is free - tap any empty ground. After that you can only expand into blocks touching turf you already hold, and each block you own makes the next one 8% dearer."
            />
            <Step
              icon={<Hammer className="size-3.5 text-primary" />}
              title="Build it up"
              body="Blocks earn TURF every second, even while the app is closed (up to 8 hours' worth). Building raises income fast and defence slowly, so a tall block is a rich target."
            />
            <Step
              icon={<Swords className="size-3.5 text-raid" />}
              title="Raid a rival"
              body="Commit TURF against an adjacent enemy block. You are shown the exact number you must beat. Commit more and the raid resolves sooner - which gives the defender less time to answer."
            />
            <Step
              icon={<Shield className="size-3.5 text-primary" />}
              title="Defend your turf"
              body="You are told the moment a block of yours is raided, and by how much. Out-commit the attacker before the timer ends and you keep the block plus 70% of what you spent."
            />
            <Step
              icon={<Scroll className="size-3.5 text-deed" />}
              title="Deed a block on-chain"
              body={`For ${formatNim(deedPriceLuna)} NIM you mint a deed: the block earns 25% more and cannot be raided for 7 days. The claim is written into the transaction's data field on the Nimiq blockchain, so anyone can verify it. You cannot deed a block that is already under raid - no buying your way out of a fight.`}
            />

            <div className="border border-turf/40 bg-turf/10 p-2.5">
              <h3 className="text-xs font-bold text-turf">No dice. Ever.</h3>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                Nothing in NimTurf is decided at random. Every raid is a public, timed contest of committed
                resources, and both sides can work out the result at any moment. Terrain is generated once per
                season and visible to everyone from the start. Win by choosing better targets and better
                timing - never by getting lucky.
              </p>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border/60 bg-card pt-3">
          <Button size="sm" className="w-full" onClick={() => onOpenChange(false)}>
            Take a block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div>
        <h3 className="text-xs font-bold">{title}</h3>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
