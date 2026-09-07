import {
  DEED_PRICE_LUNA,
  encodeDeedData,
  isValidAddress,
  normaliseAddress,
  type ApiResponse,
  type MeState,
} from '@nimturf/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  buildChallengeMessage,
  createNonce,
  createSessionToken,
  verifySessionToken,
} from './auth';
import { DEED_PAYMENT_MESSAGES, NimiqRpc, checkDeedPayment } from './nimiq/rpc';
import { VERIFY_FAILURE_MESSAGES, verifySignedMessage } from './nimiq/verify';
import { World } from './world';

export { World };

export interface Env {
  WORLD: DurableObjectNamespace<World>;
  SEASON_ID: string;
  WORLD_SEED: string;
  NIMIQ_NETWORK: string;
  /** HMAC secret for session tokens. Set with `wrangler secret put`. */
  SESSION_SECRET?: string;
  /** Nimiq address that receives deed payments. */
  TREASURY_ADDRESS?: string;
  /** Nimiq JSON-RPC endpoint used to confirm deed transactions. */
  NIMIQ_RPC_URL?: string;
  /** Comma-separated list of allowed browser origins. */
  ALLOWED_ORIGINS?: string;
}

type Vars = { address: string };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}
function err(code: string, message: string): ApiResponse<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Every world is one Durable Object, addressed by season *and* seed.
 *
 * Including the seed means changing it starts a genuinely fresh world rather
 * than leaving an existing one with terrain that no longer matches the
 * configured seed. It is also the supported way to reset a world.
 */
function world(env: Env) {
  return env.WORLD.get(env.WORLD.idFromName(`season:${env.SEASON_ID}:${env.WORLD_SEED}`));
}

function sessionSecret(env: Env): string | null {
  const secret = env.SESSION_SECRET;
  // Refuse to issue guessable sessions rather than falling back to a default.
  if (!secret || secret.length < 16) return null;
  return secret;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(
  '/api/*',
  cors({
    /**
     * Honours ALLOWED_ORIGINS when it is set, and denies anything else by
     * returning null - sending back a *different* allowed origin would be a
     * header that is simply untrue.
     *
     * When it is unset the caller's origin is reflected. That is safe here
     * because sessions are bearer tokens in localStorage rather than cookies,
     * so another origin cannot ride along on a user's credentials; CORS is not
     * the security boundary for this API. Production deployments should still
     * set ALLOWED_ORIGINS - see the deployment notes in the README.
     */
    origin: (origin, c) => {
      const configured = (c.env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (configured.length === 0) return origin ?? '*';
      return configured.includes(origin) ? origin : null;
    },
    allowHeaders: ['content-type', 'authorization'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 86400,
  }),
);

/** Reads the bearer token, if present, without requiring it. */
async function readSession(c: { req: { header: (n: string) => string | undefined }; env: Env }): Promise<string | null> {
  const header = c.req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return null;
  const secret = sessionSecret(c.env);
  if (!secret) return null;
  return verifySessionToken(header.slice(7).trim(), secret);
}

/** Rejects the request unless it carries a valid session. */
const requireAuth = async (c: any, next: () => Promise<void>) => {
  const address = await readSession(c);
  if (!address) {
    return c.json(err('unauthorised', 'Please sign in with your Nimiq wallet to do that.'), 401);
  }
  c.set('address', address);
  await next();
};

/** Parses a JSON body, tolerating an empty or malformed one. */
async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function intField(src: Record<string, unknown>, key: string): number | null {
  const n = Number(src[key]);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

// ---------------------------------------------------------------------------
// Health and metadata
// ---------------------------------------------------------------------------

app.get('/api/health', (c) =>
  c.json(
    ok({
      status: 'ok',
      season: c.env.SEASON_ID,
      network: c.env.NIMIQ_NETWORK,
      // Surfaced so a misconfigured deployment is obvious rather than silent.
      deedsEnabled: Boolean(c.env.TREASURY_ADDRESS && c.env.NIMIQ_RPC_URL),
      authEnabled: sessionSecret(c.env) !== null,
      originsLocked: Boolean(c.env.ALLOWED_ORIGINS),
      time: Date.now(),
    }),
  ),
);

app.get('/api/config', (c) =>
  c.json(
    ok({
      seasonId: c.env.SEASON_ID,
      network: c.env.NIMIQ_NETWORK,
      treasury: c.env.TREASURY_ADDRESS ? normaliseAddress(c.env.TREASURY_ADDRESS) : null,
      deedPriceLuna: DEED_PRICE_LUNA,
      deedsEnabled: Boolean(c.env.TREASURY_ADDRESS && c.env.NIMIQ_RPC_URL),
    }),
  ),
);

// ---------------------------------------------------------------------------
// Authentication: prove you own a Nimiq address
// ---------------------------------------------------------------------------

/**
 * Step 1 of sign-in: hand out a single-use nonce and the exact text the
 * wallet should sign.
 */
app.post('/api/auth/challenge', async (c) => {
  if (!sessionSecret(c.env)) {
    return c.json(err('not_configured', 'Sign-in is not available: the server has no session secret configured.'), 503);
  }
  const now = Date.now();
  const nonce = createNonce();
  await world(c.env).storeChallenge(nonce, now);
  return c.json(
    ok({
      nonce,
      message: buildChallengeMessage({ nonce, seasonId: c.env.SEASON_ID, issuedAt: now }),
    }),
  );
});

/**
 * Step 2 of sign-in: verify the wallet signature over that nonce and issue a
 * session. The nonce is consumed here, so a signature works exactly once.
 */
app.post('/api/auth/verify', async (c) => {
  const secret = sessionSecret(c.env);
  if (!secret) {
    return c.json(err('not_configured', 'Sign-in is not available: the server has no session secret configured.'), 503);
  }

  const b = await body(c);
  const address = typeof b.address === 'string' ? b.address : '';
  const publicKey = typeof b.publicKey === 'string' ? b.publicKey : '';
  const signature = typeof b.signature === 'string' ? b.signature : '';
  const nonce = typeof b.nonce === 'string' ? b.nonce : '';

  if (!address || !publicKey || !signature || !nonce) {
    return c.json(err('bad_request', 'Sign-in is missing the address, key, signature or nonce.'), 400);
  }
  if (!isValidAddress(address)) {
    return c.json(err('bad_address', 'That is not a valid Nimiq address.'), 400);
  }

  const now = Date.now();
  const stub = world(c.env);
  const challenge = await stub.consumeChallenge(nonce, now);
  if (!challenge) {
    return c.json(err('bad_nonce', 'That sign-in request expired or was already used. Please try again.'), 400);
  }

  const message = buildChallengeMessage({ nonce, seasonId: c.env.SEASON_ID, issuedAt: challenge.issuedAt });
  const verified = await verifySignedMessage({ message, publicKey, signature, address });
  if (!verified.ok) {
    return c.json(err(verified.reason, VERIFY_FAILURE_MESSAGES[verified.reason]), 401);
  }

  await stub.ensurePlayer(verified.address, now);
  const token = await createSessionToken(verified.address, secret, now);
  const snapshot = await stub.snapshot(verified.address, now);

  return c.json(ok({ token, address: verified.address, me: snapshot.me as MeState }));
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The world. Works signed out too, so anyone can watch the map. */
app.get('/api/world', async (c) => {
  const address = await readSession(c);
  const snapshot = await world(c.env).snapshot(address, Date.now());
  return c.json(ok(snapshot));
});

app.get('/api/leaderboard', async (c) => {
  const limit = Number(c.req.query('limit') ?? 25);
  const rows = await world(c.env).leaderboard(Number.isFinite(limit) ? limit : 25, Date.now());
  return c.json(ok(rows));
});

/** Public audit trail of every on-chain deed. */
app.get('/api/deeds', async (c) => {
  const rows = await world(c.env).deedLog(50);
  return c.json(ok(rows));
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

app.post('/api/actions/claim', requireAuth, async (c) => {
  const tileId = intField(await body(c), 'tileId');
  if (tileId === null) return c.json(err('bad_request', 'Which tile?'), 400);
  const result = await world(c.env).claim(c.get('address'), tileId, Date.now());
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/actions/upgrade', requireAuth, async (c) => {
  const tileId = intField(await body(c), 'tileId');
  if (tileId === null) return c.json(err('bad_request', 'Which tile?'), 400);
  const result = await world(c.env).upgrade(c.get('address'), tileId, Date.now());
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/actions/siege', requireAuth, async (c) => {
  const b = await body(c);
  const tileId = intField(b, 'tileId');
  const pressure = intField(b, 'pressure');
  if (tileId === null || pressure === null) {
    return c.json(err('bad_request', 'A raid needs a tile and an amount of TURF.'), 400);
  }
  const result = await world(c.env).openSiege(c.get('address'), tileId, pressure, Date.now());
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/actions/reinforce', requireAuth, async (c) => {
  const b = await body(c);
  const siegeId = typeof b.siegeId === 'string' ? b.siegeId : '';
  const amount = intField(b, 'amount');
  if (!siegeId || amount === null) {
    return c.json(err('bad_request', 'Reinforcing needs a raid and an amount of TURF.'), 400);
  }
  const result = await world(c.env).reinforce(c.get('address'), siegeId, amount, Date.now());
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/profile/name', requireAuth, async (c) => {
  const b = await body(c);
  const name = typeof b.name === 'string' ? b.name : '';
  const result = await world(c.env).setName(c.get('address'), name, Date.now());
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/profile/colour', requireAuth, async (c) => {
  const colorIndex = intField(await body(c), 'colorIndex');
  if (colorIndex === null) return c.json(err('bad_request', 'Which colour?'), 400);
  const result = await world(c.env).setColour(c.get('address'), colorIndex, Date.now());
  return c.json(result, result.ok ? 200 : 400);
});

// ---------------------------------------------------------------------------
// Deeds: real NIM, verified on chain
// ---------------------------------------------------------------------------

/** Tells the client exactly what transaction to ask the wallet to send. */
app.post('/api/deed/prepare', requireAuth, async (c) => {
  const tileId = intField(await body(c), 'tileId');
  if (tileId === null) return c.json(err('bad_request', 'Which tile?'), 400);
  const result = await world(c.env).prepareDeed(c.get('address'), tileId, Date.now());
  return c.json(result, result.ok ? 200 : 400);
});

/**
 * Redeems a deed against a real Nimiq transaction.
 *
 * The transaction is looked up on the Nimiq network and checked field by
 * field. If the node cannot be reached, or the transaction has not been
 * included in a block yet, the client is told to retry rather than being told
 * it failed - a confirmed payment must never be lost to a slow node.
 */
app.post('/api/deed/claim', requireAuth, async (c) => {
  const b = await body(c);
  const tileId = intField(b, 'tileId');
  const txHash = typeof b.txHash === 'string' ? b.txHash.trim() : '';
  if (tileId === null || !txHash) {
    return c.json(err('bad_request', 'Claiming a deed needs a tile and a transaction hash.'), 400);
  }

  const rpcUrl = c.env.NIMIQ_RPC_URL;
  const treasury = c.env.TREASURY_ADDRESS;
  if (!rpcUrl || !treasury) {
    return c.json(err('not_configured', 'Deeds are temporarily unavailable on this deployment.'), 503);
  }

  const address = c.get('address');
  const lookup = await new NimiqRpc(rpcUrl).getTransaction(txHash);

  if (lookup.status === 'unavailable') {
    return c.json(
      err('rpc_unavailable', 'We could not reach the Nimiq network just now. Your payment is safe - please retry in a moment.'),
      503,
    );
  }
  if (lookup.status === 'not_found') {
    return c.json(
      err('tx_pending', 'That transaction is not in a block yet. This usually takes a few seconds - please retry.'),
      409,
    );
  }

  const problem = checkDeedPayment({
    tx: lookup.tx,
    expectedSender: address,
    treasury,
    minValueLuna: DEED_PRICE_LUNA,
    expectedData: encodeDeedData(c.env.SEASON_ID, tileId),
  });
  if (problem) {
    return c.json(err(problem, DEED_PAYMENT_MESSAGES[problem]), 400);
  }

  const result = await world(c.env).grantDeed(address, tileId, txHash, Date.now());
  return c.json(result, result.ok ? 200 : 400);
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

app.notFound((c) => c.json(err('not_found', 'No such endpoint.'), 404));

app.onError((e, c) => {
  // Log the detail for us, return something actionable to the player.
  console.error('Unhandled error', e);
  return c.json(err('internal', 'Something went wrong on our side. Please try again.'), 500);
});

export default app;
