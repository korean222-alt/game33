import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadPose, RELOAD_BEATS } from '../public/js/reload-motion.js';

const norm = (p) => Math.hypot(...p.pos) + Math.hypot(...p.rot);

test('장전 전후에는 총이 제자리다 (동작이 남아 조준이 틀어지면 안 된다)', () => {
  for (const t of [-1, 0, 1, 1.5, NaN, undefined]) {
    assert.deepEqual(reloadPose(t), { pos: [0, 0, 0], rot: [0, 0, 0] });
  }
});

test('장전 중에는 총이 실제로 움직인다', () => {
  const mid = reloadPose(RELOAD_BEATS.drop);
  assert.ok(norm(mid) > 0.3, JSON.stringify(mid));
  // 탄창을 갈려면 총이 내려가고 탄창구가 보이게 눕는다.
  assert.ok(mid.pos[1] < -0.1, String(mid.pos[1]));
  assert.ok(mid.rot[0] > 0.2, String(mid.rot[0]));
});

test('동작은 끊기지 않고 이어진다', () => {
  let prev = reloadPose(0.0001), maxJump = 0;
  for (let t = 0.0001; t <= 1; t += 0.002) {
    const p = reloadPose(t);
    maxJump = Math.max(maxJump, Math.abs(norm(p) - norm(prev)));
    prev = p;
  }
  assert.ok(maxJump < 0.02, `한 프레임에 ${maxJump.toFixed(3)} 만큼 튄다`);
});

test('노리쇠 전진 구간에만 총이 뒤로 채인다', () => {
  assert.equal(Math.abs(reloadPose(RELOAD_BEATS.release).pos[0]), 0);
  const charge = reloadPose((RELOAD_BEATS.insert + 1) / 2);
  assert.ok(charge.pos[0] < -0.02, String(charge.pos[0]));
});

test('총을 올리는 구간이 끝나면 다시 원자세로 수렴한다', () => {
  const almost = reloadPose(0.995);
  assert.ok(norm(almost) < 0.05, JSON.stringify(almost));
});
