import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLIDERS, POSTS, findRoute, zoneAt } from '../public/js/map-data.js';
import { DOOR, DoorSet, rollDoorStates } from '../public/js/doors.js';
import {
  NOISE, heardLevel, hitChance, inFieldOfView, visibilityFactor, brightnessAt, hasClearShot,
} from '../public/js/perception.js';
import {
  createSuspect, createCivilian, updateSuspect, updateCivilian, deliverNoise,
  planOccupancy, updateMorale, shouldSurrender, spotTarget, PERSONALITIES,
  warnSuspect, surrenderChance, WARNING,
} from '../public/js/suspect-ai.js';

const closedDoors = () => new DoorSet(rollDoorStates(() => 0.9));

/** 테스트용 world. 실제 서버가 넘기는 것과 같은 모양이다. */
function makeWorld(overrides = {}) {
  const doors = overrides.doors ?? closedDoors();
  const fired = [];
  const noises = [];
  const opened = [];
  const world = {
    now: 100000, dt: 0.05,
    colliders: overrides.colliders ?? doors.colliders(),
    doors,
    players: [],
    skillScale: 1,
    alliesDown: 0, alliesNear: 0,
    random: () => 0.5,
    brightness: () => 1,
    playerById: (id) => world.players.find((p) => p.id === id) || null,
    nearestPlayer: (npc) => world.players[0] || null,
    route: (from, to) => findRoute(from, to),
    doorNear: (point, room) => doors.doors.some((d) =>
      d.link.includes(room) && Math.hypot(d.x - point.x, d.z - point.z) < 3.2),
    roamPoint: (room, npc) => POSTS.find((p) => p.room === room && Math.hypot(p.x - npc.x, p.z - npc.z) > 1.5) || null,
    hideSpot: () => ({ x: 0, z: 0 }),
    fallbackPoint: () => ({ x: 0, z: 0 }),
    // 서버 구현과 같은 계약: 문을 열면 소리가 난다.
    openDoor: (npc, door) => {
      opened.push(door.id);
      doors.setState(door.id, DOOR.OPEN);
      world.colliders = doors.colliders();
      world.noise(door.x, door.z, NOISE.doorOpen, 'door', npc.id);
    },
    noise: (x, z, level, type, by) => noises.push({ x, z, level, type, by }),
    fire: (npc, target, hit) => fired.push({ id: npc.id, target: target.id, hit }),
    onStateChange: () => {},
    onContact: () => {},
    onSurrender: () => {},
    onDefy: () => {},
    ...overrides,
  };
  world.fired = fired; world.noises = noises; world.opened = opened;
  return world;
}

const advance = (npc, world, seconds, step = 0.05) => {
  for (let t = 0; t < seconds; t += step) {
    world.now += step * 1000;
    world.dt = step;
    if (npc.kind === 'civilian') updateCivilian(npc, world);
    else updateSuspect(npc, world);
  }
};

test('소리는 거리와 벽으로 줄어든다', () => {
  const colliders = [{ x: 0, z: 0, w: .3, d: 20, h: 7 }];
  const near = heardLevel(NOISE.shot, { x: 3, z: 5 }, { x: 5, z: 5 }, []);
  const far = heardLevel(NOISE.shot, { x: 3, z: 5 }, { x: 28, z: 5 }, []);
  const throughWall = heardLevel(NOISE.shot, { x: -3, z: 5 }, { x: 3, z: 5 }, colliders);
  const openAir = heardLevel(NOISE.shot, { x: -3, z: 5 }, { x: 3, z: 5 }, []);
  assert.ok(near > far * 5, '가까운 소리가 훨씬 크다');
  assert.ok(throughWall < openAir * 0.6, '벽이 소리를 줄인다');
  assert.ok(NOISE.crouchWalk < NOISE.walk && NOISE.walk < NOISE.run && NOISE.run < NOISE.shot);
});

test('들리지 않는 소리는 기억되지 않는다', () => {
  const npc = createSuspect('s', { post: { x: 0, z: 0, yaw: 0, room: 'GRAND HALL' }, personality: 'defensive' });
  assert.equal(deliverNoise(npc, { x: 60, z: 60, level: NOISE.walk, type: 'walk', t: 1 }, []), false);
  assert.equal(npc.lastHeard, null);
  assert.equal(deliverNoise(npc, { x: 1, z: 1, level: NOISE.shot, type: 'shot', t: 2 }, []), true);
  assert.equal(npc.lastHeard.type, 'shot');
});

test('벽 뒤의 플레이어는 보이지 않고, 문을 열면 보인다', () => {
  const doors = closedDoors();
  const post = POSTS.find((p) => p.room === 'LIBRARY');
  const npc = createSuspect('s', { post, personality: 'defensive' });
  const world = makeWorld({ doors });
  // 대홀 쪽(문 반대편)에 서 있는 플레이어
  const door = doors.get('hall-library');
  world.players = [{ id: 'p', x: door.x + 1.2, y: 0, z: door.z, alive: true, crouch: 0, moving: 1 }];
  npc.x = door.x - 1.2; npc.z = door.z;
  npc.yaw = Math.atan2(-(world.players[0].x - npc.x), -(world.players[0].z - npc.z));
  assert.equal(spotTarget(npc, world), null, '닫힌 문은 시야를 막는다');
  doors.setState('hall-library', DOOR.OPEN);
  world.colliders = doors.colliders();
  assert.ok(spotTarget(npc, world), '열린 문으로는 보인다');
});

test('어두우면 발견이 늦다', () => {
  const target = { x: 0, z: 0, crouch: 0, moving: 1 };
  assert.ok(visibilityFactor(target, 8, 1) > visibilityFactor(target, 8, 0.1));
  assert.ok(visibilityFactor({ ...target, crouch: 1 }, 8, 1) < visibilityFactor(target, 8, 1));
  assert.ok(visibilityFactor({ ...target, sprint: 1 }, 8, 1) > visibilityFactor(target, 8, 1));
  assert.ok(brightnessAt(0, 4, [{ x: 0, y: 5, z: 4, intensity: 80, distance: 27 }]) > brightnessAt(0, 4, []));
});

test('플레이어를 보지도 듣지도 못하면 담당 자리를 지킨다 (따라오지 않는다)', () => {
  const post = POSTS.find((p) => p.room === 'GALLERY');
  const npc = createSuspect('s', { post, personality: 'defensive' });
  const world = makeWorld();
  // 플레이어는 저택 밖에 있다
  world.players = [{ id: 'p', x: 0, y: 0, z: 31, alive: true, crouch: 0, moving: 1 }];
  advance(npc, world, 12);
  assert.ok(['guard', 'patrol'].includes(npc.state), npc.state);
  assert.ok(Math.hypot(npc.x - post.x, npc.z - post.z) < 9, '담당 방을 벗어나지 않는다');
  assert.equal(zoneAt(npc.x, npc.z), 'GALLERY');
  assert.equal(world.fired.length, 0);
});

test('큰 소리는 성향에 따라 확인하러 가거나 문을 겨누고 기다린다', () => {
  const post = POSTS.find((p) => p.room === 'DINING ROOM');
  const world = makeWorld({ random: () => 0.01 });
  const pusher = createSuspect('a', { post, personality: 'aggressive' });
  pusher.lastHeard = { x: 0, z: 12, t: world.now, level: 0.7, type: 'door-kick' };
  updateSuspect(pusher, world);
  assert.equal(pusher.state, 'investigate');

  const holder = createSuspect('b', { post, personality: 'ambusher' });
  const door = world.doors.get('hall-dining');
  holder.lastHeard = { x: door.x, z: door.z, t: world.now, level: 0.7, type: 'door-kick' };
  updateSuspect(holder, world);
  assert.equal(holder.state, 'ambush');
  advance(holder, world, 4);
  assert.equal(holder.crouch, 1, '엄폐하고 몸을 낮춘다');
  assert.equal(zoneAt(holder.x, holder.z), 'DINING ROOM', '방을 나가지 않는다');
});

test('작은 소리는 그쪽을 보게만 만든다', () => {
  const post = POSTS.find((p) => p.room === 'LIBRARY');
  const npc = createSuspect('s', { post, personality: 'coward' });
  const world = makeWorld({ random: () => 0.99 });
  npc.lastHeard = { x: post.x + 3, z: post.z + 3, t: world.now, level: 0.12, type: 'walk' };
  updateSuspect(npc, world);
  assert.equal(npc.state, 'suspicious');
  assert.equal(npc.moving, 0);
});

test('점사 사이에 쉬는 시간이 있다 (연사로 즉사시키지 않는다)', () => {
  const post = { x: 0, z: 0, yaw: Math.PI, room: 'GRAND HALL' };
  const npc = createSuspect('s', { post, personality: 'aggressive' });
  const world = makeWorld({ colliders: [], random: () => 0.5 });
  world.players = [{ id: 'p', x: 0, y: 0, z: 6, alive: true, crouch: 0, moving: 0 }];
  advance(npc, world, 3);
  assert.ok(world.fired.length >= 3, '교전은 시작한다: ' + world.fired.length);
  assert.ok(world.fired.length <= 12, '3초에 12발을 넘지 않는다: ' + world.fired.length);
});

test('태세가 안 된 상태에서는 첫 발까지 시간이 걸린다', () => {
  const post = { x: 0, z: 0, yaw: Math.PI, room: 'GRAND HALL' };
  const npc = createSuspect('s', { post, personality: 'aggressive' });
  const world = makeWorld({ colliders: [], random: () => 0.5 });
  world.players = [{ id: 'p', x: 0, y: 0, z: 6, alive: true, crouch: 0, moving: 0 }];
  advance(npc, world, 0.4);
  assert.equal(world.fired.length, 0, '발견 즉시 쏘지 않는다');
  advance(npc, world, 1.2);
  assert.ok(world.fired.length > 0);
});

test('사기가 꺾이면 무기를 버리고 항복한다. 인질을 잡고 있으면 항복하지 않는다', () => {
  const post = { x: 0, z: 0, yaw: Math.PI, room: 'GRAND HALL' };
  const world = makeWorld({ colliders: [], random: () => 0.01 });
  world.players = [{ id: 'p', x: 0, y: 0, z: 5, alive: true, crouch: 0, moving: 0 }];
  world.alliesDown = 3;

  const scared = createSuspect('s', { post, personality: 'coward' });
  scared.hp = 25;
  advance(scared, world, 2.5);
  assert.equal(scared.state, 'surrender');
  assert.equal(scared.weaponDropped, true);
  assert.equal(scared.hands, 1);
  const before = world.fired.length;
  advance(scared, world, 2);
  assert.equal(world.fired.length, before, '항복한 뒤에는 쏘지 않는다');

  const holder = createSuspect('h', { post, personality: 'coward' });
  holder.hp = 25;
  holder.hostage = 'hostage';
  advance(holder, world, 3);
  assert.notEqual(holder.state, 'surrender');
});

test('사기 계산: 부상 · 동료 제압 · 섬광이 사기를 깎고 인질이 올린다', () => {
  const base = createSuspect('s', { post: { x: 0, z: 0, room: 'GRAND HALL' }, personality: 'defensive' });
  const world = makeWorld();
  const morale = (patch, extra = {}) => {
    const npc = { ...base, ...patch };
    return updateMorale(npc, { ...world, dt: 5, ...extra });
  };
  const healthy = morale({});
  assert.ok(morale({ hp: 20 }) < healthy, '부상');
  assert.ok(morale({}, { alliesDown: 3 }) < healthy, '동료 제압');
  assert.ok(morale({ blindUntil: world.now + 2000 }) < healthy, '섬광');
  assert.ok(morale({ gas: 1 }) < healthy, '가스');
  assert.ok(morale({ hostage: 'x', hp: 40 }) > morale({ hp: 40 }), '인질 보유');
});

test('명중률: 거리 · 이동 · 자세 · 제압 · 섬광을 반영한다', () => {
  const base = { skill: 0.6, distance: 8, targetMoving: false, targetSprinting: false, targetCrouch: false };
  const still = hitChance(base);
  assert.ok(hitChance({ ...base, distance: 22 }) < still);
  assert.ok(hitChance({ ...base, targetMoving: true }) < still);
  assert.ok(hitChance({ ...base, targetSprinting: true }) < hitChance({ ...base, targetMoving: true }));
  assert.ok(hitChance({ ...base, targetCrouch: true }) < still);
  assert.ok(hitChance({ ...base, suppression: 1 }) < still);
  assert.equal(hitChance({ ...base, blinded: true }), 0);
  assert.ok(still <= 0.95);
});

test('막힌 문 앞에서는 문을 열고 지나간다', () => {
  const doors = closedDoors();
  const door = doors.get('hall-gallery');
  const world = makeWorld({ doors, random: () => 0.01 });
  const npc = createSuspect('s', {
    post: { x: door.x - 1.4, z: door.z, yaw: 0, room: 'GRAND HALL' }, personality: 'aggressive',
  });
  npc.state = 'investigate';
  npc.stateUntil = world.now + 20000;
  npc.lastHeard = { x: door.x + 4, z: door.z, t: world.now, level: .8, type: 'shot' };
  advance(npc, world, 3);
  assert.ok(world.opened.includes('hall-gallery'), '문을 열었다: ' + world.opened.join(','));
  assert.ok(world.noises.some((n) => n.type === 'door'), '문 여는 소리가 났다');
});

test('민간인은 총성에 공황 상태가 되고, 구두 명령에 따른다', () => {
  const spot = { x: -22, z: 12.4, room: 'DINING ROOM' };
  const civ = createCivilian('c', spot);
  const world = makeWorld({ random: () => 0.01 });
  world.players = [{ id: 'p', x: -21, y: 0, z: 12, alive: true }];
  assert.equal(civ.state, 'calm');
  civ.lastHeard = { x: -20, z: 12, t: world.now, level: .9, type: 'shot' };
  advance(civ, world, 0.2);
  assert.ok(civ.panic > 0.5);
  assert.ok(['flee', 'hide'].includes(civ.state), civ.state);

  // 공황이 가라앉은 뒤에는 명령을 따른다 (공황 상태에서는 잘 듣지 않는다).
  civ.panic = 0.1;
  civ.commandedAt = world.now;
  world.random = () => 0.9;
  advance(civ, world, 0.2);
  assert.equal(civ.state, 'comply');
  assert.equal(civ.hands, 1);
  assert.equal(civ.moving, 0);
});

test('배치 계획: 방마다 있을 수도 없을 수도 있고, 야외에도 최소 한 명 선다', () => {
  let seeded = 0;
  const random = () => { seeded = (seeded * 1103515245 + 12345) % 2147483648; return seeded / 2147483648; };
  const outdoor = ['COURTYARD', 'WEST YARD', 'EAST YARD', 'GARDEN'];
  const emptyRoomSeen = new Set();
  for (let i = 0; i < 40; i++) {
    seeded = i;
    const plan = planOccupancy(POSTS, 6, random);
    assert.ok(plan.length > 0 && plan.length <= 6, plan.length);
    assert.ok(plan.some((p) => outdoor.includes(p.post.room)), '야외 경비');
    assert.ok(plan.every((p) => PERSONALITIES[p.personality]), '성향이 유효하다');
    // 같은 자리에 두 명이 겹치지 않는다
    assert.equal(new Set(plan.map((p) => p.post)).size, plan.length);
    const indoorRooms = ['LIBRARY', 'DRAWING ROOM', 'DINING ROOM', 'CONSERVATORY', 'GALLERY', 'GUEST SUITE'];
    for (const room of indoorRooms) {
      if (!plan.some((p) => p.post.room === room)) emptyRoomSeen.add(room);
    }
  }
  assert.ok(emptyRoomSeen.size >= 4, '빈 방이 생긴다: ' + [...emptyRoomSeen].join(','));
});

test('시야각 밖은 보지 못한다 (등 뒤는 아주 가까울 때만)', () => {
  const observer = { x: 0, z: 0, yaw: 0 };          // -Z 를 본다
  assert.equal(inFieldOfView(observer, { x: 0, z: -10 }, Math.PI * .78), true);
  assert.equal(inFieldOfView(observer, { x: 0, z: 10 }, Math.PI * .78), false);
  assert.equal(inFieldOfView(observer, { x: 0, z: 2 }, Math.PI * .78), true, '2m 는 인지');
  assert.equal(hasClearShot({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -5 }, 1.3,
    [{ x: 0, z: -2, w: 4, d: .4, h: 3 }]), false);
});

test('용의자는 벽 너머 플레이어 위치를 알 수 없다', () => {
  const source = COLLIDERS.filter((c) => c.kind === 'wall');
  const post = POSTS.find((p) => p.room === 'GUEST SUITE');
  const npc = createSuspect('s', { post, personality: 'aggressive' });
  const world = makeWorld({ colliders: source });
  world.players = [{ id: 'p', x: -16.5, y: 0, z: -12, alive: true, crouch: 0, moving: 1 }];
  advance(npc, world, 6);
  assert.equal(npc.targetId, null);
  assert.equal(world.fired.length, 0);
  assert.ok(['guard', 'patrol'].includes(npc.state));
});

/* ========================================================================== *
 *  구두 경고 (V)
 *
 *  버튼을 눌러도 아무 일이 없으면 고장 난 것과 같다. 반대로 항상 항복하면
 *  경고 한 번으로 판이 끝난다. 확률이 상황에 따라 움직이는지 확인한다.
 * ========================================================================== */
test('겨누고 외치면 항복 확률이 오르고, 멀리서 소리만 지르면 거의 오르지 않는다', () => {
  const post = POSTS.find((p) => p.room === 'GALLERY');
  const npc = createSuspect('s', { post, personality: 'defensive' });
  npc.morale = 0.5;

  const aimed = surrenderChance(npc, { aimed: true, distance: 3 });
  const shouted = surrenderChance(npc, { aimed: false, distance: 3 });
  const faraway = surrenderChance(npc, { aimed: true, distance: 12 });
  assert.ok(aimed > shouted * 2, `겨눈 쪽이 훨씬 높아야 한다: ${aimed} vs ${shouted}`);
  assert.ok(aimed > faraway, `가까울수록 높아야 한다: ${aimed} vs ${faraway}`);

  // 다치고 동료가 쓰러졌고 계속 눌린 상태면 확실히 더 높다.
  const cornered = createSuspect('s2', { post, personality: 'defensive' });
  cornered.morale = 0.3; cornered.hp = 40; cornered.pressure = 1;
  assert.ok(surrenderChance(cornered, { aimed: true, distance: 3, alliesDown: 3 }) > aimed);

  // 인질을 잡고 있으면 통하지 않는다.
  const holder = createSuspect('hvt', { post, personality: 'leader', kind: 'hvt' });
  holder.hostage = 'hostage';
  assert.equal(surrenderChance(holder, { aimed: true, distance: 2 }), 0);
});

test('경고 결과: 항복 / 반항 / 흔들림이 모두 일어나고, 인질범은 응하지 않는다', () => {
  const post = POSTS.find((p) => p.room === 'GALLERY');
  const from = { id: 'p1', x: post.x, z: post.z + 3 };

  // 주사위가 낮으면 항복한다.
  const yields = createSuspect('a', { post, personality: 'coward' });
  yields.morale = 0.2;
  const luckyWorld = makeWorld({ random: () => 0.01 });
  assert.equal(warnSuspect(yields, luckyWorld, { aimed: true, distance: 3, from }), 'surrender');
  assert.equal(yields.state, 'surrender');
  assert.equal(yields.hands, 1);
  assert.equal(yields.weaponDropped, true);

  // 주사위가 중간이면 오히려 덤빈다. 이때 나를 목표로 삼는다.
  const fighter = createSuspect('b', { post, personality: 'aggressive' });
  const unluckyWorld = makeWorld({ random: () => 0.35 });
  assert.equal(warnSuspect(fighter, unluckyWorld, { aimed: true, distance: 3, from }), 'defy');
  assert.equal(fighter.state, 'engage');
  assert.equal(fighter.targetId, 'p1');

  // 주사위가 높으면 흔들리기만 한다. 압박은 남는다.
  const shaken = createSuspect('c', { post, personality: 'defensive' });
  const coldWorld = makeWorld({ random: () => 0.99 });
  assert.equal(warnSuspect(shaken, coldWorld, { aimed: true, distance: 3, from }), 'shaken');
  assert.ok(shaken.pressure > 0.4, '압박이 쌓인다');

  // 같은 사람에게 연달아 외쳐도 쿨다운 안에는 다시 통하지 않는다.
  assert.equal(warnSuspect(shaken, coldWorld, { aimed: true, distance: 3, from }), 'ignored');

  // 인질을 잡은 자는 무슨 수를 써도 응하지 않는다.
  const holder = createSuspect('hvt', { post, personality: 'leader', kind: 'hvt' });
  holder.hostage = 'hostage';
  assert.equal(warnSuspect(holder, luckyWorld, { aimed: true, distance: 2, from }), 'defy');
  assert.notEqual(holder.state, 'surrender');
});

test('경고로 쌓인 압박은 사기를 깎고, 시간이 지나면 풀린다', () => {
  const post = POSTS.find((p) => p.room === 'GALLERY');
  const npc = createSuspect('s', { post, personality: 'defensive' });
  const world = makeWorld({ random: () => 0.99 });

  warnSuspect(npc, world, { aimed: true, distance: 3 });
  const pressured = npc.pressure;
  assert.ok(pressured > 0);

  const calm = createSuspect('t', { post, personality: 'defensive' });
  updateMorale(calm, { ...world, dt: 1, alliesDown: 0, alliesNear: 0 });
  updateMorale(npc, { ...world, dt: 1, alliesDown: 0, alliesNear: 0 });
  assert.ok(npc.morale < calm.morale, '겨눠진 쪽의 사기가 낮다');

  advance(npc, world, WARNING.cooldown / 1000 + 8);
  assert.ok(npc.pressure < pressured * 0.35, `시간이 지나면 풀린다: ${npc.pressure}`);
});
