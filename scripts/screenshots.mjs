#!/usr/bin/env node
/**
 * Drives the running game in a real browser and writes screenshots.
 *
 * Used both to sanity-check the UI during development and to produce the
 * images for the README and the competition submission. Requires the web and
 * API dev servers to be running, plus a local Chrome.
 *
 *   node scripts/screenshots.mjs [url] [outDir]
 */
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = process.argv[3] ?? 'docs/screenshots';
/** Optional session token, from scripts/seed-demo.mjs, to capture a signed-in game. */
const TOKEN = process.argv[4] ?? process.env.NIMTURF_TOKEN ?? null;
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
// A phone-sized viewport: Nimiq Pay is where this game actually lives.
await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const clickByText = (pattern) =>
  page.evaluate((source) => {
    const re = new RegExp(source, 'i');
    const btn = [...document.querySelectorAll('button')].find((b) => re.test(b.textContent || ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, pattern);

if (TOKEN) {
  // Seed the session before any script runs, so the first paint is signed in.
  await page.evaluateOnNewDocument((token) => {
    localStorage.setItem('nimturf.session', token);
    localStorage.setItem('nimturf.seenHelp', '1');
  }, TOKEN);
}

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
await wait(2500);

let dismissed = false;
if (!TOKEN) {
  await page.screenshot({ path: `${OUT}/1-how-to-play.png` });
  dismissed = await clickByText('take a block');
  await wait(1200);
}

await page.screenshot({ path: `${OUT}/2-world-map.png` });

// Tap the middle of the map to open the tile inspector.
const canvas = await page.$('canvas');
if (canvas) {
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await wait(900);
  await page.screenshot({ path: `${OUT}/3-tile-inspector.png` });
}

await page.evaluate(() => document.querySelector('button[aria-label="Close"]')?.click());
await wait(600);
await page.evaluate(() => document.querySelector('button[aria-label="Leaderboard"]')?.click());
await wait(1600);
await page.screenshot({ path: `${OUT}/4-standings.png` });

console.log(`screenshots written to ${OUT}`);
console.log('dismissed how-to-play:', dismissed);
console.log('browser problems:', problems.length ? `\n - ${problems.join('\n - ')}` : 'none');

await browser.close();
process.exit(problems.length > 0 ? 1 : 0);
