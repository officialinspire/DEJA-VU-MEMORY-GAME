import assert from 'node:assert/strict';

export async function observe(context, failure = false) {
  // Replace only the analytics transport, retaining normal asset/audio/SW requests.
  await context.addInitScript(({ failure }) => {
    const original = window.fetch.bind(window);
    window.__analytics = [];
    window.fetch = (url, options) => {
      if (String(url) !== 'https://us.i.posthog.com/i/v0/e/') return original(url, options);
      window.__analytics.push(JSON.parse(options.body));
      return failure ? Promise.reject(new TypeError('QA network rejection')) : Promise.resolve(new Response('{}', { status: 200 }));
    };
  }, { failure });
}

export async function verify(page, game, achievementExpected, live = true) {
  await page.waitForTimeout(100);
  const captures = await page.evaluate(() => window.__analytics);
  const count = name => captures.filter(e => e.event === name).length;
  assert.equal(count('game_opened'), 1);
  assert.equal(count('game_started'), 1, 'pause/resume must not start another game');
  assert.equal(count('game_completed'), 1);
  assert.equal(count('high_score_achieved'), 1);
  assert.deepEqual(captures.filter(e => e.event === 'game_progress').map(e => e.properties.progress_percent), [25, 50, 75]);
  assert.equal(count('achievement_unlocked') > 0, achievementExpected);
  const completed = captures.find(e => e.event === 'game_completed');
  assert.ok(completed.properties.score > 0);
  assert.equal(completed.properties.high_score, completed.properties.score);
  assert.ok(completed.properties.duration_seconds >= 0);
  assert.ok(captures.every(e => e.properties.game === game && e.properties.brand === 'inspire' && e.properties.$process_person_profile === false && e.properties.$session_id === e.distinct_id));
  const all = JSON.stringify(captures);
  assert.ok(!all.includes('solution') && !all.includes('puzzle') && !all.includes('Private QA'));
  // Synthetic categorized error, without actually throwing or changing game handling.
  await page.evaluate(() => {
    const event = new ErrorEvent('error', { error: new TypeError('Private QA message'), filename: 'https://private.invalid/' });
    window.dispatchEvent(event); window.dispatchEvent(event);
  });
  await page.waitForTimeout(50);
  const withError = await page.evaluate(() => window.__analytics);
  assert.equal(withError.filter(e => e.event === 'error_encountered').length, 1);
  assert.ok(!JSON.stringify(withError).includes('Private QA') && !JSON.stringify(withError).includes('private.invalid'));
  if (live && process.env.INSPIRE_VERIFY_POSTHOG === '1') {
    // Opt-in only: forward one browser-generated game session, never routine CI traffic.
    for (const payload of withError) {
      const response = await fetch('https://us.i.posthog.com/i/v0/e/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      assert.ok(response.ok, `capture returned ${response.status}`);
    }
    console.log(`POSTHOG_QA ${JSON.stringify({ game, session: withError[0].distinct_id, events: withError.map(e => e.event) })}`);
  }
  if (live) console.log(`ANALYTICS_QA_CAPTURE ${JSON.stringify(withError.map(({ api_key, ...payload }) => payload))}`);
  console.log(`PASS ${game}: anonymous properties, events, milestones, score, dedupe, sanitized error`);
}
