import { normaliseAddress } from '@nimturf/shared';

/**
 * Minimal Nimiq (Albatross) JSON-RPC client.
 *
 * Used for exactly one job: confirming that a deed transaction really exists
 * on the Nimiq blockchain before the game grants anything for it. The game
 * never trusts a client-supplied transaction hash on its own.
 */

export interface RpcTransaction {
  hash: string;
  from: string;
  to: string;
  /** Value in Luna. */
  value: number;
  /** Recipient data, hex encoded, or empty. */
  data: string;
  blockNumber: number;
  timestamp: number;
}

export type RpcLookup =
  | { status: 'found'; tx: RpcTransaction }
  /** The node answered, but has no such transaction (yet). */
  | { status: 'not_found' }
  /** The node could not be reached or replied with something unusable. */
  | { status: 'unavailable'; detail: string };

/** Decodes a hex-encoded transaction data field to text. */
export function decodeTxData(hex: string | null | undefined): string {
  if (!hex) return '';
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return '';
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
  try {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch {
    return '';
  }
}

/** Normalises the several shapes a Nimiq RPC node may use for a transaction. */
export function parseRpcTransaction(raw: unknown): RpcTransaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;

  const hash = typeof t.hash === 'string' ? t.hash : null;
  const from = typeof t.from === 'string' ? t.from : null;
  const to = typeof t.to === 'string' ? t.to : null;
  if (!hash || !from || !to) return null;

  const value = Number(t.value);
  if (!Number.isFinite(value) || value < 0) return null;

  // Albatross exposes recipient data as `data`; some nodes use `recipientData`.
  const dataHex =
    (typeof t.data === 'string' ? t.data : null) ??
    (typeof t.recipientData === 'string' ? t.recipientData : null) ??
    '';

  return {
    hash,
    from: normaliseAddress(from),
    to: normaliseAddress(to),
    value: Math.floor(value),
    data: dataHex,
    blockNumber: Number(t.blockNumber) || 0,
    timestamp: Number(t.timestamp) || 0,
  };
}

export class NimiqRpc {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 8000,
  ) {}

  private async call(
    method: string,
    params: unknown[],
  ): Promise<{ ok: true; result: unknown } | { ok: false; detail: string; missing?: boolean }> {
    if (!this.url) return { ok: false, detail: 'No Nimiq RPC endpoint is configured.' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, detail: `RPC HTTP ${res.status}` };

      const body = (await res.json()) as {
        result?: unknown;
        error?: { message?: string; data?: unknown };
      };

      if (body.error) {
        /*
         * Nimiq nodes report an unknown transaction as a JSON-RPC *error*
         * rather than a null result, and the useful part is in `error.data`
         * ("Transaction not found: <hash>") while `error.message` is only
         * "Internal error". Distinguishing that from a genuinely unreachable
         * node matters: a transaction still being mined should tell the player
         * to wait, not that the network is down.
         */
        const detail = [body.error.message, typeof body.error.data === 'string' ? body.error.data : null]
          .filter(Boolean)
          .join(': ');
        const missing = /not found|does not exist|unknown transaction|could not parse|invalid params/i.test(detail);
        return { ok: false, detail: detail || 'RPC error', missing };
      }
      // Albatross wraps payloads in { data, metadata }.
      const result =
        body.result && typeof body.result === 'object' && 'data' in (body.result as object)
          ? (body.result as { data: unknown }).data
          : body.result;
      return { ok: true, result };
    } catch (err) {
      const detail = err instanceof Error && err.name === 'AbortError' ? 'RPC timed out' : String(err);
      return { ok: false, detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Looks a transaction up by hash. */
  async getTransaction(hash: string): Promise<RpcLookup> {
    if (!/^[0-9a-fA-F]{64}$/.test(hash.trim())) return { status: 'not_found' };

    const res = await this.call('getTransactionByHash', [hash.trim().toLowerCase()]);
    if (!res.ok) {
      // A node that says "not found" has answered; it is not unavailable.
      return res.missing ? { status: 'not_found' } : { status: 'unavailable', detail: res.detail };
    }
    if (res.result === null || res.result === undefined) return { status: 'not_found' };

    const tx = parseRpcTransaction(res.result);
    if (!tx) return { status: 'not_found' };
    return { status: 'found', tx };
  }
}

/**
 * Checks a transaction against everything a deed payment must satisfy.
 * Returns null when the payment is valid, or a machine-readable reason.
 */
export type DeedPaymentFailure =
  | 'wrong_sender'
  | 'wrong_recipient'
  | 'underpaid'
  | 'wrong_data';

export function checkDeedPayment(input: {
  tx: RpcTransaction;
  expectedSender: string;
  treasury: string;
  minValueLuna: number;
  expectedData: string;
}): DeedPaymentFailure | null {
  if (input.tx.from !== normaliseAddress(input.expectedSender)) return 'wrong_sender';
  if (input.tx.to !== normaliseAddress(input.treasury)) return 'wrong_recipient';
  if (input.tx.value < input.minValueLuna) return 'underpaid';
  if (decodeTxData(input.tx.data).trim() !== input.expectedData) return 'wrong_data';
  return null;
}

export const DEED_PAYMENT_MESSAGES: Record<DeedPaymentFailure, string> = {
  wrong_sender: 'That transaction was sent from a different address than the one you signed in with.',
  wrong_recipient: 'That transaction was not sent to the NimTurf treasury.',
  underpaid: 'That transaction did not include enough NIM for a deed.',
  wrong_data: 'That transaction does not carry the deed claim for this tile.',
};
