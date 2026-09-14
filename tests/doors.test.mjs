import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOORWAYS, COLLIDERS, SPAWNS, ROOMS, BOMB_SITES, MAP,
  resolveCircle, hasLineOfSight, findRoute, moveBody, groundHeight,
} from '../public/js/map-data.js';
import {
  DOOR, DoorSet, rollDoorStates, ensureQuietEntry, doorCollider, isBlocking, throughPoint,
} from '../public/js/doors.js';

const all = (state) => DOORWAYS.map((d) => ({ ...d, state }));

test('닫힌 문은 사람과 시야를 막고, 열면 둘 다 통한다', () => {
  const closed = new DoorSet(all(DOOR.CLOSED));
  const open = new DoorSet(all(DOOR.OPEN));
  assert.ok(closed.colliders().length > COLLIDERS.length);
  assert.equal(open.colliders().length, COLLIDERS.length);

  for (const door of DOORWAYS) {
    const a = throughPoint(door, door.x - 3, door.z - 3, 1.2);
    const b = throughPoint(door, door.x + 3, door.z + 3, 1.2);
    // 문 양쪽 1.2m 지점 사이의 시야
    assert.equal(hasLineOfSight(a.x, a.z, b.x, b.z, 1.4, open.colliders()), true, door.id + ' 열림');
    assert.equal(hasLineOfSight(a.x, a.z, b.x, b.z, 1.4, closed.colliders()), false, door.id + ' 닫힘');
    // 문 정중앙은 닫혀 있으면 서 있을 수 없다 (현관 포치처럼 낮은 단은 밟고 선다)
    const feet = groundHeight(door.x, door.z, .32, open.colliders());
    const blocked = resolveCircle(door.x, door.z, .32, closed.colliders(), feet);
    assert.ok(Math.hypot(blocked.x - door.x, blocked.z - door.z) > .01, door.id + ' 통행 차단');
    const free = resolveCircle(door.x, door.z, .32, open.colliders(), feet);
    assert.ok(Math.hypot(free.x - door.x, free.z - door.z) < .01, door.id + ' 통행 허용');
  }
});

test('문 콜라이더는 문틀 구멍을 정확히 채운다', () => {
  for (const door of DOORWAYS) {
    const c = doorCollider(door);
    assert.equal(c.h, MAP.doorHeight);
    assert.equal(c.y, 0);
    const span = door.axis === 'x' ? c.d : c.w;
    assert.equal(span, door.span);
  }
});

test('문을 통과하려면 걸어 들어갈 수 있어야 한다 (열린 상태)', () => {
  const open = new DoorSet(all(DOOR.OPEN)).colliders();
  for (const door of DOORWAYS) {
    const from = throughPoint(door, door.x - 3, door.z - 3, 1.6);
    const to = throughPoint(door, door.x + 3, door.z + 3, 1.6);
    const dir = { x: to.x - from.x, z: to.z - from.z };
    const len = Math.hypot(dir.x, dir.z);
    let p = { x: from.x, y: 0, z: from.z }, v = { x: dir.x / len * 3, y: 0, z: dir.z / len * 3 };
    let grounded = true;
    let reached = false;
    for (let i = 0; i < 90 && !reached; i++) {
      const body = moveBody(p, { ...v }, 1 / 30, { grounded }, open);
      p = body.pos; grounded = body.onGround;
      reached = Math.hypot(p.x - to.x, p.z - to.z) < .5;
    }
    assert.ok(reached, `${door.id} 를 지나가지 못했다: ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
  }
});

test('상태 전이 규칙: 잠긴 문은 해정이나 강제 개방만, 바리케이드는 강제 개방만', () => {
  const doors = new DoorSet(all(DOOR.CLOSED));
  const door = doors.doors[0];

  assert.deepEqual(doors.available(door).sort(), ['kick', 'open', 'peek']);
  assert.equal(doors.resultOf(door, 'open'), DOOR.OPEN);
  assert.equal(doors.resultOf(door, 'close'), null);

  door.state = DOOR.LOCKED;
  assert.deepEqual(doors.available(door).sort(), ['kick', 'peek', 'unlock']);
  assert.equal(doors.resultOf(door, 'open'), null);
  assert.equal(doors.resultOf(door, 'unlock'), DOOR.CLOSED);
  assert.equal(doors.resultOf(door, 'kick'), DOOR.OPEN);

  door.state = DOOR.BARRICADED;
  assert.deepEqual(doors.available(door).sort(), ['kick', 'peek']);
  assert.equal(doors.resultOf(door, 'unlock'), null);
  assert.equal(doors.resultOf(door, 'kick'), DOOR.DESTROYED);

  door.state = DOOR.DESTROYED;
  assert.deepEqual(doors.available(door), []);
  assert.equal(isBlocking(DOOR.DESTROYED), false);

  door.state = DOOR.OPEN;
  assert.deepEqual(doors.available(door), ['close']);
});

test('콜라이더 배열은 상태가 바뀔 때만 새로 만들어진다 (격자 캐시 유지)', () => {
  const doors = new DoorSet(all(DOOR.CLOSED));
  const first = doors.colliders();
  assert.equal(doors.colliders(), first);
  assert.equal(doors.setState(doors.doors[0].id, DOOR.CLOSED), false);
  assert.equal(doors.colliders(), first);
  assert.equal(doors.setState(doors.doors[0].id, DOOR.OPEN), true);
  assert.notEqual(doors.colliders(), first);
});

test('무작위 문 상태에도 조용한 진입구가 하나는 남는다', () => {
  for (let seed = 0; seed < 200; seed++) {
    let n = seed;
    const random = () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
    const doors = ensureQuietEntry(rollDoorStates(random), random);
    const entries = doors.filter((d) => d.kind === 'entry');
    assert.ok(entries.some((d) => d.state === DOOR.CLOSED || d.state === DOOR.OPEN), 'seed ' + seed);
  }
});

test('봇 길찾기는 문을 무시한다 (직접 열기 때문). 모든 방과 목표에 닿는다', () => {
  for (const goal of [...ROOMS.map((r) => ({ x: r.x, z: r.z, n: r.name })), ...BOMB_SITES]) {
    assert.ok(findRoute(SPAWNS[0], goal).length > 0, JSON.stringify(goal));
  }
});

test('문 사이를 지나는 선분을 찾아낸다 (봇이 열어야 할 문)', () => {
  const doors = new DoorSet(all(DOOR.CLOSED));
  const door = doors.get('hall-library');
  const from = { x: door.x - 2, z: door.z };
  const to = { x: door.x + 2, z: door.z };
  assert.equal(doors.blockingBetween(from, to)?.id, 'hall-library');
  // 문에서 멀리 떨어진 같은 벽 통과는 그 문이 아니다
  assert.notEqual(doors.blockingBetween({ x: door.x - 2, z: door.z + 6 }, { x: door.x + 2, z: door.z + 6 })?.id,
    'hall-library');
  doors.setState('hall-library', DOOR.OPEN);
  assert.equal(doors.blockingBetween(from, to), null);
});
