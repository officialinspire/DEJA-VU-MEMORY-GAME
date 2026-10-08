import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromium, startServer } from './browser-harness.mjs';
import { observe, verify } from './analytics-browser-helpers.mjs';

const server = await startServer();
const browser = await chromium.launch({ executablePath: resolveChromium(chromium) });
try {
  for (const failure of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await observe(context, failure);
    await context.addInitScript(() => localStorage.setItem('inspireDejaVu:v1:settings', JSON.stringify({ music: true, musicVolume: .22, sfx: true, sfxVolume: .35, haptics: true, reducedMotion: true })));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    await page.goto(server.baseUrl);
    await page.locator('#screen-start').click();
    await page.waitForFunction(() => ['#btn-skip-intro', '#btn-new-game']
      .some(selector => document.querySelector(selector)?.getClientRects().length));
    if (!await page.locator('#btn-new-game').isVisible()) {
      await page.locator('#btn-skip-intro').click({ timeout: 5000 }).catch(async error => {
        if (!await page.locator('#btn-new-game').isVisible()) throw error;
      });
    }
    await page.locator('#btn-new-game').click();
    await page.locator('[data-difficulty="easy"]').click();
    await page.waitForFunction(() => !document.querySelector('#card-grid').classList.contains('is-previewing'));
    const groups = await page.evaluate(() => {
      const pairs = new Map();
      document.querySelectorAll('.memory-card').forEach((card, index) => {
        const key = card.querySelector('.card-side-front').getAttribute('style');
        if (!pairs.has(key)) pairs.set(key, []);
        pairs.get(key).push(index);
      });
      return [...pairs.values()];
    });
    await page.keyboard.press('Escape');
    await page.locator('#btn-resume').click();
    for (const pair of groups) {
      for (const index of pair) {
        await page.locator(`.memory-card[data-index="${index}"]`).click();
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(60);
    }
    await page.waitForFunction(() => document.querySelector('#complete-dialog').open);
    assert.equal(await page.evaluate(() => localStorage.getItem('inspireDejaVu:v1:activeGame')), null);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('inspireDejaVu:v1:statistics')).won), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await verify(page, 'DEJA-VU-MEMORY-GAME', true, !failure);
    assert.deepEqual(errors, []);
    console.log(`PASS DEJA VU gameplay/save/mobile with analytics ${failure ? 'rejected' : 'available'}`);
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
