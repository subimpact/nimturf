import type {
  ApiResponse,
  LeaderboardEntry,
  MeState,
  Siege,
  SnapshotResponse,
} from '@nimturf/shared';

/**
 * Typed client for the NimTurf API.
 *
 * Every call funnels through `request`, so there is exactly one place that
 * knows how to turn a network failure, an HTTP error or a game rule rejection
 * into a message worth showing a player.
 */

const DEFAULT_DEV_API = 'http://127.0.0.1:8787';

/** Base URL of the API. Empty string means "same origin". */
export const API_BASE: string = (() => {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured !== undefined) return configured.replace(/\/$/, '');
  return import.meta.env.DEV ? DEFAULT_DEV_API : '';
})();

const TOKEN_KEY = 'nimturf.session';

/** localStorage can throw in private modes, so every access is guarded. */
export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* Sessions simply will not persist; the game still works. */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** An error with a code the UI can branch on and a message it can show. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the session is gone and the player needs to sign in again. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'unauthorised';
  }

  /** True when retrying the same call could reasonably succeed. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 503 || this.status === 409 || this.status >= 500;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = false, timeoutMs = 15000 } = options;

  const token = auth ? loadToken() : null;
  if (auth && !token) {
    throw new ApiError('unauthorised', 'Please sign in with your Nimiq wallet first.', 401);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new ApiError(
      aborted ? 'timeout' : 'offline',
      aborted
        ? 'The server took too long to answer. Please try again.'
        : 'Cannot reach NimTurf. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await res.json()) as ApiResponse<T>;
  } catch {
    /* fall through to the status-based error below */
  }

  if (payload && payload.ok === true) return payload.data;

  if (payload && payload.ok === false) {
    throw new ApiError(payload.error.code, payload.error.message, res.status);
  }

  throw new ApiError('bad_response', `The server returned an unexpected response (${res.status}).`, res.status);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export interface HealthInfo {
  status: string;
  season: string;
  network: string;
  deedsEnabled: boolean;
  authEnabled: boolean;
  originsLocked: boolean;
  time: number;
}

export interface GameConfig {
  seasonId: string;
  network: string;
  treasury: string | null;
  deedPriceLuna: number;
  deedsEnabled: boolean;
}

export interface DeedQuote {
  treasury: string;
  valueLuna: number;
  data: string;
  label: string;
}

export interface DeedLogEntry {
  txHash: string;
  address: string;
  tileId: number;
  label: string;
  mintedAt: number;
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),
  config: () => request<GameConfig>('/api/config'),

  challenge: () => request<{ nonce: string; message: string }>('/api/auth/challenge', { method: 'POST' }),

  verify: (input: { address: string; publicKey: string; signature: string; nonce: string }) =>
    request<{ token: string; address: string; me: MeState }>('/api/auth/verify', {
      method: 'POST',
      body: input,
    }),

  /** Works signed out too, so the map is visible before anyone commits. */
  world: () => request<SnapshotResponse>('/api/world', { auth: Boolean(loadToken()) }),

  leaderboard: (limit = 25) => request<LeaderboardEntry[]>(`/api/leaderboard?limit=${limit}`),

  deedLog: () => request<DeedLogEntry[]>('/api/deeds'),

  claim: (tileId: number) =>
    request<MeState>('/api/actions/claim', { method: 'POST', body: { tileId }, auth: true }),

  upgrade: (tileId: number) =>
    request<MeState>('/api/actions/upgrade', { method: 'POST', body: { tileId }, auth: true }),

  siege: (tileId: number, pressure: number) =>
    request<{ me: MeState; siege: Siege }>('/api/actions/siege', {
      method: 'POST',
      body: { tileId, pressure },
      auth: true,
    }),

  reinforce: (siegeId: string, amount: number) =>
    request<{ me: MeState; siege: Siege }>('/api/actions/reinforce', {
      method: 'POST',
      body: { siegeId, amount },
      auth: true,
    }),

  setName: (name: string) =>
    request<MeState>('/api/profile/name', { method: 'POST', body: { name }, auth: true }),

  setColour: (colorIndex: number) =>
    request<MeState>('/api/profile/colour', { method: 'POST', body: { colorIndex }, auth: true }),

  prepareDeed: (tileId: number) =>
    request<DeedQuote>('/api/deed/prepare', { method: 'POST', body: { tileId }, auth: true }),

  claimDeed: (tileId: number, txHash: string) =>
    request<{ me: MeState; deedUntil: number }>('/api/deed/claim', {
      method: 'POST',
      body: { tileId, txHash },
      auth: true,
    }),
};

/**
 * Redeems a deed, retrying while the transaction is still being mined.
 *
 * A player has already paid real NIM by this point, so giving up after one
 * attempt would be the worst possible outcome. This keeps trying with a
 * widening delay and reports progress so the wait never looks like a hang.
 */
export async function claimDeedWithRetry(
  tileId: number,
  txHash: string,
  onProgress?: (attempt: number, max: number) => void,
  maxAttempts = 10,
): Promise<{ me: MeState; deedUntil: number }> {
  let lastError: ApiError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress?.(attempt, maxAttempts);
    try {
      return await api.claimDeed(tileId, txHash);
    } catch (e) {
      if (!(e instanceof ApiError) || !e.isRetryable) throw e;
      lastError = e;
      // 2s, 3s, 4s ... capped, so ten attempts span roughly a minute.
      await new Promise((r) => setTimeout(r, Math.min(2000 + attempt * 1000, 8000)));
    }
  }

  throw (
    lastError ??
    new ApiError('tx_pending', 'Your payment has not confirmed yet. Reopen the tile in a moment to finish minting.')
  );
}
