// Run after npm ci, npm install --no-save playwright, npx playwright install chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

/* 설치된 Playwright 버전과 미리 받아 둔 Chromium 버전이 어긋나면 실행 파일을
 * 못 찾는다. CHROMIUM_PATH 로 직접 지정할 수 있게 열어 둔다. */
const launchOptions = (args) => ({
  args,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

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
  browser = await chromium.launch(launchOptions(['--no-sandbox', '--enable-unsafe-swiftshader']));
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
  /* hp 를 100 으로 못 박아 두었더니 대여섯 번에 한 번씩 88 로 떨어져 실패했다.
   * 이 시점까지 몇 초가 흐르고, 마당에 선 용의자 배치는 매 판 무작위라 가끔
   * 시작하자마자 발각돼 맞는다 — 게임이 의도한 동작이지 회귀가 아니다.
   * 여기서 보려는 것은 "살아서 정상 범위의 체력으로 들어왔는가" 다. */
  assert.equal(start.outside, true); assert.ok(start.z > 18);
  assert.ok(start.hp > 0 && start.hp <= 100, `spawn hp out of range: ${start.hp}`);
  assert.deepEqual(start.missing, []); assert.ok(start.npcs.length > 0);
  for (const npc of start.npcs) {
    assert.equal(npc.visible, true); assert.ok(npc.height > 0.5 && npc.height < 2.5);
    assert.ok(npc.offset < 1);
  }
  assert.equal(start.glError, 0);

  stage = 'ceiling separation and weapon grip';
  const render = await page.evaluate(async () => {
    const game = window.__mr, THREE = await import('three');
    const { MAP } = await import('/js/map-data.js');
    game.world.scene.updateMatrixWorld(true);

    // 천장과 같은 높이로 끝나는 면이 있으면 카메라가 움직일 때마다 깨져 보인다.
    let coplanar = 0, ceilings = 0;
    for (const object of game.world.scene.children) {
      if (!object.isMesh || !object.geometry?.attributes?.position) continue;
      const box = new THREE.Box3().setFromObject(object);
      if (Math.abs(box.max.y - box.min.y) < 0.01 && Math.abs(box.max.y - MAP.height) < 0.001) {
        ceilings++;               // 천장면 자체
        continue;
      }
      if (Math.abs(box.max.y - MAP.height) < 0.002) coplanar++;
    }

    // 총을 든 자세: 손에 붙어 있고, 총 윗면이 위를 향해야 한다.
    const guns = [];
    for (const avatar of game.entities.npcs.values()) {
      if (!avatar.weapon) continue;
      avatar.group.updateMatrixWorld(true);
      const hand = avatar.rig.bones.rightHand;
      const gun = avatar.weapon.getWorldPosition(new THREE.Vector3());
      const up = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(avatar.weapon.getWorldQuaternion(new THREE.Quaternion()));
      guns.push({
        toHand: hand ? gun.distanceTo(hand.getWorldPosition(new THREE.Vector3())) : null,
        up: up.y, y: gun.y, gear: avatar.gear.length,
      });
    }
    return { coplanar, ceilings, guns };
  });
  assert.equal(render.ceilings > 0, true, '천장이 있어야 한다');
  assert.equal(render.coplanar, 0, `천장과 같은 높이로 끝나는 면 ${render.coplanar}개 (깜빡임의 원인)`);
  assert.ok(render.guns.length > 0, '무장한 NPC 가 있어야 한다');
  for (const gun of render.guns) {
    assert.ok(gun.toHand === null || gun.toHand < 0.45, `총이 손에서 떨어졌다: ${gun.toHand}`);
    assert.ok(gun.up > 0.5, `총이 눕거나 뒤집혔다: ${gun.up}`);
    assert.ok(gun.y > 0.7, `총이 발밑에 있다: ${gun.y}`);
    assert.ok(gun.gear >= 5, `장구류가 안 붙었다: ${gun.gear}`);
  }

  stage = 'door input';
  // Real keyboard -> Input -> Game -> Socket.io -> server -> world state.
  await page.evaluate(async () => {
    const g = window.__mr;
    // Relocate the test actor without resetting the match's input sequence.
    // Pick the door that is furthest from every living suspect: unlocking takes
    // 4.2s, and a guard with a line to that doorway will kill the actor part way
    // through. The check is about the door mechanism, not about winning a
    // firefight, so it must not depend on where the mission randomly put people.
    const { groundHeight } = await import('/js/map-data.js');
    const threats = [...g.entities.npcs.values()]
      .filter(a => a.kind !== 'civilian' && !a.confirmedDead && a.latestHp > 0)
      .map(a => a.group.position);
    const clearance = (x, z) => threats.reduce(
      (worst, t) => Math.min(worst, Math.hypot(t.x - x, t.z - z)), Infinity);

    let best = null;
    for (const door of g.doors.doors) {
      if (!g.doors.available(door).length) continue;
      for (const side of [-1, 1]) {
        const x = door.axis === 'x' ? door.x + side * 1.2 : door.x;
        const z = door.axis === 'x' ? door.z : door.z + side * 1.2;
        const score = clearance(x, z);
        if (!best || score > best.score) best = { id: door.id, x, z, score };
      }
    }
    g.player.pos.set(best.x, groundHeight(best.x, best.z, .32, g.doors.colliders()), best.z);
    g.player.vel.set(0, 0, 0); g.player.yaw = 0;
    g.socket.emit('input', g.player.netState());
    return best;
  });
  const target = await page.evaluate(() => {
    const g = window.__mr;
    return g.doors.nearest(g.player.pos.x, g.player.pos.z)?.door.id;
  });
  assert.ok(target, 'the actor is not within reach of any door');
  console.log('Door approach', await page.evaluate((id) => ({
    door: id, state: window.__mr.doors.get(id).state,
    pos: window.__mr.player.pos.toArray(), enabled: window.__mr.input.enabled,
    alive: window.__mr.alive, pending: window.__mr._doorPending,
  }), target));

  // Every wait below also fails fast if the actor is killed, instead of sitting
  // out a 30s timeout and reporting the wrong thing.
  const alive = () => page.evaluate(() => window.__mr.alive && window.__mr.matchActive);
  const untilDoor = async (predicate, arg, timeout = 15000) => {
    try {
      await page.waitForFunction(predicate, arg, { timeout });
    } catch (error) {
      if (!await alive()) throw new Error('the test actor was killed during the door check');
      throw error;
    }
  };

  // 문틈으로 보기: 열쇠구멍 시점이 켜지고, 문짝이 잠깐 감춰지고, 인기척이 보고된다.
  await page.keyboard.down('KeyQ');
  await untilDoor(() => !!window.__mr.peek && document.getElementById('peek').classList.contains('on'));
  await untilDoor(() => document.getElementById('killfeed').textContent.includes('인기척:'));
  const peeking = await page.evaluate((id) => ({
    leaf: window.__mr.world.doorMeshes.get(id).pivot.visible,
    frozen: window.__mr.player.frozen,
    fov: Math.round(window.__mr.camera.fov),
  }), target);
  assert.equal(peeking.leaf, false, '문틈으로 볼 때는 문짝이 눈앞을 가리면 안 된다');
  assert.equal(peeking.frozen, true, '문틈을 보는 동안에는 움직일 수 없어야 한다');
  assert.ok(peeking.fov < 40, `문틈 시야가 좁아지지 않았다: ${peeking.fov}`);
  await page.keyboard.up('KeyQ');
  await untilDoor(() => !window.__mr.peek && !window.__mr.player.frozen);
  assert.equal(await page.evaluate((id) => window.__mr.world.doorMeshes.get(id).pivot.visible, target),
    true, '문틈에서 눈을 떼면 문짝이 돌아와야 한다');
  await untilDoor(() => !window.__mr._doorPending && performance.now() >= window.__mr._doorBusyUntil);
  const state = await page.evaluate((id) => window.__mr.doors.get(id).state, target);
  if (state === 'barricaded') await page.keyboard.press('KeyB');
  else {
    await page.keyboard.press('KeyE');
    if (state === 'locked') {
      await untilDoor((id) => window.__mr.doors.get(id).state === 'closed', target, 10000);
      await untilDoor(() => !window.__mr._doorPending && performance.now() >= window.__mr._doorBusyUntil);
      await page.keyboard.press('KeyE');
    }
  }
  await untilDoor((id) => ['open', 'destroyed'].includes(window.__mr.doors.get(id).state), target);
  const door = await page.evaluate((id) => {
    const g = window.__mr;
    return { blocking: g.doors.colliders().some(c => c.id === id),
      visible: g.world.doorMeshes.get(id).pivot.visible, state: g.doors.get(id).state };
  }, target);
  assert.equal(door.blocking, false);
  if (door.state === 'destroyed') assert.equal(door.visible, false);

  await page.evaluate(() => {
    const g = window.__mr;
    // Shoot upward outside the estate so this check does not injure a civilian.
    g.player.pos.set(-2.2, 0, 30.4); g.player.vel.set(0, 0, 0); g.player.yaw = 0; g.player.pitch = 1.1; g.player._applyCamera(.1);
    g._tryShoot(performance.now());
  });
  /* 소리가 "실제로 들릴 만큼" 나오는가.
   * 헤드리스에는 스피커가 없어 실시간 분석기는 0 만 돌려준다. 오프라인
   * 렌더링은 장치와 무관하게 같은 계산을 하므로 파형 크기를 바로 잴 수 있다.
   * 예전에 비명이 0.046(-26dBFS)까지 작아져 "소리가 안 난다" 는 신고를 받았다. */
  stage = 'audible output';
  const levels = await page.evaluate(async () => {
    const { GameAudio } = await import('/js/audio.js');
    const peak = async (play, seconds = 1.2) => {
      const offline = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
      Object.defineProperty(offline, 'state', { get: () => 'running' });
      const audio = new GameAudio({ contextFactory: () => offline });
      await audio.unlock();
      play(audio);
      const data = (await offline.startRendering()).getChannelData(0);
      let top = 0;
      for (const v of data) top = Math.max(top, Math.abs(v));
      return +top.toFixed(3);
    };
    return {
      shot: await peak((a) => a.shot('rifle')),
      reload: await peak((a) => a.reload(2), 2.4),
      scream: await peak((a) => a.scream(null, 'scream')),
      cuff: await peak((a) => a.cuff()),
      door: await peak((a) => a.door({ x: 0, z: 0 }, 'open')),
      silence: await peak(() => {}),
    };
  });
  console.log('Audio peaks', levels);
  assert.equal(levels.silence, 0, '아무것도 안 울렸는데 소리가 난다');
  for (const [name, floor] of [['shot', 0.45], ['reload', 0.2], ['scream', 0.2], ['cuff', 0.2], ['door', 0.15]]) {
    assert.ok(levels[name] >= floor,
      `${name} 소리가 너무 작다: ${levels[name]} (최소 ${floor})`);
  }
  assert.ok(levels.shot > levels.reload, '총성이 가장 커야 한다');

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
  console.log('Browser smoke passed: exterior spawn, animated NPC bounds, keyhole peek, Q/E/B doors, audible output levels, shot/reload audio, incompatible server rejection.');
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
