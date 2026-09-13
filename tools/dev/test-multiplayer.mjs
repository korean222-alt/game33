/* =============================================================================
 *  tools/dev/test-multiplayer.mjs  -  방 코드 협동 플레이를 실제로 검증한다
 *
 *  브라우저 탭 2개를 띄워서
 *    A: 방 만들기 -> 코드 발급
 *    B: 그 코드로 입장
 *    둘 다 로비에서 서로를 본다 -> A 가 작전 개시
 *    A 가 움직이면 B 화면에서 A 의 캐릭터가 실제로 따라 움직이는가
 *    B 가 A 를 보는 장면을 스크린샷으로 남긴다
 *
 *  실행:  node server.js  띄우고  ->  node tools/dev/test-multiplayer.mjs
 * ========================================================================== */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'preview-out');
const URL_BASE = process.env.GAME_URL || 'http://localhost:3000';

await fs.mkdir(OUT, { recursive: true });

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`    ${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};
const step = (s) => console.log(`\n  ▸ ${s}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});

const errors = [];
async function openClient(nick) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${nick}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${nick}] ${m.text()}`); });
  await page.goto(URL_BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.game?.state === 'menu', { timeout: 60000 });
  await page.evaluate(() => {
    window.game.settings.autoScale = false;
    window.game._applyQuality('low');      // 헤드리스에서 실시간에 가깝게
  });
  await page.fill('#nick', nick);
  return page;
}

step('클라이언트 2개 띄우기');
const [A, B] = await Promise.all([openClient('알파'), openClient('브라보')]);
check(true, '두 탭 모두 부팅 완료');

/* ---------------------------------------------------------------------- */
step('A 가 방 만들기');
await A.click('#btnCreate');
await A.waitForFunction(() => window.game.state === 'lobby', { timeout: 10000 });
const code = (await A.textContent('#roomCode')).trim();
check(/^[A-Z0-9]{5}$/.test(code), '방 코드 발급', code);

step('B 가 코드로 입장');
await B.fill('#joinCode', code);
await B.click('#btnJoin');
await B.waitForFunction(() => window.game.state === 'lobby', { timeout: 10000 });
check(true, 'B 입장 성공');

// 두 탭 모두 로비에 2명이 보이는가
await A.waitForFunction(() => window.game.lobby?.players.length === 2, { timeout: 8000 }).catch(() => {});
const seen = {
  a: await A.evaluate(() => window.game.lobby.players.map((p) => p.name)),
  b: await B.evaluate(() => window.game.lobby.players.map((p) => p.name)),
};
check(seen.a.length === 2, 'A 화면에 2명', seen.a.join(', '));
check(seen.b.length === 2, 'B 화면에 2명', seen.b.join(', '));
await A.screenshot({ path: path.join(OUT, 'mp-1-lobby-A.png') });

/* ---------------------------------------------------------------------- */
step('A(방장)가 작전 개시');
await A.evaluate(() => window.game.net.setRoomConfig({ botCount: 2, difficulty: 'easy' }));
await A.waitForTimeout(300);
await A.click('#btnStart');
await Promise.all([
  A.waitForFunction(() => window.game.state === 'playing', { timeout: 15000 }),
  B.waitForFunction(() => window.game.state === 'playing', { timeout: 15000 }),
]);
check(true, '두 클라이언트 모두 매치 시작');

// 서로의 캐릭터가 3D 로 생성됐는가
await A.waitForTimeout(1000);
const spawned = {
  a: await A.evaluate(() => window.game.entities.players.size),
  b: await B.evaluate(() => window.game.entities.players.size),
};
check(spawned.a === 1, 'A 씬에 팀원 캐릭터 1명', `${spawned.a}명`);
check(spawned.b === 1, 'B 씬에 팀원 캐릭터 1명', `${spawned.b}명`);

/* ---------------------------------------------------------------------- */
step('A 가 움직이면 B 화면에서 따라 움직이는가');
const before = await B.evaluate(() => {
  const ch = [...window.game.entities.players.values()][0];
  return [+ch.group.position.x.toFixed(2), +ch.group.position.z.toFixed(2)];
});

// A 를 맵 반대편으로 순간이동시키고 서버로 전송되기를 기다린다
await A.evaluate(() => {
  const g = window.game;
  g.player.pos.set(-6.4, 0, -1.2);      // 서쪽 통로
  g.player.yaw = 1.2;
});
await B.waitForFunction(
  (bx) => {
    const ch = [...window.game.entities.players.values()][0];
    return Math.hypot(ch.group.position.x - bx[0], ch.group.position.z - bx[1]) > 1.5;
  },
  before, { timeout: 15000 }
).catch(() => {});

const after = await B.evaluate(() => {
  const ch = [...window.game.entities.players.values()][0];
  return {
    pos: [+ch.group.position.x.toFixed(2), +ch.group.position.z.toFixed(2)],
    yaw: +ch.group.rotation.y.toFixed(2),
  };
});
const moved = Math.hypot(after.pos[0] - before[0], after.pos[1] - before[1]);
check(moved > 1.5, 'B 가 A 의 이동을 반영', `(${before}) -> (${after.pos}), ${moved.toFixed(1)}m`);
check(Math.abs(after.yaw - 1.2) < 0.35, 'B 가 A 의 시선 방향도 반영', `yaw ${after.yaw}`);

/* ---------------------------------------------------------------------- */
step('B 가 A 를 바라보는 장면 촬영');
await B.evaluate(() => {
  const g = window.game;
  const mate = [...g.entities.players.values()][0];
  const p = mate.group.position;
  // 팀원 정면 2.8m 앞에 서서 바라본다
  g.player.pos.set(p.x, 0, p.z + 2.8);
  g.player.yaw = 0;
  g.player.pitch = -0.03;
});
await B.waitForTimeout(1600);
await B.screenshot({ path: path.join(OUT, 'mp-2-teammate-B.png') });
check(true, '스크린샷 저장 (mp-2-teammate-B.png)');

/* ---------------------------------------------------------------------- */
step('A 가 사격하면 B 도 총소리/예광탄 이벤트를 받는가');
// ★ 리스너를 "기다리지 말고" 걸어두기만 한다.
//   await 로 프로미스를 기다리면 A 가 쏘기도 전에 타임아웃이 난다.
await B.evaluate(() => {
  window.__shots = [];
  window.game.net.on('playerShot', (d) => window.__shots.push(d.id));
});

await A.evaluate(async () => {
  window.game.controls.fire = true;
  await new Promise((r) => setTimeout(r, 1200));
  window.game.controls.fire = false;
});

await B.waitForFunction(() => window.__shots.length > 0, { timeout: 10000 }).catch(() => {});
const shots = await B.evaluate(() => window.__shots);
check(shots.length > 0, 'B 가 A 의 사격 이벤트 수신', `${shots.length}발`);

const aId = await A.evaluate(() => window.game.myId);
check(shots.every((id) => id === aId), '발사자 ID 가 A 로 찍힘');

/* ---------------------------------------------------------------------- */
step('B 가 나가면 A 화면에서 사라지는가');
await B.evaluate(() => window.game.net.leaveRoom());
await A.waitForFunction(() => window.game.entities.players.size === 0, { timeout: 10000 }).catch(() => {});
const left = await A.evaluate(() => window.game.entities.players.size);
check(left === 0, '나간 플레이어 정리됨', `남은 팀원 캐릭터 ${left}개`);

/* ---------------------------------------------------------------------- */
step('결과');
const real = errors.filter((e) => !e.includes('favicon') && !e.includes('404'));
check(real.length === 0, '콘솔 에러 없음',
      real.length ? `\n      ${real.slice(0, 5).join('\n      ')}` : '');

await browser.close();
console.log(failed ? `\n  ✘ 실패 ${failed}건\n` : '\n  ✔ 멀티플레이 전부 통과\n');
process.exit(failed ? 1 : 0);
