/* 실제 브라우저에서 게임 한 장면을 품질별로 찍어 비교한다.
 *
 *   npm install --no-save playwright        (Chromium 은 이미 있어야 한다)
 *   node scripts/graphics-preview.mjs [저장폴더]
 *
 * 화면 효과는 단위 테스트로 확인할 수 없다. 셰이더가 컴파일되는지, 어느 품질에서
 * 어떤 단계가 살아 있는지, 품질을 오갈 때 렌더 타깃이 제대로 놓이는지는 WebGL
 * 컨텍스트가 있어야 알 수 있다. 그래서 서버를 띄우고 로비를 지나 실제 경기에
 * 들어간 뒤, HUD 가 섞이지 않도록 캔버스 픽셀을 직접 뽑는다.
 *
 * CI 의 소프트웨어 렌더러(SwiftShader)에서도 돌지만, 거기서 잰 프레임 시간은
 * 실제 GPU 와 무관하다. 이 스크립트가 답하는 것은 "무엇이 보이는가" 까지다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.argv[2] || 'graphics-preview';
const PORT = process.env.PREVIEW_PORT || '3192';
const CHROMIUM = process.env.CHROMIUM_PATH;

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
  const page = await browser.newPage({ viewport: { width: 800, height: 520 } });
  page.on('pageerror', (e) => errors.push('[페이지] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[콘솔] ' + m.text()); });

  await page.addInitScript(() => localStorage.setItem('market-raid-settings', JSON.stringify({
    quality: 'ultra', _qualityPicked: true, autoScale: false, soundEnabled: false,
  })));
  await page.goto(`http://localhost:${PORT}`);
  await page.click('#btnCreate');
  await page.waitForFunction(() => window.__mr?.input, null, { timeout: 60000 });
  await page.evaluate(() => {
    window.__mr.renderer.setPixelRatio(1);
    window.__mr.renderer.setSize(800, 520);
  });
  await page.click('#btnReady');
  await page.waitForFunction(() => !document.getElementById('btnStart').disabled);
  await page.click('#btnStart');
  await page.locator('#briefing').waitFor({ state: 'visible' });
  const pages = await page.evaluate(async () => (await import('/js/mission-story.js')).MISSION.pages.length);
  for (let i = 0; i < pages; i++) await page.click('#briefNext');
  await page.waitForFunction(() => window.__mr?.matchActive, null, { timeout: 60000 });

  /* 대홀 구석. 초록 카운터가 바닥에 닿는 선, 기둥, 벽 모서리가 한 화면에
   * 들어와서 접촉 그림자가 생겼는지 보기 좋은 자리다. 경기 중이라 가만히
   * 두면 용의자에게 사살당하므로, 촬영은 한 번의 evaluate 안에서 끝낸다. */
  const shots = await page.evaluate(() => {
    const game = window.__mr, out = {}, rows = [];
    game.camera.position.set(2, 1.62, 2);
    game.camera.rotation.set(-0.18, -Math.PI * 0.75, 0, 'YXZ');
    game.camera.updateMatrixWorld(true);
    game.world.scene.updateMatrixWorld(true);

    for (const quality of ['low', 'medium', 'high', 'ultra']) {
      game.pipeline.setQuality(quality);
      game.pipeline.render(); game.pipeline.render();
      out[quality] = game.renderer.domElement.toDataURL('image/png');
      rows.push({
        품질: quality,
        합성: !!game.pipeline.composer,
        AO: !!game.pipeline.gtao,
        SMAA: !!game.pipeline.smaa,
        단계: game.pipeline.composer ? game.pipeline.composer.passes.length : 0,
        텍스처: game.renderer.info.memory.textures,
      });
    }

    // 가림이 실제로 잡히는지 보려면 AO 버퍼만 따로 봐야 한다. 합성된 화면에서는
    // 접촉면에만 얇게 들어가서 눈으로 가려내기 어렵다.
    game.pipeline.setQuality('ultra');
    game.pipeline.gtao.output = 4;
    game.pipeline.render(); game.pipeline.render();
    out['ultra-ao버퍼'] = game.renderer.domElement.toDataURL('image/png');
    game.pipeline.gtao.output = 0;

    out.rows = rows;
    out.glError = game.renderer.getContext().getError();
    return out;
  });

  for (const [name, data] of Object.entries(shots)) {
    if (name === 'rows' || name === 'glError') continue;
    await fs.writeFile(`${OUT}/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  }
  console.table(shots.rows);
  console.log(`glError: ${shots.glError}  (0 이어야 정상)`);
  console.log(`저장 위치: ${OUT}/`);
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
