/* =============================================================================
 *  tools/dev/check-viewmodel.mjs  -  1인칭 총 위치를 눈으로 확인한다
 *
 *  총 3정 x (허리사격 / 정조준) = 6장을 찍어서
 *  tools/dev/preview-out/vm-*.png 로 저장한다.
 *
 *  총이 너무 크거나, 화면 밖으로 나가거나, 총구가 뒤를 보고 있으면
 *  이 사진만 봐도 바로 안다.
 *
 *  실행:  node server.js  띄우고  ->  node tools/dev/check-viewmodel.mjs
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
const page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('  [페이지오류]', e.message));

await page.goto(URL_BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.game?.state === 'menu', { timeout: 60000 });

// 화질 낮춤(헤드리스 속도) + 방 만들고 바로 시작
await page.evaluate(() => {
  window.game.settings.autoScale = false;
  window.game._applyQuality('low');
});
await page.click('#btnCreate');
await page.waitForFunction(() => window.game.state === 'lobby');
await page.evaluate(() => window.game.net.setRoomConfig({ botCount: 2, difficulty: 'easy' }));
await page.waitForTimeout(300);
await page.click('#btnStart');
await page.waitForFunction(() => window.game.state === 'playing', { timeout: 15000 });
await page.waitForTimeout(800);

for (const weapon of ['rifle', 'smg', 'sniper']) {
  for (const ads of [false, true]) {
    await page.evaluate(({ weapon, ads }) => {
      const g = window.game;
      g.myWeapon = weapon;
      g.player.setWeapon(weapon);
      g.player.setSpec(g.weapons[weapon]);
      // 제일 밝은 중앙 매대 바로 앞. 매대(2.6m)가 배경이 되어 크기 비교가 된다
      g.player.pos.set(-2.33, 0, 2.4);
      g.player.yaw = 0.25;
      g.player.pitch = 0;
      g.player.vel.set(0, 0, 0);
      g.controls.ads = ads;
      g.controls.move.x = 0; g.controls.move.y = 0;
      g.controls.fire = false;
    }, { weapon, ads });

    // 전환이 끝날 때까지 기다린다 (헤드리스는 프레임이 느리다)
    await page.waitForFunction(
      (want) => Math.abs(window.game.player.adsAmount - want) < 0.03,
      ads ? 1 : 0, { timeout: 20000 }
    ).catch(() => {});

    const info = await page.evaluate(() => {
      const p = window.game.player;
      return {
        pos: p.vmHolder.position.toArray().map((v) => +v.toFixed(3)),
        rot: p.vmHolder.rotation.toArray().slice(0, 3).map((v) => +v.toFixed(3)),
        ads: +p.adsAmount.toFixed(2),
      };
    });

    const name = `vm-${weapon}-${ads ? 'ads' : 'hip'}`;
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`  ✔ ${name.padEnd(18)} pos=[${info.pos}] rot=[${info.rot}] ads=${info.ads}`);
  }
}

await browser.close();
console.log(`\n  -> ${path.relative(process.cwd(), OUT)}/vm-*.png\n`);
