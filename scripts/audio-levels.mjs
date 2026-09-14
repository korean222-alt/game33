/* 소리 크기 계측기.
 * 헤드리스 브라우저에는 스피커가 없어 실시간 분석기는 0 만 돌려준다.
 * OfflineAudioContext 는 장치와 무관하게 같은 계산을 하고 파형을 돌려주므로
 * "실제로 얼마나 큰 소리가 나는가" 를 숫자로 확인할 수 있다. */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

/* 실행:  node scripts/audio-levels.mjs       (실제로 들리는 크기)
 *        RAW=1 node scripts/audio-levels.mjs (후처리 없는 원래 크기)
 *
 * 기준치 (peak):  총성 0.6~0.9 · 폭발 0.7~1.0 · 문 0.25~0.5 ·
 *                 장전/수갑/비명 0.3~0.6 · 발소리 0.05~0.15
 * 이보다 작으면 "소리가 안 난다" 는 신고가 들어온다. 실제로 그랬다. */

const launch = { args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) };
const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '3193' }, stdio: ['ignore','pipe','pipe'] });
await new Promise(r => server.stdout.on('data', d => { if (String(d).includes('서버 준비됨')) r(); }));
const browser = await chromium.launch(launch);
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:3193');
await page.evaluate((raw) => { globalThis.RAW = raw; }, process.env.RAW === '1');

const report = await page.evaluate(async () => {
  const { GameAudio } = await import('/js/audio.js');
  const rows = [];
  const once = async (play, seconds) => {
    const offline = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
    Object.defineProperty(offline, 'state', { get: () => 'running' });
    const audio = new GameAudio({ contextFactory: () => offline });
    await audio.unlock();
    if (globalThis.RAW && audio.limiter) {
      audio.master.disconnect();
      audio.limiter.disconnect();
      audio.master.connect(offline.destination);   // 리미터를 통째로 뺀다
    }
    audio.setListener({ x: 0, y: 1.6, z: 0 }, 0);
    play(audio);
    const buffer = await offline.startRendering();
    const data = buffer.getChannelData(0);
    let peak = 0;
    // 20ms 단위로 끊어 RMS 를 재고 그중 가장 큰 값을 쓴다 (체감 크기에 가깝다).
    const window = 960;
    let loudest = 0;
    for (let start = 0; start + window <= data.length; start += window) {
      let sum = 0;
      for (let i = start; i < start + window; i++) {
        const v = data[i];
        sum += v * v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      loudest = Math.max(loudest, Math.sqrt(sum / window));
    }
    return { peak, loudest };
  };
  // 노이즈 버퍼가 매번 달라지므로 세 번 재서 평균을 낸다.
  const render = async (name, play, seconds = 1.5) => {
    let peak = 0, loudest = 0;
    for (let i = 0; i < 3; i++) {
      const r = await once(play, seconds);
      peak += r.peak / 3; loudest += r.loudest / 3;
    }
    rows.push({ name, peak: +peak.toFixed(3), loudness: +loudest.toFixed(3) });
  };
  await render('shot(rifle)', (a) => a.shot('rifle'));
  await render('shot(sniper)', (a) => a.shot('sniper'));
  await render('door(kick)', (a) => a.door({ x: 0, z: 0 }, 'kick'));
  await render('door(open)', (a) => a.door({ x: 0, z: 0 }, 'open'));
  await render('reload', (a) => a.reload(2), 2.6);
  await render('scream', (a) => a.scream(null, 'scream'));
  await render('pain', (a) => a.scream(null, 'pain'));
  await render('death', (a) => a.scream(null, 'death'));
  await render('shoutVox', (a) => a.scream(null, 'shout'));
  await render('cuff', (a) => a.cuff());
  await render('work', (a) => a.work(null, 'defuse'));
  await render('pickup', (a) => a.pickup());
  await render('pin', (a) => a.pin());
  await render('beep', (a) => a.beep());
  await render('tinnitus', (a) => a.tinnitus(1));
  await render('cough', (a) => a.cough());
  await render('hurt', (a) => a.hurt());
  await render('impact', (a) => a.impact());
  await render('footstep', (a) => a.footstep({}));
  await render('blast(frag)', (a) => a.blast('frag'));
  await render('contact', (a) => a.contact());
  await render('dryFire', (a) => a.dryFire());
  return rows;
});
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('sound', 16), pad('peak', 8), 'loudness(20ms RMS)');
for (const r of report) console.log(pad(r.name, 16), pad(r.peak, 8), r.loudness);
console.log('errors:', errors);
await browser.close(); server.kill();
