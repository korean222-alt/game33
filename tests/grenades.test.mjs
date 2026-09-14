import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP, COLLIDERS } from '../public/js/map-data.js';
import { DOOR, DoorSet, rollDoorStates } from '../public/js/doors.js';
import {
  GRENADES, GRENADE_ORDER, createGrenade, stepGrenade, flashStrength, fragDamage,
  gasIntensity, startingGrenades,
} from '../public/js/grenades.js';

const run = (grenade, colliders, seconds = 4, now = 0) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    if (stepGrenade(grenade, 1 / 60, colliders, now + t * 1000)) return { exploded: true, at: t };
  }
  return { exploded: false, at: seconds };
};

test('기본 장비 구성', () => {
  assert.deepEqual(startingGrenades(), { flash: 2, gas: 2, frag: 1 });
  assert.deepEqual(GRENADE_ORDER, ['flash', 'gas', 'frag']);
  for (const key of GRENADE_ORDER) assert.ok(GRENADES[key].fuse > 0 && GRENADES[key].radius > 0);
});

test('던진 투척체는 바닥에 떨어져 멈추고 신관 시간에 터진다', () => {
  const g = createGrenade('g1', 'flash', { x: 0, y: 1.5, z: 20 }, { x: 0, y: .2, z: -1 }, { now: 0 });
  const result = run(g, [], 3);
  assert.equal(result.exploded, true);
  assert.ok(Math.abs(result.at - GRENADES.flash.fuse) < 0.1, '신관 시간: ' + result.at);
  assert.ok(g.y >= 0 && g.y < 0.3, '바닥에 닿았다: ' + g.y);
  assert.ok(g.z < 20, '앞으로 나갔다: ' + g.z);
  assert.ok(Math.abs(g.x) < 0.5);
});

test('벽에 던지면 튕겨 되돌아온다 (닫힌 문도 벽처럼 막는다)', () => {
  const wall = [{ x: 0, z: 10, w: 20, d: .4, h: 4 }];
  const g = createGrenade('g2', 'frag', { x: 0, y: 1.4, z: 14 }, { x: 0, y: .05, z: -1 }, { now: 0 });
  run(g, wall, 1.2);
  assert.ok(g.z > 10.3, '벽을 통과하지 않았다: ' + g.z);
  assert.ok(g.vz >= -0.01, '속도가 반사되었다: ' + g.vz);

  const doors = new DoorSet(rollDoorStates(() => 0.9));
  const door = doors.get('front');
  const closed = createGrenade('g3', 'flash', { x: door.x, y: 1.4, z: door.z + 2.5 },
    { x: 0, y: 0, z: -1 }, { now: 0 });
  run(closed, doors.colliders(), 1);
  assert.ok(closed.z > door.z, '닫힌 문을 통과하지 못한다: ' + closed.z);

  doors.setState('front', DOOR.OPEN);
  const through = createGrenade('g4', 'flash', { x: door.x, y: 1.4, z: door.z + 2.5 },
    { x: 0, y: 0, z: -1 }, { now: 0 });
  run(through, doors.colliders(), 1);
  assert.ok(through.z < door.z, '열린 문으로는 굴러 들어간다: ' + through.z);
});

test('투척체는 실내 천장과 지면 사이에 머문다', () => {
  const g = createGrenade('g5', 'gas', { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: 0 }, { now: 0 });
  run(g, COLLIDERS, 2);
  assert.ok(g.y >= 0 && g.y <= MAP.height, g.y);
});

test('섬광탄: 벽 뒤에는 효과가 없고, 등지고 있으면 약하다', () => {
  const at = { x: 0, y: 1, z: 0 };
  // yaw = 0 은 -Z 를 본다. z=3 에 선 사람이 z=0 의 폭발을 마주 보는 방향이다.
  const facing = flashStrength(at, { x: 0, y: 0, z: 3 }, [], 0);
  const away = flashStrength(at, { x: 0, y: 0, z: 3 }, [], Math.PI);
  assert.ok(facing > 0.4, facing);
  assert.ok(away < facing * 0.6, `${away} vs ${facing}`);
  assert.equal(flashStrength(at, { x: 0, y: 0, z: 20 }, [], 0), 0, '범위 밖');
  const wall = [{ x: 0, z: 1.5, w: 20, d: .4, h: 4 }];
  assert.equal(flashStrength(at, { x: 0, y: 0, z: 3 }, wall, 0), 0, '벽 뒤');
  // 가까울수록 강하다
  assert.ok(flashStrength(at, { x: 0, y: 0, z: 1.5 }, [], 0)
    > flashStrength(at, { x: 0, y: 0, z: 7 }, [], 0));
});

test('파편탄: 거리로 감쇠하고 벽이 완전히 막는다', () => {
  const at = { x: 0, y: .2, z: 0 };
  const close = fragDamage(at, { x: 0, y: 0, z: 1 }, []);
  const far = fragDamage(at, { x: 0, y: 0, z: 5.5 }, []);
  assert.ok(close > far && far > 0, `${close} / ${far}`);
  assert.ok(close >= 60, '근거리는 치명적이다: ' + close);
  assert.equal(fragDamage(at, { x: 0, y: 0, z: 9 }, []), 0, '범위 밖');
  const wall = [{ x: 0, z: 1.5, w: 20, d: .4, h: 4 }];
  assert.equal(fragDamage(at, { x: 0, y: 0, z: 3 }, wall), 0, '벽 뒤');
  // 허리 높이 엄폐물은 상당 부분을 막는다
  const cover = [{ x: 0, z: 1.2, w: 4, d: .5, h: .9 }];
  const shielded = fragDamage(at, { x: 0, y: 0, z: 2.4 }, cover);
  const exposed = fragDamage(at, { x: 0, y: 0, z: 2.4 }, []);
  assert.ok(shielded > 0 && shielded < exposed * 0.5, `${shielded} vs ${exposed}`);
});

test('가스: 시야와 무관하지만 벽으로 줄어들고 범위를 넘으면 0', () => {
  const cloud = { x: 0, z: 0 };
  assert.ok(gasIntensity(cloud, { x: 0, z: 1 }, []) > gasIntensity(cloud, { x: 0, z: 5 }, []));
  assert.equal(gasIntensity(cloud, { x: 0, z: 12 }, []), 0);
  const wall = [{ x: 0, z: 1.5, w: 20, d: .4, h: 4 }];
  assert.ok(gasIntensity(cloud, { x: 0, z: 3 }, wall) < gasIntensity(cloud, { x: 0, z: 3 }, []));
  assert.ok(gasIntensity(cloud, { x: 0, z: 3 }, wall) > 0, '완전히 막지는 않는다');
});
