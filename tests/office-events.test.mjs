/* =============================================================================
 *  office-events.test.mjs  -  사무실 맵의 새 장치들
 *
 *  초소(와 그 위의 저격수) · 스프링클러 · "정전 없음". 셋 다 맵 데이터와 서버
 *  상태만으로 확인할 수 있는 것들이라, 브라우저 없이 여기서 본다.
 *
 *  특히 보고 싶은 것은 "초소가 불공평하지 않은가" 다. 발판이 높으면 시작
 *  지점까지 보일 수 있고, 그러면 아무것도 못 한 대원이 첫 몇 초에 죽는다.
 * ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMap, setActiveMap, resolveCircle, groundHeight, moveBody, ceilingAt,
} from '../public/js/map-data.js';
import { hasClearShot, forwardOf } from '../public/js/perception.js';
import {
  createSuspect, updateSuspect, planOccupancy, SUSPECT_EYE, ROLES,
} from '../public/js/suspect-ai.js';
import { resetPower, powerCutDue } from '../public/js/power-state.js';
import { objectiveState, objectiveReport } from '../public/js/objectives.js';
import { Room } from '../server.js';
import {
  pullAlarm, tripSprinklerAt, updateSprinklers, wetAt, SPRINKLER_DELAY_MS, SPRINKLER_MS,
} from '../server/events.js';
import { emitNoise } from '../server/util.js';
import { makeWorld } from '../server/world.js';

const OFFICE = getMap('office');
const MANSION = getMap('mansion');

/** 씨앗을 주는 난수. 같은 씨앗이면 같은 판이 나와야 원인을 되짚을 수 있다. */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 이벤트를 모아 두는 가짜 io. */
function recorder() {
  const events = [];
  return { events, io: { to: () => ({ emit: (name, data) => events.push({ name, data }) }) } };
}

test('사무실에는 정전이 없다 (저택은 그대로다)', () => {
  assert.equal(OFFICE.BLACKOUT, false);
  assert.equal(OFFICE.BACKUP_GENERATOR, null);
  assert.notEqual(MANSION.BLACKOUT, false);
  assert.ok(MANSION.BACKUP_GENERATOR, '저택의 예비 발전기는 그대로 있어야 한다');

  setActiveMap('office');
  try {
    // 실내에 들어가 한참을 서 있어도 두꺼비집이 내려가지 않는다.
    const room = { phase: 1, standingPlayers: [{ x: 0, z: 0 }], suspects: [] };
    resetPower(room);
    for (const t of [1000, 20000, 60000, 600000]) {
      assert.equal(powerCutDue(room, t), false, `${t}ms 에 정전이 예약됐다`);
    }
    assert.equal(room.powerCutDone, false);
    // 그러니 "예비 발전기 가동" 이라는 보너스 목표도 뜨지 않는다.
    const report = objectiveReport({
      phase: 1, powerCutDone: false, objectiveDone: new Set(),
      suspects: [], civilians: [], npcs: [], sites: [], evidence: [],
      standingPlayers: [], flags: {}, stats: {}, generatorStarted: false,
    });
    assert.equal(report.list.some((o) => o.id === 'generator'), false);
  } finally {
    setActiveMap('mansion');
  }
});

test('사무실 목표와 브리핑이 사옥 문구로 나온다', () => {
  setActiveMap('office');
  try {
    const report = objectiveReport({
      phase: 0, powerCutDone: false, objectiveDone: new Set(),
      suspects: [], civilians: [], npcs: [], sites: [], evidence: [],
      standingPlayers: [], flags: {}, stats: {},
    });
    const breach = report.list.find((o) => o.id === 'breach');
    assert.match(breach.label, /사옥/, `"${breach.label}" 에 저택이 남아 있다`);
    assert.doesNotMatch(report.hint, /정전/, '정전이 없는 맵인데 안내가 정전을 말한다');
  } finally {
    setActiveMap('mansion');
  }
  // 저택은 저택 문구 그대로.
  const mansionReport = objectiveReport({
    phase: 0, powerCutDone: false, objectiveDone: new Set(),
    suspects: [], civilians: [], npcs: [], sites: [], evidence: [],
    standingPlayers: [], flags: {}, stats: {},
  });
  assert.match(mansionReport.list.find((o) => o.id === 'breach').label, /저택/);
});

test('초소 위에 설 수 있고, 계단으로 걸어 올라갈 수 있다', () => {
  setActiveMap('office');
  try {
    assert.equal(OFFICE.GARRISON.length, 2, '초소 저격수는 둘이다');
    for (const entry of OFFICE.GARRISON) {
      const p = entry.post;
      assert.ok(p.y > OFFICE.MAP.fenceHeight,
        `발판(${p.y}m)이 담장(${OFFICE.MAP.fenceHeight}m)보다 낮으면 초소가 아니다`);
      // 발판 위에 몸이 들어간다 (난간이나 지붕 기둥에 끼지 않는다).
      const fixed = resolveCircle(p.x, p.z, 0.38, OFFICE.COLLIDERS, p.y, 1.7);
      assert.ok(Math.hypot(fixed.x - p.x, fixed.z - p.z) < 0.02,
        `${entry.id} 가 초소 구조물에 밀려난다`);
      // 발밑이 실제로 발판이다 (허공이 아니다).
      assert.equal(groundHeight(p.x, p.z, 0.38, OFFICE.COLLIDERS, p.y), p.y);
      /* 담당 방향이 트여 있다. 지붕 상자가 눈높이까지 내려와 있으면 여기서
       * 걸린다 - 상자 안에 눈이 들어간 저격수는 아무것도 못 본다. */
      const fwd = forwardOf(p.yaw);
      assert.ok(hasClearShot(
        { x: p.x, y: p.y + SUSPECT_EYE, z: p.z },
        { x: p.x + fwd.x * 10, y: 0, z: p.z + fwd.z * 10 },
        1.3, OFFICE.COLLIDERS), `${entry.id} 의 눈앞이 막혀 있다`);
    }

    // 야외에는 천장이 없다. 있으면 발판 높이에서 몸이 눌려 내려온다.
    assert.ok(ceilingAt(-51, -2) > 5.2, '야외 천장이 초소보다 낮다');
    assert.equal(ceilingAt(0, 0), OFFICE.MAP.height, '실내 천장은 그대로여야 한다');

    // 서측 초소 계단을 걸어 올라간다.
    let pos = { x: -51, y: 0, z: 7.5 };
    let vel = { x: 0, y: 0, z: 0 };
    let grounded = true;
    for (let i = 0; i < 400 && pos.y < 3.2; i++) {
      vel.x = 0; vel.z = -2.6;
      const step = moveBody(pos, vel, 1 / 60,
        { radius: 0.32, height: 1.8, stepHeight: 0.32, grounded }, OFFICE.COLLIDERS);
      pos = step.pos; vel = step.vel; grounded = step.onGround;
    }
    assert.ok(pos.y >= 3.2, `계단을 다 오르지 못했다 (${pos.y.toFixed(2)}m 에서 멈췄다)`);
    // 발판 안쪽까지 걸어 들어가고, 거기서도 발이 3.2m 에 있다.
    for (let i = 0; i < 90; i++) {
      vel.x = 0; vel.z = -2.6;
      const step = moveBody(pos, vel, 1 / 60,
        { radius: 0.32, height: 1.8, stepHeight: 0.32, grounded }, OFFICE.COLLIDERS);
      pos = step.pos; vel = step.vel; grounded = step.onGround;
    }
    assert.ok(Math.abs(pos.z + 2) < 2, `발판 위가 아니라 (${pos.z.toFixed(2)}) 에 서 있다`);
    assert.ok(pos.y >= 3.2, '발판 위에서 떨어졌다');
  } finally {
    setActiveMap('mansion');
  }
});

test('초소 저격수는 시작 지점을 볼 수 없다', () => {
  setActiveMap('office');
  try {
    for (const entry of OFFICE.GARRISON) {
      const eye = { x: entry.post.x, y: entry.post.y + SUSPECT_EYE, z: entry.post.z };
      for (const spawn of OFFICE.SPAWNS) {
        assert.equal(
          hasClearShot(eye, { x: spawn.x, y: 0, z: spawn.z }, 1.3, OFFICE.COLLIDERS), false,
          `${entry.id} 가 시작 지점 (${spawn.x}, ${spawn.z}) 을 정면으로 본다`);
      }
      // 사거리 안이어도 건물 너머는 안 보인다 (지붕 콜라이더).
      assert.equal(hasClearShot(eye, { x: -entry.post.x, y: 0, z: -entry.post.z }, 1.3, OFFICE.COLLIDERS),
        false, `${entry.id} 의 총알이 건물 위를 넘어간다`);
    }
  } finally {
    setActiveMap('mansion');
  }
});

test('저격수는 멀리 보고, 한 발씩 쏘고, 자리를 뜨지 않는다', () => {
  const spec = ROLES.marksman;
  const sniper = createSuspect('s', {
    post: { x: -51, y: 3.2, z: -2, yaw: Math.PI, room: 'WEST LOT' },
    personality: 'ambusher', role: 'marksman', hp: 90,
  });
  assert.equal(sniper.y, 3.2, '발판 높이를 그대로 들고 있어야 한다');
  assert.equal(sniper.view, spec.view);
  assert.ok(sniper.view > 40, '보통 경비(20m)보다 확실히 멀리 봐야 한다');
  assert.equal(sniper.burstSize, 1);
  assert.ok(sniper.fireGap > 2000, '연사하면 초소가 기관총좌가 된다');
  assert.ok(sniper.damage > 30 && sniper.damage < 60, '한 발에 즉사하거나 간지럽거나 둘 다 곤란하다');
  assert.equal(sniper.anchored, true);
  // 보통 경비는 아무것도 달라지지 않는다.
  const guard = createSuspect('g', { post: { x: 0, z: 0 }, personality: 'defensive' });
  assert.equal(guard.anchored, false);
  assert.equal(guard.damage, null);
  assert.equal(guard.y, 0);
});

test('저격수는 초소를 지키며 먼 표적을 한 발씩 쏜다', () => {
  setActiveMap('office');
  try {
    const entry = OFFICE.GARRISON[0];
    const sniper = createSuspect(entry.id, {
      post: { ...entry.post }, personality: entry.personality, role: entry.role, hp: 90,
    });
    // 발판 앞 20m. 보통 경비라면 아예 안 보이는 거리다.
    const target = {
      id: 'p1', x: entry.post.x, y: 0, z: entry.post.z + 20,
      alive: true, crouch: false, moving: true, sprint: false, hp: 100,
    };
    const fired = [];
    const world = {
      now: 100000, dt: 0.05, colliders: OFFICE.COLLIDERS, doors: null,
      players: [target], skillScale: 1, alliesDown: 0, alliesNear: 0,
      random: () => 0.5, brightness: () => 1,
      playerById: () => target, nearestPlayer: () => target,
      route: () => [], doorNear: () => false, roamPoint: () => null,
      hideSpot: () => ({ x: 0, z: 0 }), fallbackPoint: () => ({ x: 0, z: 0 }),
      openDoor: () => {}, noise: () => {},
      fire: (npc, t, hit) => fired.push({ hit }),
      onStateChange: () => {}, onContact: () => {}, onSurrender: () => {}, onDefy: () => {},
    };
    const start = { x: sniper.x, y: sniper.y, z: sniper.z };
    for (let t = 0; t < 6; t += 0.05) {
      world.now += 50;
      updateSuspect(sniper, world);
    }
    assert.equal(sniper.state, 'engage', `20m 앞의 표적을 못 봤다 (state ${sniper.state})`);
    assert.ok(fired.length > 0, '보고도 쏘지 않았다');
    // 6초 동안 두세 발. 연사하면 초소가 기관총좌가 된다.
    assert.ok(fired.length <= 4, `6초에 ${fired.length}발은 저격수가 아니다`);
    assert.equal(sniper.y, start.y, '발판에서 내려왔다');
    assert.ok(Math.hypot(sniper.x - start.x, sniper.z - start.z) < 0.01,
      '자리를 떠나 걸어다닌다');
  } finally {
    setActiveMap('mansion');
  }
});

test('화재경보기를 당기면 그 구역 스프링클러가 돌고, 물이 소리와 시야를 덮는다', () => {
  const room = new Room('WET', 'office');
  const { events, io } = recorder();
  const alarm = OFFICE.ALARMS.find((a) => a.id === 'alarmN');
  const zone = OFFICE.SPRINKLERS.find((s) => s.id === alarm.zone);
  assert.ok(zone, '경보기가 없는 구역을 가리킨다');

  assert.equal(pullAlarm(room, alarm.id, 'me', io), true);
  // 물은 바로 나오지 않는다. 경보가 먼저 울고 2.5초 뒤다.
  updateSprinklers(room, io);
  assert.equal(wetAt(room, zone.area.x, zone.area.z), false);
  room.sprinklerAt.set(zone.id, Date.now() - 1);
  updateSprinklers(room, io);

  const started = events.find((e) => e.name === 'sprinklerStarted');
  assert.ok(started, 'sprinklerStarted 가 안 나갔다');
  assert.equal(started.data.id, zone.id);
  assert.equal(started.data.seconds, SPRINKLER_MS / 1000);
  assert.ok(started.data.heads.length > 0, '천장 헤드 자리가 실려야 화면에 물이 나온다');
  assert.ok(SPRINKLER_DELAY_MS > 0);

  // 젖은 구역과 안 젖은 구역
  assert.equal(wetAt(room, zone.area.x, zone.area.z), true);
  assert.equal(wetAt(room, 0, 24), false, '남쪽 구역까지 젖으면 안 된다');

  // 물속에서 난 소리는 절반만 전달된다.
  room.npcs = [];
  const loud = emitNoise(room, 0, 24, 1.0, 'shot', null);
  const muffled = emitNoise(room, zone.area.x, zone.area.z, 1.0, 'shot', null);
  assert.equal(loud.level, 1.0);
  assert.ok(muffled.level < loud.level * 0.75,
    `물속 소리가 ${muffled.level} 로 거의 안 줄었다`);

  // 시간이 지나면 멎는다.
  room.sprinklerUntil.set(zone.id, Date.now() - 1);
  updateSprinklers(room, io);
  assert.ok(events.some((e) => e.name === 'sprinklerStopped' && e.data.id === zone.id));
  assert.equal(wetAt(room, zone.area.x, zone.area.z), false);
});

/* 경보기 손잡이를 못 찾아도 물은 한 번은 돈다.
 *
 *  "스프링클러를 어떻게 쓰는지 모르겠다" 가 이 장치의 실제 증상이었다. 벽에
 *  붙은 작은 손잡이를 아무도 못 찾으면 사옥의 절반짜리 장치가 한 판도 안 쓰인다.
 *  그래서 회수와 해체에도 물려 두었다. */
test('증거 회수와 장치 해체가 그 구역 소화 설비를 돌린다', () => {
  const room = new Room('AUTO', 'office');
  const { events, io } = recorder();
  const ledger = OFFICE.EVIDENCE_SPOTS.find((e) => e.id === 'ledger');   // 자료보관실 · 북측
  const north = OFFICE.SPRINKLERS.find((s) => s.id === 'north');

  const zone = tripSprinklerAt(room, ledger.x, ledger.z, io, '이중 장부 회수');
  assert.equal(zone?.id, north.id, '자료보관실은 북측 방화구역이다');
  assert.ok(events.some((e) => e.name === 'radio' && /소화 설비/.test(e.data.text)),
    '무슨 일이 난 건지 알려 주지 않으면 화면이 고장 난 것처럼 보인다');

  // 물이 나오기까지는 경보기를 당겼을 때와 똑같이 뜸을 들인다.
  assert.equal(wetAt(room, ledger.x, ledger.z), false);
  room.sprinklerAt.set(north.id, Date.now() - 1);
  updateSprinklers(room, io);
  assert.equal(wetAt(room, ledger.x, ledger.z), true);

  // 이미 도는 구역을 다시 켜지는 않는다 (증거 셋이 한 방에 몰려 있을 수 있다).
  assert.equal(tripSprinklerAt(room, ledger.x, ledger.z, io, '두 번째'), null);

  // 구역 밖(마당)에서는 아무 일도 안 난다. 저택에서도 마찬가지다.
  assert.equal(tripSprinklerAt(room, 0, 45, io, '광장'), null);
  assert.equal(tripSprinklerAt(new Room('DRY2', 'mansion'), 0, 0, io, '저택'), null);
});

/* 배치가 맵의 마당 이름을 실제로 읽는가.
 *
 *  planOccupancy 가 저택의 마당 이름 넷('COURTYARD' 따위)을 상수로 들고
 *  있었다. 사무실에서는 하나도 안 맞아서 광장·주차장·하역장이 전부 "실내" 로
 *  분류됐다 - 바깥 경비를 먼저 세우는 규칙도, 첫 경비를 방어형으로 두는 완화도
 *  사옥에서는 아예 걸리지 않았다. */
test('사무실에서도 바깥 경비가 먼저 서고, 한 방에 몰리지 않는다', () => {
  setActiveMap('office');
  try {
    const outdoor = new Set(OFFICE.OUTDOOR_AREAS.map((a) => a.name));
    let withGuard = 0;
    for (let seed = 0; seed < 40; seed++) {
      const random = mulberry(seed + 1);
      const plan = planOccupancy(OFFICE.POSTS, 6, random);
      assert.ok(plan.length > 0 && plan.length <= 6);
      assert.equal(new Set(plan.map((p) => p.post)).size, plan.length, '같은 자리에 두 명이 겹친다');
      if (plan.some((p) => outdoor.has(p.post.room))) withGuard++;
      // 한 구역에 세 명 이상 몰리면 나머지 열일곱 칸이 텅 빈다.
      const perRoom = new Map();
      for (const p of plan) perRoom.set(p.post.room, (perRoom.get(p.post.room) || 0) + 1);
      for (const [name, n] of perRoom) assert.ok(n <= 2, `${name} 에 ${n}명이 몰렸다`);
    }
    assert.ok(withGuard >= 30, `40판 중 ${withGuard}판에만 바깥 경비가 섰다`);
  } finally {
    setActiveMap('mansion');
  }
});

/* 방을 안 옮겨 다니는 경비가 사옥에서는 "영원히 못 찾는 한 명" 이 된다.
 *
 *  저택은 방이 여섯 칸이라 한 방 안을 도는 것으로 충분했다. 열여덟 칸에서는
 *  아니다 - 마지막 한 명이 어느 구석에 서 있으면 방을 처음부터 다시 다 열어야
 *  한다. 대신 경계 하나는 지켜야 한다: 마당 사람이 건물로 들어가 버리면
 *  1단계(외곽 무장 인원 정리)를 건물 안에서 끝내야 하는 일이 생긴다. */
test('순찰은 옆방까지 나가되, 마당과 건물 사이를 넘지 않는다', () => {
  const room = new Room('ROAM', 'office');
  const { io } = recorder();
  const world = makeWorld(room, 0.05, io);
  const outdoor = new Set(OFFICE.OUTDOOR_AREAS.map((a) => a.name));

  const sample = (from, npc, times = 400) => {
    const seen = new Set();
    for (let i = 0; i < times; i++) {
      const spot = world.roamPoint(from, npc);
      if (spot) seen.add(spot.room);
    }
    return seen;
  };

  const inside = sample('DEV WEST', { x: -22, z: -6.75, room: 'DEV WEST' });
  assert.ok(inside.size > 1, `개발실 서편에서 한 방 안만 돈다: ${[...inside]}`);
  for (const name of inside) {
    assert.equal(outdoor.has(name), false, `건물 안 경비가 마당(${name})으로 나간다`);
  }

  const yard = sample('NORTH YARD', { x: 0, z: -41, room: 'NORTH YARD' });
  for (const name of yard) {
    assert.equal(outdoor.has(name), true, `마당 경비가 건물 안(${name})으로 들어간다`);
  }

  // 자리에 묶인 초소 저격수는 애초에 순찰을 걸지 않는다.
  assert.equal(createSuspect('x', { post: OFFICE.GARRISON[0].post, role: 'marksman' }).anchored, true);
});

test('순찰을 마치면 그 자리를 새 담당 자리로 삼는다', () => {
  const from = OFFICE.POSTS.find((p) => p.room === 'DESIGN');
  const to = OFFICE.POSTS.find((p) => p.room === 'DESIGN' && p !== from);
  setActiveMap('office');
  try {
    const npc = createSuspect('walker', { post: from, personality: 'aggressive' });
    npc.state = 'patrol';
    npc.roam = to;
    npc.stateUntil = 1e15;
    const world = {
      now: 1000, dt: 0.05, colliders: [], players: [], random: () => 0.5,
      skillScale: 1, alliesDown: 0, alliesNear: 0, brightness: () => 1,
      playerById: () => null, route: () => [], doorNear: () => false,
      roamPoint: () => null, hideSpot: () => null, fallbackPoint: () => null,
      doors: { blockingBetween: () => null, colliders: () => [] },
      noise: () => {}, fire: () => {},
    };
    for (let i = 0; i < 2000 && npc.state === 'patrol'; i++) {
      world.now += 50;
      updateSuspect(npc, world);
    }
    assert.equal(npc.state, 'guard');
    assert.ok(Math.hypot(npc.post.x - to.x, npc.post.z - to.z) < 0.8,
      '도착한 자리를 담당 자리로 삼지 않으면 guard 가 곧바로 원래 자리로 되돌려 보낸다');
    assert.equal(npc.room, 'DESIGN');
  } finally {
    setActiveMap('mansion');
  }
});

test('스프링클러 구역이 건물 안을 빠짐없이 덮는다', () => {
  setActiveMap('office');
  try {
    const ids = new Set(OFFICE.SPRINKLERS.map((s) => s.id));
    assert.equal(ids.size, OFFICE.SPRINKLERS.length, '구역 id 가 겹친다');
    for (const alarm of OFFICE.ALARMS) {
      assert.ok(ids.has(alarm.zone), `${alarm.id} 가 없는 구역 ${alarm.zone} 을 가리킨다`);
    }
    for (const zone of OFFICE.SPRINKLERS) {
      assert.ok(zone.heads.length >= 6, `${zone.id} 의 헤드가 ${zone.heads.length}개뿐이다`);
      for (const [hx, hz] of zone.heads) {
        assert.ok(Math.abs(hx - zone.area.x) <= zone.area.w / 2
          && Math.abs(hz - zone.area.z) <= zone.area.d / 2,
        `${zone.id} 의 헤드 (${hx}, ${hz}) 가 제 구역 밖에 달렸다`);
        assert.ok(OFFICE.isIndoors(hx, hz), `헤드 (${hx}, ${hz}) 가 건물 밖이다`);
      }
    }
    // 어느 방에 서 있어도 머리 위 어딘가에는 스프링클러가 있다.
    const covered = (x, z) => OFFICE.SPRINKLERS.some((s) =>
      Math.abs(x - s.area.x) <= s.area.w / 2 && Math.abs(z - s.area.z) <= s.area.d / 2);
    for (const room of [...OFFICE.ROOMS, ...OFFICE.CORRIDORS]) {
      assert.ok(covered(room.x, room.z), `${room.name} 위에 스프링클러가 없다`);
    }
    // 저택에는 아예 없다. 없어도 서버가 돌아야 한다.
    const dry = new Room('DRY', 'mansion');
    assert.equal(wetAt(dry, 0, 0), false);
    updateSprinklers(dry, recorder().io);
  } finally {
    setActiveMap('mansion');
  }
});
