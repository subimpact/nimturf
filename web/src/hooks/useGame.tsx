import type { MeState, SnapshotResponse, Tile } from '@nimturf/shared';
import { accrue, playerYieldPerSec } from '@nimturf/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import {
  ApiError,
  api,
  claimDeedWithRetry,
  clearToken,
  loadToken,
  saveToken,
  type GameConfig,
} from '@/lib/api';
import { WalletError, getWallet, hostLanguage, isInNimiqPay, resetWallet } from '@/lib/wallet';

/**
 * Game state, polling and player actions.
 *
 * The server is the only authority on balances. This layer keeps the last
 * snapshot, re-fetches it periodically, and in between predicts the player's
 * balance locally using the very same rules module the server runs. That is
 * what makes the counter tick smoothly without ever inventing income the
 * server will not agree with.
 */

const POLL_INTERVAL_MS = 6000;
const PREDICT_INTERVAL_MS = 250;

export type Status = 'loading' | 'ready' | 'error';

interface GameContextValue {
  status: Status;
  error: string | null;
  snapshot: SnapshotResponse | null;
  me: MeState | null;
  config: GameConfig | null;
  signedIn: boolean;
  busy: boolean;
  /** Locally predicted balance, in scrap. */
  liveScrap: number;
  /** Current income per second. */
  ratePerSec: number;
  walletLabel: string;
  inNimiqPay: boolean;
  deedProgress: string | null;

  signIn: () => Promise<void>;
  signOut: () => void;
  refresh: (options?: { quiet?: boolean }) => Promise<void>;
  claim: (tileId: number) => Promise<boolean>;
  upgrade: (tileId: number) => Promise<boolean>;
  raid: (tileId: number, pressure: number) => Promise<boolean>;
  reinforce: (siegeId: string, amount: number) => Promise<boolean>;
  mintDeed: (tileId: number) => Promise<boolean>;
  rename: (name: string) => Promise<boolean>;
  recolour: (colorIndex: number) => Promise<boolean>;
}

const GameContext = createContext<GameContextValue | null>(null);

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}

/** Turns anything thrown into a message worth showing, and reports it. */
function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof WalletError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong. Please try again.';
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [signedIn, setSignedIn] = useState<boolean>(() => loadToken() !== null);
  const [busy, setBusy] = useState(false);
  const [walletLabel, setWalletLabel] = useState(isInNimiqPay() ? 'Nimiq Pay' : 'Nimiq Hub');
  const [deedProgress, setDeedProgress] = useState<string | null>(null);

  /** Client clock reading when the current snapshot arrived. */
  const receivedAt = useRef<number>(Date.now());
  /**
   * Prediction clock. The *value* has to be in the dependency list below, not
   * the setter: a setter's identity never changes, so depending on it would
   * memoise the balance forever and leave the counter visibly frozen between
   * polls.
   */
  const [tick, setTick] = useState(0);

  // Match the document language to the player's Nimiq Pay setting.
  useEffect(() => {
    const lang = hostLanguage();
    if (lang) document.documentElement.lang = lang;
  }, []);

  const refresh = useCallback(async (options?: { quiet?: boolean }) => {
    try {
      const next = await api.world();
      setSnapshot(next);
      receivedAt.current = Date.now();
      setSignedIn(next.me !== null);
      setStatus('ready');
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.isAuthError) {
        // The session expired: drop it and continue as a spectator rather
        // than showing an error the player cannot act on.
        clearToken();
        setSignedIn(false);
        try {
          const next = await api.world();
          setSnapshot(next);
          receivedAt.current = Date.now();
          setStatus('ready');
          return;
        } catch {
          /* fall through to the error below */
        }
      }
      const message = describeError(e);
      if (!options?.quiet) setError(message);
      // Keep showing the last good world instead of blanking the screen.
      setStatus(snapshot ? 'ready' : 'error');
      if (options?.quiet && snapshot) console.warn('Background refresh failed:', message);
    }
  }, [snapshot]);

  // Initial load: config and world in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cfg, world] = await Promise.allSettled([api.config(), api.world()]);
      if (cancelled) return;

      if (cfg.status === 'fulfilled') setConfig(cfg.value);

      if (world.status === 'fulfilled') {
        setSnapshot(world.value);
        receivedAt.current = Date.now();
        setSignedIn(world.value.me !== null);
        setStatus('ready');
      } else {
        if (world.reason instanceof ApiError && world.reason.isAuthError) {
          clearToken();
          setSignedIn(false);
        }
        setError(describeError(world.reason));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the world, and refresh immediately when the tab regains focus so a
  // player coming back never acts on a stale board.
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setInterval(() => void refresh({ quiet: true }), POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh({ quiet: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [status, refresh]);

  // Drive the local prediction clock.
  useEffect(() => {
    if (!snapshot?.me) return;
    const timer = setInterval(() => setTick((n) => n + 1), PREDICT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [snapshot?.me]);

  const me = snapshot?.me ?? null;

  /**
   * Income per second, recomputed from the board with the shared rules rather
   * than trusting the number in the snapshot - they must agree, and computing
   * it here means the UI stays right the instant a tile changes.
   */
  const ratePerSec = useMemo(() => {
    if (!snapshot || !me) return 0;
    return playerYieldPerSec(snapshot.tiles as Tile[], me.address, snapshot.now, null);
  }, [snapshot, me]);

  const liveScrap = useMemo(() => {
    if (!me) return 0;
    // `me.scrap` is already correct as of snapshot.now; add only what has
    // accrued since, using the server's own accrual function.
    const elapsedSinceSnapshot = Date.now() - receivedAt.current;
    return me.scrap + accrue(ratePerSec, 0, Math.max(0, elapsedSinceSnapshot));
  }, [me, ratePerSec, tick]);

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  const signIn = useCallback(async () => {
    setBusy(true);
    try {
      const wallet = await getWallet();
      setWalletLabel(wallet.label);

      const challenge = await api.challenge();
      const signed = await wallet.signChallenge(challenge.message);
      const result = await api.verify({
        address: signed.address,
        publicKey: signed.publicKey,
        signature: signed.signature,
        nonce: challenge.nonce,
      });

      saveToken(result.token);
      setSignedIn(true);
      await refresh();
      toast.success(`Signed in as ${result.me.name}`);
    } catch (e) {
      // A cancelled wallet prompt is a choice, not a failure.
      if (e instanceof WalletError && e.cancelled) return;
      resetWallet();
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const signOut = useCallback(() => {
    clearToken();
    resetWallet();
    setSignedIn(false);
    void refresh();
    toast.info('Signed out. Your turf is safe - sign back in any time.');
  }, [refresh]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Shared wrapper: runs an action, reports the outcome, refreshes the world. */
  const act = useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      setBusy(true);
      try {
        await fn();
        await refresh();
        if (success) toast.success(success);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.isAuthError) {
          clearToken();
          setSignedIn(false);
          toast.error('Your session expired. Please sign in again.');
        } else if (!(e instanceof WalletError && e.cancelled)) {
          toast.error(describeError(e));
        }
        // Re-sync: the failure may have been caused by a stale board.
        await refresh({ quiet: true });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const claim = useCallback((tileId: number) => act(() => api.claim(tileId), 'Block claimed.'), [act]);
  const upgrade = useCallback((tileId: number) => act(() => api.upgrade(tileId), 'Block built up.'), [act]);
  const raid = useCallback(
    (tileId: number, pressure: number) => act(() => api.siege(tileId, pressure), 'Raid under way.'),
    [act],
  );
  const reinforce = useCallback(
    (siegeId: string, amount: number) => act(() => api.reinforce(siegeId, amount), 'Reinforcements committed.'),
    [act],
  );
  const rename = useCallback((name: string) => act(() => api.setName(name), 'Name updated.'), [act]);
  const recolour = useCallback((colorIndex: number) => act(() => api.setColour(colorIndex)), [act]);

  /**
   * Mints a deed: quote, pay real NIM through the wallet, then redeem once the
   * transaction is on chain. Progress is surfaced throughout because this step
   * involves the player's own money and must never feel ambiguous.
   */
  const mintDeed = useCallback(
    async (tileId: number): Promise<boolean> => {
      setBusy(true);
      setDeedProgress(null);
      try {
        const quote = await api.prepareDeed(tileId);
        const wallet = await getWallet();
        setWalletLabel(wallet.label);

        setDeedProgress('Confirm the payment in your wallet...');
        const txHash = await wallet.sendDeedPayment({
          recipient: quote.treasury,
          valueLuna: quote.valueLuna,
          data: quote.data,
        });

        setDeedProgress('Waiting for the Nimiq network to confirm...');
        await claimDeedWithRetry(tileId, txHash, (attempt, max) => {
          setDeedProgress(`Confirming on Nimiq (${attempt}/${max})...`);
        });

        await refresh();
        toast.success(`Deed minted on ${quote.label}. It is now raid-proof.`);
        return true;
      } catch (e) {
        if (e instanceof WalletError && e.cancelled) return false;
        toast.error(describeError(e), { duration: 8000 });
        await refresh({ quiet: true });
        return false;
      } finally {
        setBusy(false);
        setDeedProgress(null);
      }
    },
    [refresh],
  );

  const value = useMemo<GameContextValue>(
    () => ({
      status,
      error,
      snapshot,
      me,
      config,
      signedIn,
      busy,
      liveScrap,
      ratePerSec,
      walletLabel,
      inNimiqPay: isInNimiqPay(),
      deedProgress,
      signIn,
      signOut,
      refresh,
      claim,
      upgrade,
      raid,
      reinforce,
      mintDeed,
      rename,
      recolour,
    }),
    [
      status, error, snapshot, me, config, signedIn, busy, liveScrap, ratePerSec,
      walletLabel, deedProgress, signIn, signOut, refresh, claim, upgrade, raid,
      reinforce, mintDeed, rename, recolour,
    ],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
