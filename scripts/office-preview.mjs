/* 사무실 맵을 실제 브라우저에서 돌려 여러 자리에서 한 장씩 찍는다.
 *
 *   npm install --no-save playwright
 *   node scripts/office-preview.mjs [저장폴더]
 *   (미리 받아 둔 Chromium 을 쓰려면 CHROMIUM_PATH 를 준다)
 *
 * 단위 테스트는 좌표가 맞는지까지만 본다. 방이 의도한 대로 "보이는지" -
 * 코어가 트여 보이는지, 형광등이 저택의 샹들리에와 다른 느낌을 주는지,
 * 책상 위 모니터가 방을 밝히는지 - 는 화면을 봐야 알 수 있다.
 *
 * 촬영은 한 번의 evaluate 안에서 끝낸다. 경기 중이라 중간에 멈춰 있으면
 * 용의자에게 사살당한다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.argv[2] || 'office-preview';
const PORT = process.env.PREVIEW_PORT || '3195';
const CHROMIUM = process.env.CHROMIUM_PATH;

/** 어디서 무엇을 보는가. [이름, 눈 위치, yaw, pitch] */
const SHOTS = [
  ['01-정문광장', [0, 1.62, 44], Math.PI, -0.05],
  ['02-정문홀', [0, 1.62, 26.5], Math.PI, -0.03],
  ['03-로비안내', [-30, 1.62, 26.0], Math.PI * 0.92, -0.04],
  ['04-남복도', [-34, 1.62, 15.75], Math.PI / 2, 0],
  ['05-중앙코어', [0, 1.62, 9.0], Math.PI, -0.06],
  ['06-코어승강기', [-4.3, 1.62, -7.0], 0, 0.06],
  ['07-개발실동편', [22, 1.62, -12.6], Math.PI, -0.05],
  ['07b-디자인실', [-22, 1.62, 12.6], 0, -0.05],
  ['08-북복도', [0, 1.62, -15.75], -Math.PI / 2, 0],
  ['09-대회의실', [4, 1.62, -19.4], 0, -0.03],
  ['10-서버실', [-38.5, 1.62, -19.6], 0, 0],
  ['11-휴게실', [-32.0, 1.62, 4.6], 2.13, -0.05],
  ['12-전시홀', [30, 1.62, 28.4], -Math.PI * 0.55, -0.05],
];

await fs.mkdir(OUT, { recursive: true });
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url), env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'],
});
const errors = [];
server.stderr.on('data', (d) => errors.push('[서버] ' + d));
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서버 시작 시간 초과')), 15000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('서버 준비됨')) { clearTimeout(timer); resolve(); }
    });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('서버 종료: ' + code)); });
  });

  browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
    ...(CHROMIUM ? { executablePath: CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.on('pageerror', (e) => errors.push('[페이지] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[콘솔] ' + m.text()); });

  await page.addInitScript(() => localStorage.setItem('market-raid-settings', JSON.stringify({
    quality: 'high', _qualityPicked: true, autoScale: false, soundEnabled: false,
  })));
  await page.goto(`http://localhost:${PORT}`);
  await page.click('#btnCreate');
  await page.waitForFunction(() => window.__mr?.input, null, { timeout: 90000 });
  await page.evaluate(() => {
    window.__mr.renderer.setPixelRatio(1);
    window.__mr.renderer.setSize(900, 560);
  });

  // 작전 구역을 사무실로 바꾼다. 로비 단추는 서버가 보내 준 목록으로 그려진다.
  await page.click('#mapSeg button[data-m="office"]');
  await page.waitForFunction(() => window.__mr && document
    .querySelector('#mapSeg button[data-m="office"]').getAttribute('aria-pressed') === 'true');

  await page.click('#btnReady');
  await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
  await page.click('#btnStart');
  await page.locator('#briefing').waitFor({ state: 'visible' });
  const pages = await page.evaluate(async () => (await import('/js/mission-story.js')).MISSION.pages.length);
  for (let i = 0; i < pages; i++) await page.click('#briefNext');
  await page.waitForFunction(() => window.__mr?.matchActive, null, { timeout: 90000 });

  const result = await page.evaluate(async (shots) => {
    const game = window.__mr;
    const { CURRENT_MAP } = await import('/js/map-data.js');
    const out = { images: {}, mapId: CURRENT_MAP.id, missing: game.assets.missing.slice() };
    for (const [name, pos, yaw, pitch] of shots) {
      game.camera.position.set(pos[0], pos[1], pos[2]);
      game.camera.rotation.set(pitch, yaw, 0, 'YXZ');
      game.camera.updateMatrixWorld(true);
      game.world.scene.updateMatrixWorld(true);
      game.pipeline.render();
      game.pipeline.render();
      out.images[name] = game.renderer.domElement.toDataURL('image/jpeg', 0.82);
    }
    out.glError = game.renderer.getContext().getError();
    out.lights = game.world.pointLights.length;
    out.triangles = game.renderer.info.render.triangles;
    return out;
  }, SHOTS);

  for (const [name, data] of Object.entries(result.images)) {
    await fs.writeFile(`${OUT}/${name}.jpg`, Buffer.from(data.split(',')[1], 'base64'));
  }
  console.log(`켜진 맵: ${result.mapId}`);
  console.log(`빠진 모델: ${result.missing.length ? result.missing.join(', ') : '없음'}`);
  console.log(`조명 풀 ${result.lights}개 · 마지막 프레임 삼각형 ${result.triangles}`);
  console.log(`glError: ${result.glError}  (0 이어야 정상)`);
  console.log(`저장 위치: ${OUT}/  (${Object.keys(result.images).length}장)`);
} finally {
  await browser?.close();
  server.kill();
  if (errors.length) {
    console.log('--- 오류 ---');
    console.log(errors.slice(0, 20).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('페이지 오류 없음');
  }
}
