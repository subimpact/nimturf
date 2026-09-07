#!/usr/bin/env node
/**
 * End-to-end check against a running NimTurf API.
 *
 * Exercises the real sign-in flow with genuine Ed25519 wallet signatures
 * produced by the official `@nimiq/core` client, then plays a full game:
 * claim, build, raid, defend and resolve. Run it against local dev or against
 * production after a deploy.
 *
 *   node scripts/e2e.mjs [baseUrl]
 */
import { KeyPair } from '@nimiq/core';
import { sha256 } from '@noble/hashes/sha2';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
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
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, json };
}

const enc = new TextEncoder();

/** Reproduces the digest a Nimiq wallet signs for a text message. */
function nimiqDigest(message) {
  const msg = enc.encode(message);
  const prefix = enc.encode(`\x16Nimiq Signed Message:\n${msg.length}`);
  const buf = new Uint8Array(prefix.length + msg.length);
  buf.set(prefix, 0);
  buf.set(msg, prefix.length);
  return sha256(buf);
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Signs in as a fresh wallet and returns its session. */
async function signIn(label) {
  const kp = KeyPair.generate();
  const address = kp.publicKey.toAddress().toUserFriendlyAddress();

  const challenge = await api('/api/auth/challenge', { method: 'POST' });
  if (!challenge.json?.ok) throw new Error(`challenge failed: ${JSON.stringify(challenge.json)}`);
  const { nonce, message } = challenge.json.data;

  const signature = hex(kp.sign(nimiqDigest(message)).serialize());
  const verify = await api('/api/auth/verify', {
    method: 'POST',
    body: { address, publicKey: kp.publicKey.toHex(), signature, nonce },
  });
  if (!verify.json?.ok) throw new Error(`verify failed: ${JSON.stringify(verify.json)}`);
  console.log(`  signed in ${label} as ${address.slice(0, 14)}...`);
  return { kp, address, token: verify.json.data.token, me: verify.json.data.me, message, nonce, signature };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`NimTurf end-to-end check against ${BASE}`);

  // -- health ---------------------------------------------------------------
  section('Health');
  const health = await api('/api/health');
  check('health responds ok', health.json?.ok === true, JSON.stringify(health.json));
  check('sign-in is configured', health.json?.data?.authEnabled === true);

  // -- unauthenticated access ----------------------------------------------
  section('Public access');
  const publicWorld = await api('/api/world');
  check('world is readable without signing in', publicWorld.json?.ok === true);
  check('world has 576 tiles', publicWorld.json?.data?.tiles?.length === 576);
  check('no player state when signed out', publicWorld.json?.data?.me === null);
  const board = publicWorld.json.data.tiles;
  check('every tile has terrain', board.every((t) => typeof t.terrain === 'string'));

  const noAuth = await api('/api/actions/claim', { method: 'POST', body: { tileId: 0 } });
  check('claiming without a session is rejected', noAuth.status === 401, `got ${noAuth.status}`);

  // -- authentication -------------------------------------------------------
  section('Wallet authentication');
  const alice = await signIn('alice');
  check('session issued', typeof alice.token === 'string' && alice.token.length > 20);
  check('starting balance granted', alice.me.scrap > 0);
  check('starts with no territory', alice.me.tileCount === 0);

  const replay = await api('/api/auth/verify', {
    method: 'POST',
    body: {
      address: alice.address,
      publicKey: alice.kp.publicKey.toHex(),
      signature: alice.signature,
      nonce: alice.nonce,
    },
  });
  check('a nonce cannot be reused (replay blocked)', replay.json?.ok === false, JSON.stringify(replay.json));

  const badToken = await api('/api/actions/claim', {
    method: 'POST',
    token: `${alice.token}tampered`,
    body: { tileId: 0 },
  });
  check('a tampered session token is rejected', badToken.status === 401);

  // Impersonation: sign correctly but claim someone else's address.
  const victim = KeyPair.generate();
  const ch = await api('/api/auth/challenge', { method: 'POST' });
  const impersonation = await api('/api/auth/verify', {
    method: 'POST',
    body: {
      address: victim.publicKey.toAddress().toUserFriendlyAddress(),
      publicKey: alice.kp.publicKey.toHex(),
      signature: hex(alice.kp.sign(nimiqDigest(ch.json.data.message)).serialize()),
      nonce: ch.json.data.nonce,
    },
  });
  check('impersonating another address is rejected', impersonation.json?.ok === false);

  // -- claiming -------------------------------------------------------------
  section('Claiming territory');
  // Find an unowned tile away from the edges so it has 4 neighbours.
  const freeTile = board.find((t) => !t.owner && t.x > 3 && t.x < 20 && t.y > 3 && t.y < 20);
  const firstClaim = await api('/api/actions/claim', {
    method: 'POST',
    token: alice.token,
    body: { tileId: freeTile.id },
  });
  check('first claim succeeds', firstClaim.json?.ok === true, JSON.stringify(firstClaim.json));
  check('first claim is free', firstClaim.json?.data?.scrap >= alice.me.scrap, 'balance should not drop');
  check('now holds one tile', firstClaim.json?.data?.tileCount === 1);
  check('income is now positive', firstClaim.json?.data?.yieldPerSec > 0);

  const reclaim = await api('/api/actions/claim', {
    method: 'POST',
    token: alice.token,
    body: { tileId: freeTile.id },
  });
  check('claiming an owned tile is rejected', reclaim.json?.ok === false);

  const farTile = board.find((t) => !t.owner && Math.abs(t.x - freeTile.x) + Math.abs(t.y - freeTile.y) > 6);
  const farClaim = await api('/api/actions/claim', {
    method: 'POST',
    token: alice.token,
    body: { tileId: farTile.id },
  });
  check('claiming a non-adjacent tile is rejected', farClaim.json?.ok === false, JSON.stringify(farClaim.json));

  const badTile = await api('/api/actions/claim', { method: 'POST', token: alice.token, body: { tileId: 99999 } });
  check('claiming an out-of-range tile is rejected', badTile.json?.ok === false);

  // -- idle income ----------------------------------------------------------
  section('Idle income');
  const before = await api('/api/world', { token: alice.token });
  const scrapBefore = before.json.data.me.scrap;
  await sleep(2500);
  const after = await api('/api/world', { token: alice.token });
  const scrapAfter = after.json.data.me.scrap;
  check('TURF accrues over time while idle', scrapAfter > scrapBefore, `${scrapBefore} -> ${scrapAfter}`);

  // -- building -------------------------------------------------------------
  section('Building');
  const upgrade = await api('/api/actions/upgrade', {
    method: 'POST',
    token: alice.token,
    body: { tileId: freeTile.id },
  });
  check('upgrading an owned tile succeeds', upgrade.json?.ok === true, JSON.stringify(upgrade.json));
  check('upgrading raises income', upgrade.json?.data?.yieldPerSec > firstClaim.json.data.yieldPerSec);

  const notMine = board.find((t) => t.id !== freeTile.id && !t.owner);
  const upgradeOther = await api('/api/actions/upgrade', {
    method: 'POST',
    token: alice.token,
    body: { tileId: notMine.id },
  });
  check('upgrading a tile you do not own is rejected', upgradeOther.json?.ok === false);

  // -- raiding --------------------------------------------------------------
  section('Raiding (deterministic turf war)');
  const bob = await signIn('bob');
  // Bob claims a tile next to Alice's so he can raid it.
  const world2 = await api('/api/world');
  const aliceTile = world2.json.data.tiles[freeTile.id];
  const adjacent = world2.json.data.tiles.find(
    (t) => !t.owner && Math.abs(t.x - aliceTile.x) + Math.abs(t.y - aliceTile.y) === 1,
  );
  const bobClaim = await api('/api/actions/claim', {
    method: 'POST',
    token: bob.token,
    body: { tileId: adjacent.id },
  });
  check('bob claims an adjacent tile', bobClaim.json?.ok === true, JSON.stringify(bobClaim.json));

  const tinyRaid = await api('/api/actions/siege', {
    method: 'POST',
    token: bob.token,
    body: { tileId: freeTile.id, pressure: 1 },
  });
  check('a token-effort raid is rejected', tinyRaid.json?.ok === false);

  const overspend = await api('/api/actions/siege', {
    method: 'POST',
    token: bob.token,
    body: { tileId: freeTile.id, pressure: 999_999_999 },
  });
  check('raiding with more TURF than you hold is rejected', overspend.json?.ok === false);

  const selfRaid = await api('/api/actions/siege', {
    method: 'POST',
    token: bob.token,
    body: { tileId: adjacent.id, pressure: 500 },
  });
  check('raiding your own tile is rejected', selfRaid.json?.ok === false);

  // A real raid, overwhelming enough to resolve inside the minimum window.
  const bobState = (await api('/api/world', { token: bob.token })).json.data.me;
  const raid = await api('/api/actions/siege', {
    method: 'POST',
    token: bob.token,
    body: { tileId: freeTile.id, pressure: Math.floor(bobState.scrap * 0.9) },
  });
  check('a funded raid opens', raid.json?.ok === true, JSON.stringify(raid.json));
  if (raid.json?.ok) {
    const s = raid.json.data.siege;
    check('raid escrows the pressure', raid.json.data.me.scrap < bobState.scrap);
    check('raid has a resolve time in the future', s.resolvesAt > Date.now());
    check('defender can see what they must beat', s.baseDefense > 0);

    const secondRaid = await api('/api/actions/siege', {
      method: 'POST',
      token: bob.token,
      body: { tileId: freeTile.id, pressure: 500 },
    });
    check('a tile cannot be raided twice at once', secondRaid.json?.ok === false);

    // Alice is told she is under attack.
    const aliceView = await api('/api/world', { token: alice.token });
    check('defender is notified of the raid', aliceView.json.data.events.some((e) => e.kind === 'under_siege'));
    check('the raid is visible on the world map', aliceView.json.data.sieges.some((x) => x.id === s.id));

    // Alice reinforces.
    const reinforce = await api('/api/actions/reinforce', {
      method: 'POST',
      token: alice.token,
      body: { siegeId: s.id, amount: 50 },
    });
    check('defender can reinforce', reinforce.json?.ok === true, JSON.stringify(reinforce.json));
    check('reinforcement raises the bar', reinforce.json?.data?.siege?.reinforcement === 50);

    const bobReinforce = await api('/api/actions/reinforce', {
      method: 'POST',
      token: bob.token,
      body: { siegeId: s.id, amount: 50 },
    });
    check('the attacker cannot reinforce the tile they are raiding', bobReinforce.json?.ok === false);
  }

  // -- deeds ----------------------------------------------------------------
  section('On-chain deeds');
  const prepare = await api('/api/deed/prepare', {
    method: 'POST',
    token: alice.token,
    body: { tileId: freeTile.id },
  });
  // The tile is under raid, so a deed must be refused - no buying your way out.
  check('cannot deed a tile that is under raid', prepare.json?.ok === false, JSON.stringify(prepare.json));

  const bobDeed = await api('/api/deed/prepare', {
    method: 'POST',
    token: bob.token,
    body: { tileId: adjacent.id },
  });
  check('deed prepare returns payment details', bobDeed.json?.ok === true, JSON.stringify(bobDeed.json));
  if (bobDeed.json?.ok) {
    check('deed names the treasury', typeof bobDeed.json.data.treasury === 'string');
    check('deed has a fixed NIM price', bobDeed.json.data.valueLuna > 0);
    check(
      'deed data encodes the tile for on-chain audit',
      bobDeed.json.data.data === `NIMTURF:1:S1:${adjacent.id}`,
      bobDeed.json.data.data,
    );
  }

  const fakeDeed = await api('/api/deed/claim', {
    method: 'POST',
    token: bob.token,
    body: { tileId: adjacent.id, txHash: 'a'.repeat(64) },
  });
  check(
    'a made-up transaction hash cannot mint a deed',
    fakeDeed.json?.ok === false,
    JSON.stringify(fakeDeed.json),
  );

  // -- deeds against the live Nimiq network ---------------------------------
  if (health.json?.data?.deedsEnabled) {
    section('On-chain verification (live Nimiq RPC)');

    /*
     * A real, confirmed mainnet transaction. It exists on chain, so the server
     * must find it via RPC and then reject it on its contents rather than for
     * being missing - which is what proves the whole lookup path works, not
     * just the "not found" branch.
     */
    const REAL_MAINNET_TX = 'ca94bdd76ea4077228725e6904aa90508d36ef9fe437c86192356e8c47bbec7b';

    const realTx = await api('/api/deed/claim', {
      method: 'POST',
      token: bob.token,
      body: { tileId: adjacent.id, txHash: REAL_MAINNET_TX },
    });
    check(
      'a real on-chain transaction is found and then rejected on its contents',
      realTx.json?.ok === false && ['wrong_sender', 'wrong_recipient', 'wrong_data', 'underpaid'].includes(realTx.json.error.code),
      JSON.stringify(realTx.json),
    );

    const missing = await api('/api/deed/claim', {
      method: 'POST',
      token: bob.token,
      body: { tileId: adjacent.id, txHash: '0'.repeat(64) },
    });
    check(
      'a hash that is not on chain is reported as pending, not as a failure',
      missing.json?.error?.code === 'tx_pending',
      JSON.stringify(missing.json),
    );
  } else {
    console.log('  (skipped live RPC checks: deeds are not configured on this deployment)');
  }

  // -- leaderboard ----------------------------------------------------------
  section('Leaderboard');
  const board2 = await api('/api/leaderboard');
  check('leaderboard responds', board2.json?.ok === true);
  check('leaderboard lists both players', board2.json?.data?.length >= 2, JSON.stringify(board2.json?.data?.length));
  check('leaderboard is ranked', board2.json.data.every((r, i) => r.rank === i + 1));
  check(
    'leaderboard is sorted by lifetime TURF',
    board2.json.data.every((r, i, a) => i === 0 || a[i - 1].lifetimeScrap >= r.lifetimeScrap),
  );

  // -- profile --------------------------------------------------------------
  section('Profile');
  const rename = await api('/api/profile/name', { method: 'POST', token: alice.token, body: { name: 'Kingpin' } });
  check('player can be renamed', rename.json?.data?.name === 'Kingpin', JSON.stringify(rename.json));
  const badName = await api('/api/profile/name', { method: 'POST', token: alice.token, body: { name: 'x' } });
  check('a too-short name is rejected', badName.json?.ok === false);
  const scriptName = await api('/api/profile/name', {
    method: 'POST',
    token: alice.token,
    body: { name: '<script>alert(1)</script>' },
  });
  check(
    'markup is stripped from names',
    scriptName.json?.ok === true && !scriptName.json.data.name.includes('<'),
    JSON.stringify(scriptName.json),
  );

  // -- errors ---------------------------------------------------------------
  section('Error handling');
  const notFound = await api('/api/nope');
  check('unknown endpoints return a clear 404', notFound.status === 404 && notFound.json?.ok === false);
  const malformed = await fetch(`${BASE}/api/actions/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    body: '{not json',
  });
  check('malformed JSON is handled gracefully', malformed.status === 400, `got ${malformed.status}`);

  // -- summary --------------------------------------------------------------
  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n\x1b[31mE2E run crashed:\x1b[0m', e);
  process.exit(1);
});
