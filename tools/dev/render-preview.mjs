/* =============================================================================
 *  tools/dev/render-preview.mjs
 *
 *  구워진 GLB 를 헤드리스 크로미움으로 렌더해서 PNG 로 저장한다.
 *  모델 방향(총구가 어디를 보는지, 소품이 서 있는지)을 눈으로 확인하는 용도.
 *
 *  실행:  npm run preview:assets
 *  결과:  tools/dev/preview-out/*.png
 * ========================================================================== */

import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const OUT = path.join(__dirname, 'preview-out');
const PORT = 3999;

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['stall-tarp', 'stall-wood', 'crate', 'barrel', 'vase', 'well', 'table', 'rack',
     'weapon-rifle', 'weapon-smg', 'weapon-sniper', 'character'];

const app = express();
app.use(express.static(ROOT));           // /public/... /node_modules/... /tools/... 전부 열어준다
const server = app.listen(PORT);

await fs.mkdir(OUT, { recursive: true });
// CHROME_PATH 가 있으면 그 크로미움을 쓴다 (playwright 가 받아둔 게 없는 환경 대비)
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1300, height: 400 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [브라우저]', m.text()); });
page.on('pageerror', (e) => console.log('  [페이지오류]', e.message));

for (const name of MODELS) {
  try {
    await page.goto(`http://localhost:${PORT}/tools/dev/preview.html?model=${name}`,
                    { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });
    const info = await page.textContent('#info');
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`  ✔ ${name.padEnd(16)} ${info}`);
  } catch (err) {
    console.log(`  ✘ ${name.padEnd(16)} ${err.message.split('\n')[0]}`);
  }
}

await browser.close();
server.close();
console.log(`\n  -> ${path.relative(ROOT, OUT)}/\n`);
