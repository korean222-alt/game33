/* 1인칭 재장전 동작.
 *
 * 총 모델에는 뼈대가 없어서 애니메이션 클립을 입힐 수 없다. 그래서 총 전체를
 * 움직여서 재장전을 표현한다. 여기서 보는 것은 세 가지다.
 *   1) 시작과 끝에서 총이 평소 자세에 정확히 돌아온다 (안 그러면 총이 조금씩
 *      틀어진 채 남는다)
 *   2) 중간에는 실제로 총이 내려가고 기울어진다 (동작이 "없는" 것과 구분)
 *   3) 빈 탄창이 한 번 나왔다가 아래로 떨어지고 사라진다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadPose, reloadProgress } from '../public/js/reload-motion.js';

test('재장전 전후로 총은 평소 자세로 정확히 돌아온다', () => {
  for (const t of [0, 1, -0.5, 1.4]) {
    const pose = reloadPose(t);
    assert.deepEqual(pose.position, [0, 0, 0], `t=${t}`);
    assert.deepEqual(pose.rotation, [0, 0, 0], `t=${t}`);
    assert.equal(pose.mag, null, `t=${t}`);
  }
});

test('재장전 중에는 총이 내려가고 안쪽으로 기운다', () => {
  const mid = reloadPose(0.3);
  assert.ok(mid.position[1] < -0.05, '총이 아래로 내려가야 한다');
  assert.ok(mid.position[2] > 0.02, '총이 몸 쪽으로 당겨져야 한다');
  assert.ok(mid.rotation[1] < -0.2, '탄창 구멍이 보이게 안쪽으로 돌아야 한다');
});

test('자세는 끊기지 않고 이어진다', () => {
  let prev = reloadPose(0);
  for (let i = 1; i <= 200; i++) {
    const pose = reloadPose(i / 200);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(pose.position[axis] - prev.position[axis]) < 0.02,
        `위치가 t=${i / 200} 에서 튄다`);
      assert.ok(Math.abs(pose.rotation[axis] - prev.rotation[axis]) < 0.08,
        `회전이 t=${i / 200} 에서 튄다`);
    }
    prev = pose;
  }
});

test('빈 탄창은 한 번만 나와서 아래로 떨어진다', () => {
  const samples = [];
  for (let i = 0; i <= 100; i++) samples.push(reloadPose(i / 100).mag);
  const visible = samples.map((m) => !!m);
  assert.ok(visible.some(Boolean), '탄창이 한 번은 보여야 한다');
  // 보이는 구간은 딱 한 덩어리여야 한다 (깜빡이면 안 된다)
  assert.equal(visible.filter((v, i) => v && !visible[i - 1]).length, 1, '탄창이 여러 번 나타난다');

  const shown = samples.filter(Boolean);
  for (let i = 1; i < shown.length; i++) {
    assert.ok(shown[i].position[1] < shown[i - 1].position[1], '탄창은 계속 아래로 떨어져야 한다');
    assert.ok(shown[i].spin > shown[i - 1].spin, '탄창은 돌면서 떨어진다');
  }
  assert.ok(shown[shown.length - 1].position[1] < -1, '화면 밖까지 떨어져야 한다');
});

test('진행도는 총마다 다른 재장전 시간에 맞춰진다', () => {
  assert.equal(reloadProgress(1000, 0, 2), 0.5);
  assert.equal(reloadProgress(3200, 0, 3.2), 1);
  assert.ok(reloadProgress(2400, 0, 2) > 1, '시간이 지나면 1 을 넘어 끝난다');
});
