#!/usr/bin/env node
/**
 * Seeds a running NimTurf world with a few players, territory and a live raid.
 *
 * Useful for reviewing the interface in a realistic state and for producing
 * submission screenshots. It signs in with genuine Ed25519 wallet signatures
 * via `@nimiq/core`, so it exercises exactly the same path a real player does
 * - there is no back door in the server for this.
 *
 * Prints the first player's session token on the last line, so a browser can
 * be dropped straight into a signed-in session.
 *
 *   node scripts/seed-demo.mjs [baseUrl]
 */
import { KeyPair } from '@nimiq/core';
import { sha256 } from '@noble/hashes/sha2';

/*
 * The two board helpers this script needs, restated locally. The shared rules
 * package is written for bundlers and cannot be imported by plain Node, and
 * pulling in a bundler just for a dev utility is not worth it. Both are
 * trivial and covered by tests in packages/shared.
 */
const WORLD_SIZE = 24;
const neighbourIds = (id) => {
  const x = id % WORLD_SIZE;
  const y = Math.floor(id / WORLD_SIZE);
  return [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ]
    .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < WORLD_SIZE && ny < WORLD_SIZE)
    .map(([nx, ny]) => ny * WORLD_SIZE + nx);
};

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const enc = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function nimiqDigest(message) {
  const msg = enc.encode(message);
  const prefix = enc.encode(`\x16Nimiq Signed Message:\n${msg.length}`);
  const buf = new Uint8Array(prefix.length + msg.length);
  buf.set(prefix, 0);
  buf.set(msg, prefix.length);
  return sha256(buf);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  return json.data;
}

/** The server stores addresses without spaces; compare like for like. */
const normalise = (address) => address.replace(/\s+/g, '').toUpperCase();

async function signIn(name) {
  const kp = KeyPair.generate();
  const address = kp.publicKey.toAddress().toUserFriendlyAddress();
  const { nonce, message } = await api('/api/auth/challenge', { method: 'POST' });
  const { token } = await api('/api/auth/verify', {
    method: 'POST',
    body: {
      address,
      publicKey: kp.publicKey.toHex(),
      signature: hex(kp.sign(nimiqDigest(message)).serialize()),
      nonce,
    },
  });
  await api('/api/profile/name', { method: 'POST', token, body: { name } });
  return { token, address: normalise(address), name };
}

/** Waits until the player can afford `cost`, within a time budget. */
async function waitForFunds(player, cost, budgetMs = 90_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const world = await api('/api/world', { token: player.token });
    if (world.me.scrap >= cost) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Claims an explicit run of tiles in order, waiting for income when short.
 * The tiles are given rather than discovered so neighbourhoods end up next to
 * each other and a raid is actually possible.
 */
async function claimRun(player, tileIds) {
  const held = [];
  for (const tileId of tileIds) {
    let claimed = null;
    for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
      claimed = await api('/api/actions/claim', {
        method: 'POST',
        token: player.token,
        body: { tileId },
      }).catch(() => null);
      if (!claimed) {
        // Almost always "not enough TURF" - wait for the meter to tick up.
        const affordable = await waitForFunds(player, 1, 20_000);
        if (!affordable) break;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (claimed) held.push(tileId);
  }
  return held;
}

async function main() {
  console.log(`Seeding a demo world at ${BASE}`);

  const kingpin = await signIn('Kingpin');
  const rival = await signIn('Vex');
  const third = await signIn('Marla');

  // Three neighbourhoods. Kingpin and Vex are adjacent so a raid is possible.
  /*
   * Two facing rows so the neighbourhoods border each other: every tile in a
   * row is adjacent to the previous one, which is what claiming requires, and
   * the rows touch, which is what raiding requires.
   */
  const row = 11;
  const mine = await claimRun(kingpin, [9, 10, 11, 12, 13].map((x) => row * WORLD_SIZE + x));
  const theirs = await claimRun(rival, [11, 12, 13, 14].map((x) => (row + 1) * WORLD_SIZE + x));
  const others = await claimRun(third, [5, 6, 7].map((x) => 5 * WORLD_SIZE + x));
  console.log(`  Kingpin holds ${mine.length}, Vex ${theirs.length}, Marla ${others.length}`);

  // Build a few blocks up so the map shows real development.
  const buildUp = async (player, tiles, times) => {
    for (const tileId of tiles) {
      for (let i = 0; i < times; i++) {
        const done = await api('/api/actions/upgrade', {
          method: 'POST',
          token: player.token,
          body: { tileId },
        }).catch(() => null);
        if (!done) {
          await new Promise((r) => setTimeout(r, 5000));
          await api('/api/actions/upgrade', {
            method: 'POST',
            token: player.token,
            body: { tileId },
          }).catch(() => null);
        }
      }
    }
  };
  await buildUp(kingpin, mine.slice(0, 3), 4);
  await buildUp(rival, theirs.slice(0, 2), 3);

  // A live raid: Vex attacks the nearest Kingpin block she borders.
  const world = await api('/api/world');
  const target = mine.find((id) => neighbourIds(id).some((n) => world.tiles[n]?.owner === rival.address));
  if (target) {
    await waitForFunds(rival, 3000, 60_000);
    const vex = await api('/api/world', { token: rival.token });
    const pressure = Math.max(1, Math.floor(vex.me.scrap * 0.6));
    const raid = await api('/api/actions/siege', {
      method: 'POST',
      token: rival.token,
      body: { tileId: target, pressure },
    }).catch((e) => {
      console.log(`  (no raid: ${e.message})`);
      return null;
    });
    if (raid) console.log(`  Vex is raiding tile ${target} with ${pressure} TURF`);
  }

  const final = await api('/api/world', { token: kingpin.token });
  console.log(`  world: ${final.tiles.filter((t) => t.owner).length} blocks held, ${final.sieges.length} live raid(s)`);
  console.log(`  Kingpin income: ${final.me.yieldPerSec}/s, balance ${final.me.scrap}`);
  console.log(kingpin.token);
}

main().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
