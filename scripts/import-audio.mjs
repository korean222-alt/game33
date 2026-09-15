/* =============================================================================
 *  import-audio.mjs  -  public/assets/audio/ 를 훑어서 manifest.json 을 만든다
 *
 *  사용법:  npm run import:audio
 *
 *  폴더에 소리 파일을 넣기만 하면 된다. 파일 이름이나 폴더 이름에 들어 있는
 *  이름표를 보고 알맞은 자리에 넣는다.
 *
 *      voice/shout-1.ogg      -> voice/shout
 *      shout-02.mp3           -> voice/shout
 *      gun/rifle/shot-a.wav   -> gun/rifle
 *
 *  어느 자리에도 넣을 수 없는 파일은 그대로 알려 주고 건너뛴다. 조용히 무시하면
 *  "파일을 넣었는데 소리가 안 바뀐다" 는 상황이 된다.
 * ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = path.join(ROOT, 'public', 'assets', 'audio');
const MANIFEST = path.join(AUDIO_DIR, 'manifest.json');
const EXTENSIONS = new Set(['.ogg', '.mp3', '.wav', '.m4a', '.aac', '.opus', '.flac']);

/* 이름표 -> 파일 이름에서 찾을 말. 위에 있는 것부터 본다(먼저 맞는 쪽이 이긴다).
 * public/assets/audio/README.md 의 표와 같아야 한다. */
const SLOTS = [
  ['voice/surrender', ['surrender', '항복']],
  ['voice/contact', ['contact', 'spot', '발견']],
  ['voice/scream', ['scream', '비명']],
  ['voice/shout', ['shout', 'yell', 'warn', '경고', '고함']],
  ['voice/death', ['death', 'die', 'dying', '사망']],
  ['voice/panic', ['panic', 'fear', 'afraid', '공포']],
  ['voice/defy', ['defy', 'taunt', '저항']],
  ['voice/cuffed', ['cuffed', 'protest']],
  ['voice/cough', ['cough', '기침']],
  ['voice/pain', ['pain', 'grunt', 'hurt', 'ow', '신음']],
  ['gun/reload', ['reload', 'magazine', 'mag', '장전']],
  ['gun/sniper', ['sniper', 'awm', 'bolt']],
  ['gun/smg', ['smg', 'ump', 'subm']],
  ['gun/rifle', ['rifle', 'm416', 'ak', 'gunshot', 'shot', '총성']],
  ['door/unlock', ['unlock', 'lockpick', 'pick', '해정']],
  ['door/kick', ['kick', 'breach', 'break', '강제']],
  ['door/close', ['close', 'shut', '닫']],
  ['door/open', ['open', 'door', '문']],
  ['gear/cuff', ['cuff', 'handcuff', 'ratchet', '수갑']],
  ['grenade/flash', ['flash', 'stun', '섬광']],
  ['grenade/gas', ['gas', 'smoke', '가스']],
  ['grenade/frag', ['frag', 'explos', 'blast', '파편']],
  ['player/hurt', ['hurt', 'impact', 'damage', '피격']],
];

/** 폴더를 재귀로 훑어 소리 파일의 상대 경로를 모은다. */
async function walk(dir, base = '') {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel));
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(rel);
  }
  return out;
}

/** 파일 경로에서 이름표를 알아낸다. 못 찾으면 null. */
function slotOf(relativePath) {
  const key = relativePath.toLowerCase().replace(/\\/g, '/');
  // 폴더 이름이 곧 이름표인 경우를 먼저 본다 (voice/shout/1.ogg).
  for (const [slot] of SLOTS) {
    if (key.startsWith(`${slot}/`)) return slot;
  }
  for (const [slot, words] of SLOTS) {
    if (words.some((w) => key.includes(w))) return slot;
  }
  return null;
}

const files = await walk(AUDIO_DIR);
const clips = {};
const skipped = [];

for (const file of files.sort()) {
  const slot = slotOf(file);
  if (!slot) { skipped.push(file); continue; }
  (clips[slot] ||= []).push(file);
}

const total = Object.values(clips).reduce((n, list) => n + list.length, 0);

/* 목록 파일은 비어 있더라도 항상 둔다. 없으면 게임이 켜질 때마다 404 를 한 번씩
 * 받아서 브라우저 콘솔이 지저분해진다. clips 가 비면 전부 합성음이다. */
const NOTE = '자동 생성됩니다. 직접 고치지 말고 npm run import:audio 를 돌리세요. '
  + 'clips 가 비어 있으면 모든 소리를 합성으로 만듭니다. '
  + '파일 넣는 방법은 같은 폴더의 README.md 를 보세요.';
await fs.writeFile(MANIFEST, `${JSON.stringify({ note: NOTE, clips }, null, 2)}\n`);

if (!total) {
  console.log('소리 파일이 없습니다. 합성음을 그대로 씁니다.');
  console.log(`파일을 넣을 곳: ${path.relative(ROOT, AUDIO_DIR)}/`);
  console.log('넣는 방법과 받을 곳은 그 폴더의 README.md 에 적어 두었습니다.');
} else {
  console.log(`소리 ${total}개를 ${Object.keys(clips).length}개 자리에 넣었습니다.`);
  for (const [slot, list] of Object.entries(clips).sort()) {
    console.log(`  ${slot.padEnd(18)} ${list.length}개  ${list.join(', ')}`);
  }
}

if (skipped.length) {
  console.log('\n이름표를 알 수 없어 건너뛴 파일:');
  for (const file of skipped) console.log(`  ${file}`);
  console.log('파일 이름에 shout / scream / reload 처럼 이름표를 넣거나,');
  console.log('voice/shout/ 같은 폴더에 넣으면 알아봅니다 (README.md 의 표).');
}
