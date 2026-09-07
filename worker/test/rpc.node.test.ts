import { encodeDeedData } from '@nimturf/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NimiqRpc,
  checkDeedPayment,
  decodeTxData,
  parseRpcTransaction,
  type RpcTransaction,
} from '../src/nimiq/rpc';

/**
 * The fixtures here are shaped exactly like real Nimiq (Albatross) RPC
 * responses, captured from a live mainnet node. Two details in that shape are
 * easy to get wrong and are the reason these tests exist:
 *
 *   1. addresses come back in spaced, user-friendly form, and
 *   2. the transaction's data field is `recipientData`, not `data`.
 *
 * Getting either wrong would mean a player pays real NIM and the deed is
 * silently rejected, so both are pinned here.
 */

/** A real staking transaction from Nimiq mainnet block 60980970. */
const REAL_TX = {
  hash: 'ca94bdd76ea4077228725e6904aa90508d36ef9fe437c86192356e8c47bbec7b',
  blockNumber: 60980970,
  timestamp: 1788795062186,
  confirmations: 30,
  size: 285,
  from: 'NQ76 QETQ ABT5 AL73 VX6D M0KM L7A2 DP0G FGDY',
  fromType: 0,
  to: 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001',
  toType: 3,
  value: 0,
  fee: 0,
  senderData: '',
  recipientData: '03ba9061c030a9c1b88840e7274232c9ab3d8a5651',
  flags: 2,
  validityStartHeight: 60980968,
};

const TREASURY = 'NQ07 1234 5678 90AB CDEF GHJK LMNP QRST UVXY';
const PLAYER = 'NQ76 QETQ ABT5 AL73 VX6D M0KM L7A2 DP0G FGDY';

/** Hex-encodes text the way a transaction data field carries it. */
function toHex(text: string): string {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('parseRpcTransaction', () => {
  it('parses a real mainnet transaction', () => {
    const tx = parseRpcTransaction(REAL_TX);
    expect(tx).not.toBeNull();
    expect(tx!.hash).toBe(REAL_TX.hash);
    // Addresses must be normalised, or every comparison downstream fails.
    expect(tx!.from).toBe(REAL_TX.from.replace(/\s/g, ''));
    expect(tx!.to).toBe(REAL_TX.to.replace(/\s/g, ''));
    expect(tx!.from).not.toContain(' ');
    expect(tx!.blockNumber).toBe(60980970);
  });

  it('reads the data field from recipientData, as real nodes send it', () => {
    const tx = parseRpcTransaction(REAL_TX);
    expect(tx!.data).toBe(REAL_TX.recipientData);
  });

  it('still accepts a node that uses `data` instead', () => {
    const tx = parseRpcTransaction({ ...REAL_TX, recipientData: undefined, data: 'abcd' });
    expect(tx!.data).toBe('abcd');
  });

  it('rejects anything that is not a usable transaction', () => {
    for (const bad of [
      null, undefined, 'a string', 42, {},
      { hash: 'x', from: 'a' },                          // no recipient
      { hash: 'x', from: 'a', to: 'b' },                 // no value
      { hash: 'x', from: 'a', to: 'b', value: 'lots' },  // value not a number
      { hash: 'x', from: 'a', to: 'b', value: -5 },      // negative value
    ]) {
      expect(parseRpcTransaction(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('floors a fractional value rather than carrying a float into accounting', () => {
    const tx = parseRpcTransaction({ ...REAL_TX, value: 200000.9 });
    expect(tx!.value).toBe(200000);
  });
});

describe('decodeTxData', () => {
  it('decodes hex to text', () => {
    expect(decodeTxData(toHex('NIMTURF:1:S1:319'))).toBe('NIMTURF:1:S1:319');
    expect(decodeTxData(`0x${toHex('hello')}`)).toBe('hello');
  });

  it('returns empty for missing or malformed hex', () => {
    for (const bad of ['', null, undefined, 'xyz', 'abc']) {
      expect(decodeTxData(bad as string)).toBe('');
    }
  });
});

describe('checkDeedPayment', () => {
  const base = {
    expectedSender: PLAYER,
    treasury: TREASURY,
    minValueLuna: 200_000,
    expectedData: encodeDeedData('S1', 319),
  };

  /** A well-formed deed payment. */
  function deedTx(overrides: Partial<RpcTransaction> = {}): RpcTransaction {
    return {
      hash: 'a'.repeat(64),
      from: PLAYER.replace(/\s/g, ''),
      to: TREASURY.replace(/\s/g, ''),
      value: 200_000,
      data: toHex(encodeDeedData('S1', 319)),
      blockNumber: 1,
      timestamp: 1,
      ...overrides,
    };
  }

  it('accepts a correct payment', () => {
    expect(checkDeedPayment({ tx: deedTx(), ...base })).toBeNull();
  });

  it('accepts a spaced sender address, since wallets send them that way', () => {
    expect(checkDeedPayment({ tx: deedTx(), ...base, expectedSender: PLAYER })).toBeNull();
    expect(checkDeedPayment({ tx: deedTx(), ...base, treasury: TREASURY })).toBeNull();
  });

  it('accepts an overpayment', () => {
    expect(checkDeedPayment({ tx: deedTx({ value: 500_000 }), ...base })).toBeNull();
  });

  it('rejects a payment from a different address', () => {
    // Otherwise one player could redeem somebody else's transaction.
    const other = 'NQ37 LK9B X46C 5EYQ EKJN 8DU1 JHXH V4J3 KDXA'.replace(/\s/g, '');
    expect(checkDeedPayment({ tx: deedTx({ from: other }), ...base })).toBe('wrong_sender');
  });

  it('rejects a payment sent somewhere other than the treasury', () => {
    const elsewhere = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001'.replace(/\s/g, '');
    expect(checkDeedPayment({ tx: deedTx({ to: elsewhere }), ...base })).toBe('wrong_recipient');
  });

  it('rejects an underpayment, even by one Luna', () => {
    expect(checkDeedPayment({ tx: deedTx({ value: 199_999 }), ...base })).toBe('underpaid');
  });

  it('rejects a transaction whose data names a different tile', () => {
    // The whole point of the data field: a payment is bound to one tile.
    expect(checkDeedPayment({ tx: deedTx({ data: toHex(encodeDeedData('S1', 320)) }), ...base })).toBe('wrong_data');
  });

  it('rejects a transaction whose data names a different season', () => {
    expect(checkDeedPayment({ tx: deedTx({ data: toHex(encodeDeedData('S2', 319)) }), ...base })).toBe('wrong_data');
  });

  it('rejects an ordinary payment with no deed data at all', () => {
    expect(checkDeedPayment({ tx: deedTx({ data: '' }), ...base })).toBe('wrong_data');
  });

  it('tolerates whitespace around the data', () => {
    expect(checkDeedPayment({ tx: deedTx({ data: toHex(` ${encodeDeedData('S1', 319)} `) }), ...base })).toBeNull();
  });
});

describe('NimiqRpc.getTransaction', () => {
  /** Replaces fetch with a canned JSON-RPC response. */
  function stubRpc(payload: unknown, ok = true) {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => payload,
      } as Response;
    });
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  const VALID_HASH = 'ca94bdd76ea4077228725e6904aa90508d36ef9fe437c86192356e8c47bbec7b';

  it('returns the transaction, unwrapping the Albatross data envelope', async () => {
    stubRpc({ jsonrpc: '2.0', id: 1, result: { data: REAL_TX, metadata: null } });
    const result = await new NimiqRpc('https://node.example').getTransaction(VALID_HASH);
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.tx.hash).toBe(REAL_TX.hash);
  });

  it('treats a node saying "Transaction not found" as not_found, not unavailable', async () => {
    /*
     * This is the real error a Nimiq node returns for an unconfirmed or
     * unknown hash - note the useful text is in `data`, not `message`.
     * Misreading it as an outage would tell a player who has just paid that
     * the network is down.
     */
    stubRpc({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'Internal error', data: `Transaction not found: ${VALID_HASH}` },
    });
    const result = await new NimiqRpc('https://node.example').getTransaction(VALID_HASH);
    expect(result.status).toBe('not_found');
  });

  it('treats an unparseable hash as not_found', async () => {
    stubRpc({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Invalid params', data: 'Could not parse hex string' },
    });
    const result = await new NimiqRpc('https://node.example').getTransaction(VALID_HASH);
    expect(result.status).toBe('not_found');
  });

  it('reports a genuine node problem as unavailable', async () => {
    stubRpc({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Consensus not established' } });
    const result = await new NimiqRpc('https://node.example').getTransaction(VALID_HASH);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.detail).toMatch(/consensus/i);
  });

  it('reports an HTTP failure as unavailable', async () => {
    stubRpc({}, false);
    const result = await new NimiqRpc('https://node.example').getTransaction(VALID_HASH);
    expect(result.status).toBe('unavailable');
  });

  it('reports a network failure as unavailable rather than throwing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const result = await new NimiqRpc('https://node.example').getTransaction(VALID_HASH);
    expect(result.status).toBe('unavailable');
  });

  it('rejects a malformed hash without calling the network at all', async () => {
    const calls = stubRpc({});
    const result = await new NimiqRpc('https://node.example').getTransaction('not-a-hash');
    expect(result.status).toBe('not_found');
    expect(calls).toHaveLength(0);
  });

  it('reports unavailable when no endpoint is configured', async () => {
    const result = await new NimiqRpc('').getTransaction(VALID_HASH);
    expect(result.status).toBe('unavailable');
  });

  it('lowercases the hash it sends, since nodes expect canonical hex', async () => {
    const calls = stubRpc({ jsonrpc: '2.0', id: 1, result: { data: REAL_TX } });
    await new NimiqRpc('https://node.example').getTransaction(VALID_HASH.toUpperCase());
    expect((calls[0].body as { params: string[] }).params[0]).toBe(VALID_HASH);
  });
});
