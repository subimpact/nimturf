import { bytesToHex, hexToBytes, normaliseAddress, publicKeyToAddress } from '@nimturf/shared';

/**
 * One wallet interface, two backends.
 *
 * Inside Nimiq Pay the mini-app provider is injected and used directly. In a
 * desktop browser the same operations go through the Nimiq Hub popup at
 * hub.nimiq.com. Everything above this file is written against `NimiqWallet`
 * and never needs to know which one is in play, so sign-in, payments and the
 * whole game work identically in both places.
 */

export type WalletKind = 'nimiq-pay' | 'hub';

export interface SignedChallenge {
  /** Derived from the public key that actually signed - see signChallenge. */
  address: string;
  publicKey: string;
  signature: string;
}

export interface DeedPayment {
  recipient: string;
  valueLuna: number;
  /** Written into the transaction's data field for on-chain audit. */
  data: string;
}

export interface NimiqWallet {
  kind: WalletKind;
  /** Human label for the UI, e.g. "Nimiq Pay". */
  label: string;
  listAccounts(): Promise<string[]>;
  signChallenge(message: string): Promise<SignedChallenge>;
  sendDeedPayment(payment: DeedPayment): Promise<string>;
}

/** Raised for anything the user can act on. `cancelled` is not really an error. */
export class WalletError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

const APP_NAME = 'NimTurf';

interface ProviderError {
  error: { type?: string; message?: string };
}

function isProviderError(value: unknown): value is ProviderError {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/**
 * The mini-app provider resolves with either a value or `{ error }` rather
 * than rejecting, so every call is funnelled through here. Narrowing the
 * union away at the boundary keeps the error shape out of the rest of the app.
 */
function unwrap<T>(result: T): Exclude<T, ProviderError> {
  if (isProviderError(result)) {
    const message = result.error?.message ?? 'The wallet rejected the request.';
    const cancelled = /denied|cancel|reject/i.test(`${result.error?.type ?? ''} ${message}`);
    throw new WalletError(message, cancelled);
  }
  return result as Exclude<T, ProviderError>;
}

/**
 * Derives the address from the public key that produced the signature.
 *
 * Deliberately not taken from `listAccounts()`: the wallet may hold several
 * addresses, and the one that signed is the only one we can actually prove.
 * The server repeats this derivation, so a mismatch simply fails to verify.
 */
function addressFromSignature(publicKeyHex: string): string {
  const bytes = hexToBytes(publicKeyHex);
  if (!bytes || bytes.length !== 32) {
    throw new WalletError('The wallet returned a malformed public key.');
  }
  return publicKeyToAddress(bytes);
}

// ---------------------------------------------------------------------------
// Nimiq Pay (mini app)
// ---------------------------------------------------------------------------

/** True when the page is running inside the Nimiq Pay mini-app host. */
export function isInNimiqPay(): boolean {
  return typeof window !== 'undefined' && (Boolean(window.nimiqPay) || Boolean(window.nimiq));
}

async function createNimiqPayWallet(): Promise<NimiqWallet> {
  const { init } = await import('@nimiq/mini-app-sdk');
  const provider = await init({ timeout: 6000 });

  return {
    kind: 'nimiq-pay',
    label: 'Nimiq Pay',

    async listAccounts() {
      const accounts = unwrap(await provider.listAccounts());
      return accounts.map(normaliseAddress);
    },

    async signChallenge(message: string) {
      const result = unwrap(await provider.sign(message));
      if (!result?.publicKey || !result?.signature) {
        throw new WalletError('The wallet did not return a signature.');
      }
      return {
        address: addressFromSignature(result.publicKey),
        publicKey: result.publicKey,
        signature: result.signature,
      };
    },

    async sendDeedPayment({ recipient, valueLuna, data }) {
      const hash = unwrap(
        await provider.sendBasicTransactionWithData({ recipient, value: valueLuna, data }),
      );
      if (typeof hash !== 'string' || !hash) {
        throw new WalletError('The wallet did not return a transaction hash.');
      }
      return hash;
    },
  };
}

// ---------------------------------------------------------------------------
// Nimiq Hub (desktop browser)
// ---------------------------------------------------------------------------

const HUB_URL = 'https://hub.nimiq.com';

async function createHubWallet(): Promise<NimiqWallet> {
  const module = await import('@nimiq/hub-api');
  const HubApi = module.default;
  const hub = new HubApi(HUB_URL);

  /** The Hub reports cancellation by throwing; treat that as a soft error. */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/cancel|abort|closed|denied/i.test(message)) {
        throw new WalletError('Sign-in was cancelled.', true);
      }
      if (/popup/i.test(message)) {
        throw new WalletError('Your browser blocked the Nimiq Hub popup. Allow popups and try again.');
      }
      throw new WalletError(message);
    }
  };

  return {
    kind: 'hub',
    label: 'Nimiq Hub',

    async listAccounts() {
      const chosen = await call(() => hub.chooseAddress({ appName: APP_NAME }));
      return [normaliseAddress(chosen.address)];
    },

    async signChallenge(message: string) {
      const signed = await call(() => hub.signMessage({ appName: APP_NAME, message }));
      const publicKey = bytesToHex(signed.signerPublicKey);
      return {
        address: addressFromSignature(publicKey),
        publicKey,
        signature: bytesToHex(signed.signature),
      };
    },

    async sendDeedPayment({ recipient, valueLuna, data }) {
      const tx = await call(() =>
        hub.checkout({
          appName: APP_NAME,
          recipient,
          value: valueLuna,
          extraData: data,
        }),
      );
      if (!tx?.hash) throw new WalletError('The Hub did not return a transaction hash.');
      return tx.hash;
    },
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

let cached: Promise<NimiqWallet> | null = null;

/**
 * Picks the right wallet for wherever the game is running.
 *
 * Nimiq Pay is preferred when its provider is present; if initialising it
 * fails for any reason we fall back to the Hub rather than leaving the player
 * with no way to sign in at all.
 */
export function getWallet(): Promise<NimiqWallet> {
  if (cached) return cached;
  cached = (async () => {
    if (isInNimiqPay()) {
      try {
        return await createNimiqPayWallet();
      } catch (e) {
        console.warn('Nimiq Pay provider unavailable, falling back to the Hub', e);
      }
    }
    return createHubWallet();
  })();
  return cached;
}

/** Forgets the detected wallet, so the next sign-in re-detects. */
export function resetWallet(): void {
  cached = null;
}

/**
 * The player's language as chosen in Nimiq Pay, when available. Used to set
 * the document language so the browser's own UI matches the host app.
 */
export function hostLanguage(): string | undefined {
  return typeof window !== 'undefined' ? window.nimiqPay?.language : undefined;
}
