import { formatTurf } from '@nimturf/shared';
import { ExternalLink, Loader2, Scroll, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, type DeedLogEntry } from '@/lib/api';
import { ownerColour } from '@/lib/pixel';
import type { LeaderboardEntry } from '@nimturf/shared';

/** Block explorer used to make deeds independently verifiable. */
function explorerUrl(txHash: string, network: string): string {
  const base = network === 'test' ? 'https://test.nimiqwatch.com' : 'https://nimiqwatch.com';
  return `${base}/tx/${txHash}`;
}

/**
 * Standings, plus the public deed ledger.
 *
 * The deed tab links every deed straight to a Nimiq block explorer. Anyone can
 * check that the transaction behind a protected block is real, which is what
 * makes the on-chain claim more than a badge in a database.
 */
export function Leaderboard({
  open,
  onOpenChange,
  myAddress,
  network,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  myAddress: string | null;
  network: string;
}) {
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);
  const [deeds, setDeeds] = useState<DeedLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    (async () => {
      const [board, log] = await Promise.allSettled([api.leaderboard(50), api.deedLog()]);
      if (cancelled) return;
      if (board.status === 'fulfilled') setRows(board.value);
      else setError('Could not load the leaderboard. Please try again.');
      if (log.status === 'fulfilled') setDeeds(log.value);
      else setDeeds([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Trophy className="size-4 text-deed" />
            Standings
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="players">
          <TabsList className="w-full">
            <TabsTrigger value="players" className="flex-1 text-xs">
              Bosses
            </TabsTrigger>
            <TabsTrigger value="deeds" className="flex-1 text-xs">
              On-chain deeds
            </TabsTrigger>
          </TabsList>

          <TabsContent value="players" className="mt-2">
            {error ? (
              <p className="py-6 text-center text-xs text-destructive">{error}</p>
            ) : rows === null ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : rows.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Nobody has claimed a block yet. Be the first.
              </p>
            ) : (
              <ScrollArea className="h-72">
                <ul className="space-y-1 pr-3">
                  {rows.map((row) => {
                    const isMe = myAddress !== null && row.address === myAddress;
                    return (
                      <li
                        key={row.address}
                        className={`flex items-center gap-2 border px-2 py-1.5 text-xs ${
                          isMe ? 'border-primary/50 bg-primary/10' : 'border-border bg-muted/30'
                        }`}
                      >
                        <span className="tabular w-5 shrink-0 text-right text-[10px] text-muted-foreground">
                          {row.rank}
                        </span>
                        <span
                          className="pixelated size-4 shrink-0 border border-border/60"
                          style={{ background: ownerColour(row.colorIndex) }}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate font-bold">
                          {row.name}
                          {isMe ? <span className="ml-1 text-[9px] text-primary">you</span> : null}
                        </span>
                        <span className="tabular shrink-0 text-[10px] text-muted-foreground">
                          {row.tileCount} blk
                        </span>
                        <span className="tabular w-16 shrink-0 text-right font-bold text-turf">
                          {formatTurf(row.lifetimeScrap)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            )}
            <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
              Ranked by total TURF ever earned, so holding good ground for a long time beats a lucky grab.
            </p>
          </TabsContent>

          <TabsContent value="deeds" className="mt-2">
            {deeds === null ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : deeds.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                No deeds minted yet. A deed is a real NIM transaction that makes a block raid-proof.
              </p>
            ) : (
              <ScrollArea className="h-72">
                <ul className="space-y-1 pr-3">
                  {deeds.map((deed) => (
                    <li key={deed.txHash} className="border border-border bg-muted/30 px-2 py-1.5 text-xs">
                      <div className="flex items-center gap-1.5">
                        <Scroll className="size-3 shrink-0 text-deed" />
                        <span className="font-bold">Block {deed.label}</span>
                        <Badge variant="outline" className="h-4 px-1 text-[9px]">
                          {deed.address.slice(2, 8)}
                        </Badge>
                        <a
                          href={explorerUrl(deed.txHash, network)}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="ml-auto flex items-center gap-0.5 text-[10px] text-primary hover:underline"
                        >
                          verify <ExternalLink className="size-2.5" />
                        </a>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">{deed.txHash}</div>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
            <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
              Every deed is a NIM transaction on the Nimiq blockchain. Follow any "verify" link to check it
              yourself - the game cannot fake these.
            </p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
