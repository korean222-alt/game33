import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOORWAYS, COLLIDERS, SPAWNS, ROOMS, BOMB_SITES, MAP,
  resolveCircle, hasLineOfSight, findRoute, moveBody, groundHeight,
} from '../public/js/map-data.js';
import {
  DOOR, DoorSet, rollDoorStates, ensureQuietEntry, doorCollider, isBlocking, throughPoint,
  doorDistance, openLeafCollider,
} from '../public/js/doors.js';

const all = (state) => DOORWAYS.map((d) => ({ ...d, state }));

test('닫힌 문은 사람과 시야를 막고, 열면 둘 다 통한다', () => {
  const closed = new DoorSet(all(DOOR.CLOSED));
  const open = new DoorSet(all(DOOR.OPEN));
  // 열린 문도 문짝 한 장은 남는다(젖혀진 자리). 문간 자체는 비어 있다.
  assert.equal(closed.colliders().length, COLLIDERS.length + DOORWAYS.length);
  assert.equal(open.colliders().length, COLLIDERS.length + DOORWAYS.length);
  assert.equal(new DoorSet(all(DOOR.DESTROYED)).colliders().length, COLLIDERS.length);

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

/* --------------------------------------------------------------------------
 *  열린 문짝
 *
 *  문을 열면 문짝은 사라지지 않고 경첩 쪽으로 90도 젖혀져 방 안에 서 있다.
 *  예전에는 이 자리에 콜라이더가 없어서, 눈에 보이는 문짝을 쏘면 총알이 그대로
 *  통과해 뒤쪽 벽에 박혔다.
 * ----------------------------------------------------------------------- */
test('열린 문짝은 제자리에 서서 총알을 막는다', () => {
  const doors = new DoorSet(all(DOOR.OPEN));
  const colliders = doors.colliders();

  for (const door of DOORWAYS) {
    const leaf = openLeafCollider(door);
    // 문짝은 문틀 폭만큼 길고 얇다.
    const long = Math.max(leaf.w, leaf.d), thin = Math.min(leaf.w, leaf.d);
    assert.ok(Math.abs(long - door.span) < 1e-9, `${door.id} 문짝 길이`);
    assert.ok(thin < 0.12, `${door.id} 문짝 두께`);
    // 젖혀진 문짝은 벽면(문틀 평면)에 수직이다.
    const acrossExtent = door.axis === 'x' ? leaf.w : leaf.d;
    assert.ok(Math.abs(acrossExtent - door.span) < 1e-9, `${door.id} 문짝 방향`);

    // 문짝 한복판을 지나는 선은 막힌다.
    const across = door.axis === 'x' ? 'x' : 'z';
    const a = { x: leaf.x, z: leaf.z }, b = { x: leaf.x, z: leaf.z };
    a[across] -= 2; b[across] += 2;
    assert.equal(hasLineOfSight(a.x, a.z, b.x, b.z, 1.2, colliders), false,
      `${door.id} 열린 문짝을 총알이 통과한다`);
  }
});

test('열린 문짝이 문간을 막지는 않는다', () => {
  const doors = new DoorSet(all(DOOR.OPEN));
  const colliders = doors.colliders();
  for (const door of DOORWAYS) {
    const a = throughPoint(door, door.x - 3, door.z - 3, 1.4);
    const b = throughPoint(door, door.x + 3, door.z + 3, 1.4);
    assert.equal(hasLineOfSight(a.x, a.z, b.x, b.z, 1.4, colliders), true,
      `${door.id} 열린 문간이 막혔다`);
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

/* --------------------------------------------------------------------------
 *  손이 닿는 거리
 *
 *  예전에는 문 "중심점"까지의 거리로 쟀다. 정문은 폭이 2.4m 라서, 문 앞에 바짝
 *  붙어 서 있어도 옆으로 조금만 비켜서면 중심이 2m 넘게 멀어져 안내가 사라졌다.
 *  화면에 안내가 떴는데 눌러도 안 되는 상황이 없도록, 화면과 서버가 같은 자를
 *  쓰는지 확인한다.
 * ----------------------------------------------------------------------- */
test('넓은 문은 문 폭 안 어디에 서도 손이 닿는다', () => {
  const doors = new DoorSet(all(DOOR.CLOSED));
  const front = doors.get('front');
  assert.ok(front, '정문을 찾지 못했다');
  assert.ok(front.span >= 2, '정문은 넓은 문이어야 한다');

  // 문 폭의 가장자리에서 1.2m 앞. 중심까지는 1.2m 보다 훨씬 멀다.
  const edgeX = front.x + front.span / 2 - 0.1;
  const standZ = front.z + 1.2;
  assert.ok(Math.hypot(edgeX - front.x, standZ - front.z) > 1.5, '시험 지점이 중심에서 충분히 멀어야 한다');
  assert.ok(Math.abs(doorDistance(front, edgeX, standZ) - 1.2) < 0.01);

  const near = doors.nearest(edgeX, standZ);
  assert.equal(near?.door.id, 'front');
});

test('문에서 멀면 안내가 뜨지 않는다', () => {
  const doors = new DoorSet(all(DOOR.CLOSED));
  const front = doors.get('front');
  // 문 폭 밖으로 4m, 앞으로 4m -> 어떤 자로 재도 닿지 않는다
  assert.equal(doors.nearest(front.x + front.span / 2 + 4, front.z + 4), null);
});

test('부서진 문에는 남은 동작이 없다', () => {
  const doors = new DoorSet(all(DOOR.DESTROYED));
  for (const door of doors.doors) {
    assert.deepEqual(doors.available(door), []);
    assert.equal(doors.resultOf(door, 'open'), null);
    assert.equal(doors.resultOf(door, 'kick'), null);
  }
});

test('안내에 뜨는 동작은 전부 실제로 결과가 있다', () => {
  for (const state of [DOOR.OPEN, DOOR.CLOSED, DOOR.LOCKED, DOOR.BARRICADED]) {
    const doors = new DoorSet(all(state));
    for (const door of doors.doors) {
      const actions = doors.available(door);
      assert.ok(actions.length > 0, `${state} 에 할 수 있는 동작이 없다`);
      for (const action of actions) {
        assert.ok(doors.resultOf(door, action), `${state} + ${action} 이 아무 결과도 없다`);
      }
    }
  }
});
