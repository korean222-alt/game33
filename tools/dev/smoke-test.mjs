/* =============================================================================
 *  tools/dev/smoke-test.mjs  -  헤드리스 브라우저로 게임을 실제로 한 판 돌려본다
 *
 *  확인하는 것
 *    1) 페이지가 콘솔 에러 없이 뜨는가
 *    2) GLB 12개가 placeholder 없이 전부 로드되는가
 *    3) 방 만들기 -> 작전 개시 -> HUD 표시까지 되는가
 *    4) 몇 초 돌리는 동안 예외가 안 터지는가 (봇 AI / 스냅샷 / 이펙트)
 *    5) 실제 화면 스크린샷
 *
 *  실행:  node server.js  를 먼저 띄우고  ->  node tools/dev/smoke-test.mjs
 * ========================================================================== */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'preview-out');
const URL_BASE = process.env.GAME_URL || 'http://localhost:3000';

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});

// 아이폰 13 Pro 가로 해상도. 단, 헤드리스는 소프트웨어 렌더링(swiftshader)이라
// deviceScaleFactor 는 1 로 둔다 (2 로 두면 1~2 FPS 까지 떨어져서
// "클라는 슬로우모션인데 서버 봇은 제 속도" 인 이상한 상황이 된다).
const page = await browser.newPage({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 1,
});

const errors = [];
const warnings = [];
page.on('console', (m) => {
  const txt = m.text();
  if (m.type() === 'error') errors.push(txt);
  else if (m.type() === 'warning') warnings.push(txt);
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '')));

const step = (s) => console.log(`\n  ▸ ${s}`);
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`    ${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

/* ---------------------------------------------------------------------- */
step('페이지 열기');
await page.goto(URL_BASE, { waitUntil: 'load', timeout: 30000 });

step('부팅 대기 (에셋 로딩 + 서버 연결)');
await page.waitForFunction(
  () => window.game && window.game.state === 'menu',
  { timeout: 60000 }
).catch(async () => {
  const msg = await page.textContent('#bootMsg').catch(() => '?');
  throw new Error(`부팅이 안 끝났습니다. 마지막 메시지: ${msg}`);
});

const bootInfo = await page.evaluate(() => ({
  missing: window.game.assets.missing,
  loaded: window.game.assets.cache.size,
  quality: window.game.settings.quality,
  colliders: window.game.world ? window.game.world.pointLights.length : -1,
  connected: window.game.net.connected,
}));
check(bootInfo.loaded >= 12, 'GLB 로드', `${bootInfo.loaded}개`);
check(bootInfo.missing.length === 0, 'placeholder 대체 없음',
      bootInfo.missing.length ? `대체됨: ${bootInfo.missing.join(', ')}` : '');
check(bootInfo.connected, '서버 연결');
await page.screenshot({ path: path.join(OUT, 'shot-1-menu.png') });

// 헤드리스에서도 실시간에 가깝게 돌도록 화질을 낮춘다
await page.evaluate(() => {
  window.game.settings.autoScale = false;
  window.game._applyQuality('low');
});

/* ---------------------------------------------------------------------- */
step('방 만들기');
await page.fill('#nick', '테스트대원');
await page.click('#btnCreate');
await page.waitForFunction(() => window.game.state === 'lobby', { timeout: 10000 });
const code = await page.textContent('#roomCode');
check(/^[A-Z0-9]{5}$/.test(code.trim()), '방 코드 발급', code.trim());
await page.screenshot({ path: path.join(OUT, 'shot-2-lobby.png') });

/* ---------------------------------------------------------------------- */
step('작전 개시 (적 2명 / 쉬움 - 검사 도중에 죽지 않게)');
await page.evaluate(() => window.game.net.setRoomConfig({ botCount: 2, difficulty: 'easy' }));
await page.waitForTimeout(300);
await page.click('#btnStart');
await page.waitForFunction(() => window.game.state === 'playing', { timeout: 15000 });
check(true, '매치 시작');

// 스냅샷이 실제로 도착하는지
await page.waitForFunction(() => window.game.lastSnapshot !== null, { timeout: 10000 });
const snap = await page.evaluate(() => ({
  bots: window.game.lastSnapshot.bots.length,
  players: window.game.lastSnapshot.players.length,
  entityBots: window.game.entities.bots.size,
  hasRig: [...window.game.entities.bots.values()][0]?.hasRig ?? null,
}));
check(snap.bots > 0, '봇 스폰', `${snap.bots}명`);
check(snap.entityBots === snap.bots, '봇 3D 생성', `${snap.entityBots}개`);
check(snap.hasRig === true, '캐릭터 뼈대 인식 (절차적 애니메이션 가능)');

/* ---------------------------------------------------------------------- */
/*  ※ 순서 주의: 전투는 맨 마지막에 한다.                                    */
/*    먼저 쏴버리면 봇이 전부 몰려와서 검사 도중에 죽고,                      */
/*    죽은 뒤에는 조준/앉기/해체가 당연히 안 되어 엉뚱한 실패가 난다.         */

step('적 캐릭터 렌더 확인 (뼈대 애니메이션)');
const botView = await page.evaluate(() => {
  const g = window.game;
  const bot = [...g.entities.bots.values()].find((b) => b.alive);
  if (!bot) return null;
  // 봇은 어두운 창고 구석에 있을 수 있어서 사진으로 확인이 안 된다.
  // 조명이 확실한 매대 사이 통로(서쪽 1.58m 통로)로 옮겨서 찍는다.
  g.player.pos.set(-2.33, 0, 2.4);
  g.player.yaw = 0;
  g.player.pitch = -0.02;
  g.controls.move.x = 0; g.controls.move.y = 0;
  const info = {
    bones: Object.keys(bot.bones).length,
    weapon: !!bot.weapon,
    label: !!bot.label,
    parts: (() => { let n = 0; bot.model.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
  };

  // 실제 봇은 매대 뒤에 숨어 있을 수 있으므로, 눈으로 확인할 용도로
  // 캐릭터 하나를 카메라 바로 앞에 세워서 걷는 자세를 찍는다.
  const ch = new (bot.constructor)(g.assets, { enemy: true, name: '시험용', weapon: 'rifle' });
  ch.setTransform(-2.33, -0.55, Math.PI);   // 카메라 정면 3m, 이쪽을 보게
  ch.moving = true; ch.sprint = false; ch.crouch = false; ch.pitch = 0;
  g.scene.add(ch.group);
  window.__demoChar = ch;
  return info;
});
check(botView !== null, '살아있는 적 존재');
check((botView?.bones ?? 0) >= 14, '뼈 15개 인식', `${botView?.bones}개`);
check(botView?.weapon === true, '적이 총을 들고 있음');
check((botView?.parts ?? 0) >= 15, '몸통 파츠 로드', `${botView?.parts}개 메시`);
// 걷는 동작이 눈에 보이게 여러 프레임 돌린 뒤 촬영
await page.waitForTimeout(1500);
const walked = await page.evaluate(() => {
  const ch = window.__demoChar;
  return { phase: +ch.walkPhase.toFixed(2), legRotX: +ch.bones.legL.rotation.x.toFixed(3) };
});
check(walked.phase > 0.1, '걷기 애니메이션 동작', `위상 ${walked.phase}, 다리각 ${walked.legRotX}`);
await page.screenshot({ path: path.join(OUT, 'shot-6-enemy.png') });
await page.evaluate(() => { window.__demoChar.dispose(); window.__demoChar = null; });

step('짧게 사격해서 탄약 소모');
await page.evaluate(() => { window.game.controls.fire = true; });
await page.waitForTimeout(900);
await page.evaluate(() => { window.game.controls.fire = false; });
await page.waitForTimeout(400);
const shot = await page.evaluate(() => ({
  ammo: window.game.player.ammo,
  mag: window.game.weapons[window.game.myWeapon].mag,
}));
check(shot.ammo < shot.mag, '사격으로 탄약 소모', `${shot.mag} -> ${shot.ammo}`);

step('정조준 + 앉기');
await page.evaluate(() => {
  const c = window.game.controls;
  c.ads = true;
  c.crouch = true;
});
// ★ 고정 시간 대기는 쓰면 안 된다.
//   헤드리스(swiftshader)는 1~2 FPS 라서 700ms 동안 프레임이 한 번밖에 안 돈다.
//   "전환이 끝날 때까지" 를 조건으로 기다려야 진짜 기능을 검사하는 것이다.
await page.waitForFunction(
  () => window.game.player.adsAmount > 0.95 && window.game.player.crouch > 0.95,
  { timeout: 20000 }
).catch(() => {});
const stance = await page.evaluate(() => ({
  ads: window.game.player.adsAmount,
  crouch: window.game.player.crouch,
  fov: window.game.camera.fov,
  eye: window.game.player.eyeHeight,
}));
check(stance.ads > 0.95, '정조준 전환', `fov ${stance.fov.toFixed(1)}`);
check(stance.crouch > 0.95, '앉기 전환', `눈높이 ${stance.eye.toFixed(2)}m`);
await page.screenshot({ path: path.join(OUT, 'shot-3-ads.png') });

step('재장전');
await page.evaluate(() => {
  const c = window.game.controls;
  c.ads = false; c.crouch = false;
  window.game.player.reload();
});
await page.waitForTimeout(200);
await page.waitForFunction(
  (before) => window.game.player.ammo > before,
  shot.ammo, { timeout: 20000 }
).catch(() => {});
const reloaded = await page.evaluate(() => window.game.player.ammo);
check(reloaded > shot.ammo, '재장전 완료', `${shot.ammo} -> ${reloaded}`);

step('폭발물 해체');
const aliveNow = await page.evaluate(() => window.game.player.alive);
if (!aliveNow) {
  console.log('    ⚠ 검사 도중 봇에게 사살됨 - 해체 검사를 위해 서버에 재시작 요청');
  await page.evaluate(() => window.game.net.startMatch());
  await page.waitForTimeout(1200);
}
await page.evaluate(() => {
  const g = window.game;
  const s = [...g.world.siteMarkers.entries()][0][1].group.position;
  g.player.pos.x = s.x + 0.5;
  g.player.pos.z = s.z + 0.5;
  g.controls.use = true;
});
await page.waitForFunction(
  () => (window.game.siteProgress.values().next().value ?? 0) > 0.2,
  { timeout: 25000 }
).catch(() => {});
const defuse = await page.evaluate(() => ({
  target: window.game.player.defuseTarget?.id ?? null,
  progress: [...window.game.siteProgress.entries()],
}));
check(defuse.target !== null, '해체 지점 인식', `지점 ${defuse.target}`);
check(defuse.progress.length > 0 && defuse.progress[0][1] > 0.1,
      '해체 진행됨', `진행도 ${(defuse.progress[0]?.[1] ?? 0).toFixed(2)}`);
await page.screenshot({ path: path.join(OUT, 'shot-4-defuse.png') });

step('이동 + 교전 (5초)');
await page.evaluate(() => {
  const c = window.game.controls;
  c.use = false;
  c.move.y = 1;
  c.fire = true;
  window.__testDriver = setInterval(() => {
    c.look.dx += 0.02;
    c.move.x = Math.sin(Date.now() / 700) * 0.6;
  }, 50);
});
await page.waitForTimeout(5000);
await page.screenshot({ path: path.join(OUT, 'shot-5-combat.png') });

const play = await page.evaluate(() => {
  clearInterval(window.__testDriver);
  const g = window.game;
  return {
    pos: [+g.player.pos.x.toFixed(2), +g.player.pos.z.toFixed(2)],
    hp: g.player.hp,
    alive: g.player.alive,
    inBounds: Math.abs(g.player.pos.x) < 7.6 && Math.abs(g.player.pos.z) < 5.6,
    botsAlive: [...g.entities.bots.values()].filter((b) => b.alive).length,
  };
});
check(play.inBounds, '플레이어가 벽을 안 뚫음', `(${play.pos.join(', ')})`);
console.log(`      체력 ${play.hp} / ${play.alive ? '생존' : '전사'} / 적 ${play.botsAlive}명 남음`);

/* ---------------------------------------------------------------------- */
step('결과');
const realErrors = errors.filter((e) =>
  !e.includes('favicon') && !e.includes('Failed to load resource: the server responded with a status of 404'));
check(realErrors.length === 0, '콘솔 에러 없음',
      realErrors.length ? `\n      ${realErrors.slice(0, 6).join('\n      ')}` : '');

if (warnings.length) {
  console.log(`\n  경고 ${warnings.length}건:`);
  for (const w of [...new Set(warnings)].slice(0, 8)) console.log('    - ' + w.slice(0, 160));
}

await browser.close();
console.log(`\n  스크린샷 -> ${path.relative(process.cwd(), OUT)}/`);
console.log(failed ? `\n  ✘ 실패 ${failed}건\n` : '\n  ✔ 전부 통과\n');
process.exit(failed ? 1 : 0);
