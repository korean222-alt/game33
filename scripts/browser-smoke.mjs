// Run after npm ci, npm install --no-save playwright, npx playwright install chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '3191' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, page;
let stage = 'startup';
const errors = [];
server.stderr.on('data', data => errors.push(String(data)));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    server.stdout.on('data', data => {
      if (String(data).includes('서버 준비됨')) { clearTimeout(timer); resolve(); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exit: ' + code)); });
  });
  browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('market-raid-settings', JSON.stringify({
    quality: 'low', _qualityPicked: true, autoScale: false, soundEnabled: true,
  })));
  stage = 'menu and briefing';
  await page.goto('http://localhost:3191');
  await page.click('#btnCreate');
  await page.waitForFunction(() => window.__mr?.input, null, { timeout: 30000 });
  await page.locator('#lobby').waitFor({ state: 'visible' });
  // Keep real rendering enabled at a smaller framebuffer on software-only CI GPUs.
  await page.evaluate(() => {
    const g = window.__mr;
    g.renderer.setPixelRatio(0.5);
    g.renderer.setSize(480, 320);
    g._smokeEvents = [];
    g.socket.onAny((name, data) => {
      if (['doorAction', 'doorState', 'matchEnd', 'playerDown', 'playerHit'].includes(name))
        g._smokeEvents.push({ name, data, time: performance.now() });
    });
    g.socket.onAnyOutgoing((name, data) => {
      if (name === 'door') g._smokeEvents.push({ name: 'request', data, time: performance.now() });
    });
  });
  await page.click('#btnReady');
  await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
  await page.click('#btnStart');
  await page.locator('#briefing').waitFor({ state: 'visible' });
  const pages = await page.evaluate(async () => (await import('/js/mission-story.js')).MISSION.pages.length);
  for (let i = 0; i < pages; i++) await page.click('#briefNext');
  await page.waitForFunction(() => window.__mr?.matchActive);
  stage = 'spawn and NPC geometry';
  const start = await page.evaluate(async () => {
    const game = window.__mr, THREE = await import('three');
    const { isIndoors } = await import('/js/map-data.js');
    const npcs = [...game.entities.npcs.values()];
    game.entities.update(0.016, game.camera);
    game.world.scene.updateMatrixWorld(true);
    return {
      outside: !isIndoors(game.player.pos.x, game.player.pos.z), z: game.player.pos.z,
      hp: game.hp, missing: game.assets.missing,
      npcs: npcs.map(avatar => {
        const bounds = new THREE.Box3().setFromObject(avatar.body, true);
        return { visible: avatar.group.visible, height: bounds.max.y - bounds.min.y,
          offset: Math.hypot(bounds.getCenter(new THREE.Vector3()).x - avatar.group.position.x,
            bounds.getCenter(new THREE.Vector3()).z - avatar.group.position.z) };
      }),
      glError: game.renderer.getContext().getError(),
    };
  });
  assert.equal(start.outside, true); assert.ok(start.z > 18); assert.equal(start.hp, 100);
  assert.deepEqual(start.missing, []); assert.ok(start.npcs.length > 0);
  for (const npc of start.npcs) {
    assert.equal(npc.visible, true); assert.ok(npc.height > 0.5 && npc.height < 2.5);
    assert.ok(npc.offset < 1);
  }
  assert.equal(start.glError, 0);

  stage = 'door input';
  // Real keyboard -> Input -> Game -> Socket.io -> server -> world state.
  await page.evaluate(() => {
    const g = window.__mr;
    // Relocate the test actor without resetting the match's input sequence.
    g.player.pos.set(0, 0.22, 19.15); g.player.vel.set(0, 0, 0); g.player.yaw = 0;
    g.socket.emit('input', g.player.netState());
  });
  await page.waitForFunction(() => window.__mr.doors.nearest(window.__mr.player.pos.x, window.__mr.player.pos.z)?.door.id === 'front');
  console.log('Door approach', await page.evaluate(() => ({ pos: window.__mr.player.pos.toArray(), enabled: window.__mr.input.enabled, alive: window.__mr.alive, pending: window.__mr._doorPending })));
  await page.keyboard.down('KeyQ');
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('문틈 확인:'));
  await page.keyboard.up('KeyQ');
  await page.waitForFunction(() => !window.__mr._doorPending && performance.now() >= window.__mr._doorBusyUntil);
  const state = await page.evaluate(() => window.__mr.doors.get('front').state);
  if (state === 'barricaded') await page.keyboard.press('KeyB');
  else {
    await page.keyboard.press('KeyE');
    if (state === 'locked') {
      await page.waitForFunction(() => window.__mr.doors.get('front').state === 'closed', null, { timeout: 8000 });
      await page.waitForFunction(() => !window.__mr._doorPending && performance.now() >= window.__mr._doorBusyUntil);
      await page.keyboard.press('KeyE');
    }
  }
  await page.waitForFunction(() => ['open', 'destroyed'].includes(window.__mr.doors.get('front').state));
  const door = await page.evaluate(() => {
    const g = window.__mr;
    return { blocking: g.doors.colliders().some(c => c.id === 'front'),
      visible: g.world.doorMeshes.get('front').pivot.visible, state: g.doors.get('front').state };
  });
  assert.equal(door.blocking, false);
  if (door.state === 'destroyed') assert.equal(door.visible, false);

  await page.evaluate(() => {
    const g = window.__mr;
    // Shoot upward outside the estate so this check does not injure a civilian.
    g.player.pos.set(-2.2, 0, 30.4); g.player.vel.set(0, 0, 0); g.player.yaw = 0; g.player.pitch = 1.1; g.player._applyCamera(.1);
    g._tryShoot(performance.now());
  });
  stage = 'shot and reload';
  await page.keyboard.press('KeyR');
  await page.waitForFunction(() => window.__mr.audio.reloadSources.size > 0);
  await page.waitForFunction(() => !window.__mr.reloading && window.__mr.ammo === window.__mr.weapons.rifle.mag, null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.__mr.audio.context.state), 'running');
  await page.evaluate(() => {
    const g = window.__mr;
    g._onMatchStart({ bots: [{}], players: [{ id: g.myId, x: 0, z: 15 }] });
  });
  assert.equal(await page.evaluate(() => window.__mr.matchActive), false);
  assert.ok(await page.locator('#menuErr').textContent());
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: exterior spawn, animated NPC bounds, Q/E/B doors, shot/reload audio, incompatible server rejection.');
} catch (error) {
  console.error('Stage:', stage, 'browser errors:', errors);
  if (page && !page.isClosed()) console.error('Game state:', await page.evaluate(() => {
    const g = window.__mr;
    return g && { position: g.player?.pos.toArray(), active: g.matchActive, alive: g.alive,
      inputEnabled: g.input?.enabled, peek: g.input?.peek, door: g.doors?.get('front')?.state,
      pending: g._doorPending, busyUntil: g._doorBusyUntil, now: performance.now(),
      banner: document.getElementById('banner')?.textContent, events: g._smokeEvents };
  }).catch(() => null));
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
