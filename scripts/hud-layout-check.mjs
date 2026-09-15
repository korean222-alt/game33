/* =============================================================================
 *  hud-layout-check.mjs  -  화면 요소가 서로 겹치지 않는지 실제 브라우저에서 잰다
 *
 *  가로로 누운 휴대폰은 세로가 390px 밖에 안 된다. 여기에 시계·목표 목록·무전·
 *  문 안내·버튼 열 몇 개를 각각 "화면의 몇 %" 로 놓으면 반드시 겹친다. 눈으로는
 *  기기를 바꿀 때마다 다시 확인해야 하므로, 실제로 띄워 놓고 사각형이 겹치는지
 *  기계가 재게 한다.
 *
 *  실행:  node scripts/hud-layout-check.mjs
 *  (npm install --no-save playwright 가 필요하다. 미리 받아 둔 크로미움이 있으면
 *   CHROMIUM_PATH 로 지정한다.)
 * ========================================================================== */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = '3192';

/* 시험할 화면 크기. 첨부된 화면은 아이폰을 가로로 눕힌 것이다. */
const VIEWPORTS = [
  { name: '아이폰 가로', width: 844, height: 390 },
  { name: '작은 폰 가로', width: 740, height: 360 },
  { name: '태블릿 가로', width: 1180, height: 820 },
  { name: '폰 세로', width: 390, height: 844 },
];

/* 서로 절대 겹치면 안 되는 것들. 버튼은 눌려야 하고, 안내는 읽혀야 한다. */
const BOXES = [
  '#phasePanel', '#siteList', '#timer',
  '#radio', '#door', '#defuse', '#crosshair', '#banner',
  '#stick', '#bFire', '#bAds', '#bRel', '#bJump', '#bCrch', '#bSpr',
  '#bPeek', '#bDoor', '#bKick', '#bUse', '#bShout', '#bNadeSel', '#bNade',
];

const launchOptions = {
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
};

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url), env: { ...process.env, PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서버가 뜨지 않는다')), 10000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('서버 준비됨')) { clearTimeout(timer); resolve(); }
    });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('서버 종료: ' + code)); });
  });

  browser = await chromium.launch(launchOptions);
  let failures = 0;

  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: true, isMobile: true,
    });
    await page.goto(`http://localhost:${PORT}`);

    // 게임을 켜지 않고 HUD 만 "최악의 경우"로 펼친다. 버튼이 전부 나와 있고,
    // 무전과 문 안내가 동시에 떠 있는 상태가 가장 빡빡하다.
    const measured = await page.evaluate(async (ids) => {
      const { Hud } = await import('/js/hud.js');
      const hud = new Hud();
      hud.show(null);
      hud.showTouch(true);
      hud.buildSites([{ id: 'a', label: '서재 A' }, { id: 'b', label: '온실 B' }]);
      hud.setObjectives({
        name: '2단계 · 수색', title: '방마다 확인',
        list: [
          { label: '민간인 전원 확보', have: 1, need: 5 },
          { label: '기록 소각 장치 해체', have: 1, need: 2, detail: '서재 A · 서재' },
          { label: '증거 회수', have: 1, need: 3, kind: 'bonus', detail: '무전 기록 · 연회실 / 거래 장부 · 서재' },
          { label: '민간인 피해 0명', done: true },
        ],
      });
      hud.radio('지휘부: 레드 팀, 진입 승인. 담장 안에서 움직이는 것은 전부 확인 대상이다.');
      hud.banner('발각됨 — 접촉', 60000);
      hud.setDefuse(true, '해체 중…', 0.4);
      hud.setDoor({ state: 'closed' }, '', { primary: 'open', peek: true, kick: true });

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const out = {};
      for (const id of ids) {
        const el = document.querySelector(id);
        if (!el || el.classList.contains('hidden')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out[id] = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      out._doc = { w: innerWidth, h: innerHeight };
      return out;
    }, BOXES);

    const doc = measured._doc;
    delete measured._doc;
    const entries = Object.entries(measured);
    const problems = [];

    // 1) 화면 밖으로 나간 것이 없어야 한다.
    for (const [id, r] of entries) {
      if (r.x < -1 || r.y < -1 || r.x + r.w > doc.w + 1 || r.y + r.h > doc.h + 1) {
        problems.push(`${id} 가 화면 밖으로 나갔다 (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)})`);
      }
    }
    // 2) 서로 겹치지 않아야 한다.
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [idA, a] = entries[i], [idB, b] = entries[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 1 && oy > 1) {
          problems.push(`${idA} 와 ${idB} 가 ${Math.round(ox)}x${Math.round(oy)}px 겹친다`);
        }
      }
    }

    if (problems.length) {
      failures++;
      console.error(`\n✗ ${viewport.name} (${viewport.width}x${viewport.height})`);
      for (const p of problems) console.error('   ' + p);
    } else {
      console.log(`✓ ${viewport.name} (${viewport.width}x${viewport.height}) — ${entries.length}개 요소, 겹침 없음`);
    }
    await page.close();
  }

  assert.equal(failures, 0, `${failures}개 화면 크기에서 요소가 겹친다`);
  console.log('\nHUD 배치 확인 완료');
} finally {
  await browser?.close();
  server.kill();
}
