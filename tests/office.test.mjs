/* =============================================================================
 *  office.test.mjs  -  사무실 맵이 실제로 굴러가는가
 *
 *  방을 늘리는 것은 쉽고, 그 방에 사람이 설 수 있게 하는 것은 어렵다. 여기서
 *  보는 것은 대부분 후자다: 스폰·경비 자리·민간인 자리·증거·폭발물이 벽이나
 *  가구 속에 파묻혀 있지 않은지, 어느 방에서든 걸어서 갈 수 있는지.
 *
 *  wall-sections.test.mjs / decor.test.mjs 가 저택에 대해 하던 검사를 사무실에
 *  대해서도 하고, 저택 쪽 수치가 그대로인지도 같이 본다 (레지스트리로 바꾸면서
 *  기본 맵이 뒤바뀌는 사고를 막는 자리다).
 * ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAPS, getMap, setActiveMap, CURRENT_MAP, DEFAULT_MAP_ID,
  resolveCircle, findRoute, zoneAt, isIndoors, WALLS, ROOMS, COLLIDERS,
} from '../public/js/map-data.js';
import { OFFICE_BANDS, wallSections } from '../public/js/wall-sections.js';

const OFFICE = getMap('office');
const MANSION = getMap('mansion');

/** 반지름 r 짜리 몸이 그 자리에 설 수 있는가 (밀려나면 못 서는 것이다).
 *
 *  ⚠ resolveCircle 은 콜라이더는 인자로 받지만 부지 경계는 "지금 켜진 맵" 에서
 *  가져온다. 저택(88×88)이 켜진 채로 사무실(112×104) 좌표를 넣으면 경계에
 *  걸려 밀려나므로, 부르는 쪽이 맵을 켜 두어야 한다. */
function standable(map, x, z, r = 0.45) {
  const fixed = resolveCircle(x, z, r, map.COLLIDERS, 0, 1.7);
  return Math.hypot(fixed.x - x, fixed.z - z) <= 0.02;
}

test('레지스트리에 두 맵이 등록돼 있고, 기본은 저택이다', () => {
  assert.deepEqual(MAPS.map((m) => m.id), ['mansion', 'office']);
  assert.equal(DEFAULT_MAP_ID, 'mansion');
  assert.equal(CURRENT_MAP.id, 'mansion', '모듈을 읽은 직후에는 저택이 켜져 있다');
  assert.equal(getMap('없는맵').id, 'mansion', '모르는 id 는 기본 맵으로 내려간다');
});

test('맵을 갈아 끼우면 내보내는 데이터가 통째로 따라 바뀐다', () => {
  const mansionWalls = WALLS.length, mansionRooms = ROOMS.length;
  assert.equal(setActiveMap('office'), true);
  try {
    assert.equal(CURRENT_MAP.id, 'office');
    assert.equal(WALLS.length, OFFICE.WALLS.length);
    assert.equal(ROOMS.length, OFFICE.ROOMS.length);
    assert.equal(COLLIDERS.length, OFFICE.COLLIDERS.length);
    assert.notEqual(WALLS.length, mansionWalls, '두 맵의 벽 수가 같으면 이 검사는 아무것도 못 본다');
    assert.equal(zoneAt(0, 0), 'ATRIUM', '켜진 맵의 구역표를 쓴다');
    assert.equal(isIndoors(0, 0), true);
    assert.equal(isIndoors(0, 45), false, '광장은 실외다');
    assert.equal(setActiveMap('office'), false, '같은 맵이면 다시 켜지 않는다');
  } finally {
    setActiveMap('mansion');
  }
  assert.equal(WALLS.length, mansionWalls, '되돌리면 저택 값으로 돌아온다');
  assert.equal(ROOMS.length, mansionRooms);
  assert.equal(zoneAt(0, 0), 'GRAND HALL');
});

test('사무실은 저택보다 넓고 방이 많다', () => {
  assert.ok(OFFICE.ROOMS.length > MANSION.ROOMS.length,
    `방 ${OFFICE.ROOMS.length}칸은 저택 ${MANSION.ROOMS.length}칸보다 많아야 한다`);
  const area = (m) => (m.MAP.interior.maxX - m.MAP.interior.minX) * (m.MAP.interior.maxZ - m.MAP.interior.minZ);
  assert.ok(area(OFFICE) > area(MANSION) * 1.4,
    `실내 면적 ${area(OFFICE)} 는 저택 ${area(MANSION)} 보다 확실히 넓어야 한다`);
  // 층고는 반대로 낮다. 이것이 두 맵의 교전 거리를 다르게 만든다.
  assert.ok(OFFICE.MAP.height < MANSION.MAP.height / 1.5);
});

test('사무실의 모든 배치 지점에 사람이 설 수 있다', () => {
  setActiveMap('office');
  try {
  const groups = [
    ['SPAWNS', OFFICE.SPAWNS],
    ['POSTS', OFFICE.POSTS],
    ['CIVILIAN_SPOTS', OFFICE.CIVILIAN_SPOTS],
    ['BOMB_SITES', OFFICE.BOMB_SITES],
  ];
  for (const [label, list] of groups) {
    const buried = list.filter((p) => !standable(OFFICE, p.x, p.z));
    assert.deepEqual(buried, [], `${label} 가 벽/가구에 파묻혔다`);
  }
  // 증거는 바닥에 놓인 작은 물건이라 조금 좁은 자리도 된다.
  const buriedEvidence = OFFICE.EVIDENCE_SPOTS.filter((e) => !standable(OFFICE, e.x, e.z, 0.32));
  assert.deepEqual(buriedEvidence, [], '증거가 가구 속에 들어가 있다');

  /* 경보기는 벽에 붙은 설비다. 그 자리에 설 수 있을 필요는 없고, 손이 닿는
   * 거리(INTERACT_RANGE 2.0m)에 설 자리가 있으면 된다. */
  const unreachable = OFFICE.ALARMS.filter((a) => {
    for (let r = 0.8; r <= 1.8; r += 0.2) {
      for (let i = 0; i < 16; i++) {
        const t = (i / 16) * Math.PI * 2;
        if (standable(OFFICE, a.x + Math.cos(t) * r, a.z + Math.sin(t) * r)) return false;
      }
    }
    return true;
  });
  assert.deepEqual(unreachable.map((a) => a.id), [], '손이 닿지 않는 경보기가 있다');
  } finally {
    setActiveMap('mansion');
  }
});

test('사무실의 자리와 이름표가 어긋나지 않는다', () => {
  setActiveMap('office');
  try {
    for (const list of [OFFICE.POSTS, OFFICE.CIVILIAN_SPOTS, OFFICE.EVIDENCE_SPOTS, OFFICE.BOMB_SITES]) {
      for (const p of list) {
        if (!p.room) continue;
        assert.equal(zoneAt(p.x, p.z), p.room,
          `(${p.x}, ${p.z}) 는 ${p.room} 이라고 적혀 있는데 실제로는 ${zoneAt(p.x, p.z)} 다`);
      }
    }
    // 주범이 들어갈 수 있다고 적힌 방은 실제로 있는 방이어야 한다.
    const names = new Set(OFFICE.ROOMS.map((r) => r.name));
    for (const room of OFFICE.HVT_ROOMS) assert.ok(names.has(room), `${room} 라는 방이 없다`);
    // 그 방마다 주범이 설 자리도 있어야 한다.
    for (const room of OFFICE.HVT_ROOMS) {
      assert.ok(OFFICE.POSTS.some((p) => p.room === room), `${room} 에 경비 자리가 없다`);
    }
  } finally {
    setActiveMap('mansion');
  }
});

test('사무실은 스폰에서 모든 방과 목표로 걸어갈 수 있다', () => {
  setActiveMap('office');
  try {
    const from = OFFICE.SPAWNS[0];
    const targets = [
      ...OFFICE.ROOMS.map((r) => ({ label: r.name, x: r.x, z: r.z })),
      ...OFFICE.BOMB_SITES.map((s) => ({ label: `폭발물 ${s.id}`, x: s.x, z: s.z })),
      ...OFFICE.EVIDENCE_SPOTS.map((e) => ({ label: e.label, x: e.x, z: e.z })),
      { label: '철수 지점', x: OFFICE.EXTRACTION.x, z: OFFICE.EXTRACTION.z },
    ];
    const blocked = targets.filter((t) => findRoute(from, t).length === 0);
    assert.deepEqual(blocked.map((t) => t.label), [], '스폰에서 갈 수 없는 곳이 있다');
  } finally {
    setActiveMap('mansion');
  }
});

test('사무실의 문은 서로 다른 두 구역을 잇는다', () => {
  const names = new Set([
    ...OFFICE.ROOMS.map((r) => r.name),
    ...OFFICE.CORRIDORS.map((r) => r.name),
    ...OFFICE.OUTDOOR_AREAS.map((r) => r.name),
  ]);
  const ids = new Set();
  for (const door of OFFICE.DOORWAYS) {
    assert.equal(ids.has(door.id), false, `문 id 가 겹친다: ${door.id}`);
    ids.add(door.id);
    assert.equal(door.link.length, 2, `${door.id} 의 link 가 두 구역이 아니다`);
    for (const zone of door.link) assert.ok(names.has(zone), `${door.id} 가 없는 구역 ${zone} 을 가리킨다`);
    assert.notEqual(door.link[0], door.link[1], `${door.id} 가 같은 구역을 두 번 가리킨다`);
  }
  // 바깥에서 들어오는 길이 하나뿐이면 진입 선택지가 없다.
  const entries = OFFICE.DOORWAYS.filter((d) => d.kind === 'entry');
  assert.ok(entries.length >= 4, `진입구가 ${entries.length}개뿐이다`);
});

test('사무실 벽 띠는 3.6m 층고를 빈틈없이 덮는다', () => {
  const bands = wallSections(OFFICE.MAP.height, OFFICE_BANDS);
  assert.ok(bands.length > 1);
  assert.equal(bands[0].bottom, 0);
  assert.equal(bands[bands.length - 1].top, OFFICE.MAP.height);
  for (let i = 1; i < bands.length; i++) {
    assert.equal(bands[i].bottom, bands[i - 1].top, '띠 사이에 틈이나 겹침이 있다');
  }
  // 저택의 띠를 그대로 쓰면 벽돌(1.255~6.35)이 천장까지 올라온다. 그걸 피하려고
  // 따로 둔 것이므로, 사무실 띠에는 벽돌이 없어야 한다.
  assert.equal(bands.some((b) => b.material === 'wall'), false);
});

test('사무실의 사건 목록이 맵 안에 들어 있다', () => {
  for (const src of OFFICE.AMBIENT_NOISE) {
    assert.ok(isIndoorsOf(OFFICE, src.x, src.z), `${src.id} 가 건물 밖에 있다`);
    assert.ok(src.level > 0 && src.level < 1, `${src.id} 의 소리 세기가 범위를 벗어났다`);
    assert.ok(src.everyMs >= 3000, `${src.id} 가 너무 자주 운다`);
  }
  const ids = new Set(OFFICE.ALARMS.map((a) => a.id));
  assert.equal(ids.size, OFFICE.ALARMS.length, '경보기 id 가 겹친다');
  // 경보기는 사옥 네 귀퉁이에 흩어져 있어야 "반대편으로 끌어낸다" 가 된다.
  const spread = Math.max(...OFFICE.ALARMS.map((a) => a.x)) - Math.min(...OFFICE.ALARMS.map((a) => a.x));
  assert.ok(spread > 60, `경보기가 ${spread.toFixed(0)}m 안에 몰려 있다`);
  // 저택에는 없다. 없어도 서버가 멀쩡히 돌아야 한다.
  assert.equal(MANSION.AMBIENT_NOISE, undefined);
  assert.equal(MANSION.ALARMS, undefined);
});

function isIndoorsOf(map, x, z) {
  const i = map.MAP.interior;
  return x > i.minX && x < i.maxX && z > i.minZ && z < i.maxZ;
}
