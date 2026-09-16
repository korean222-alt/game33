/* =============================================================================
 *  maps/mansion.js  -  라벤우드 저택
 *
 *  좌표 규약
 *    - y = 0 이 바닥. 콜라이더의 y 는 "밑면", h 는 두께/높이.
 *    - ry 는 Three.js 의 yaw. yaw = 0 은 -Z 를 본다.
 *    - 저택 내부는 x ∈ [-35, 35], z ∈ [-26, 26]. 그 바깥은 정원/앞마당이다.
 *
 *  이 파일은 이 맵에서 "보이는 것"과 "막히는 것"의 단일 원본이다. world.js 가
 *  그리고 서버가 판정에 쓰므로 둘이 어긋날 수 없다.
 *
 *  ---------------------------------------------------------------------------
 *  방을 늘리는 것만으로는 탐색이 되지 않는다. 예전 도면은 가운데 대홀이 z 로
 *  뻥 뚫려 있어서, 거기 한 번 서면 좌우 여섯 방의 문이 한눈에 다 들어왔다.
 *  그래서 복도를 두 줄 넣어 대홀을 가두고, 방은 전부 복도에서 열리게 했다.
 *  다음 방을 보려면 복도를 걸어야 한다.
 *
 *     x  -35    -23    -11     11     23     35
 *   z -26 ┌──────┬──────┬──────┬──────┬──────┐
 *         │ 저장 │ 서재 │ 계단홀│ 온실 │ 작업 │   북쪽 방 5칸
 *   z -15 ├──────┴──────┴──────┴──────┴──────┤
 *         │ ══════════ 북 복도 ════════════ │   (폭 4m, 좌우로 뚫려 있다)
 *   z -11 ├──────┬──────┬──────┬──────┬──────┤
 *         │ 주방 │ 서고 │      │ 화랑 │ 예배 │
 *   z   0 ├──────┼──────┤ 대홀 ├──────┼──────┤   가운데 방 8칸 + 대홀
 *         │ 식품 │ 응접 │      │ 객실 │ 하인 │
 *   z  11 ├──────┴──────┴──────┴──────┴──────┤
 *         │ ══════════ 남 복도 ════════════ │
 *   z  15 ├─────────────┬──────┬────────────┤
 *         │   연회실    │ 현관 │   무도회장 │   남쪽 방 3칸
 *   z  26 └─────────────┴──────┴────────────┘
 *                     (정문)
 * ========================================================================== */
import { MODELS } from '../config.js';
import { makeRun, makePart, finishMap } from './build.js';

const MAP = {
  name: '라벤우드 저택 구역',
  width: 88, depth: 88, height: 7,
  floorColor: 0xb6afa3, wallColor: 0xebe2d0, ceilColor: 0xd9d1bf,
  // 저택 껍데기. 이 사각형 안이 실내고, 밖은 하늘이 보이는 야외다.
  interior: { minX: -35, maxX: 35, minZ: -26, maxZ: 26 },
  fenceHeight: 3.2,
  doorHeight: 2.1,
};

const BACKUP_GENERATOR = { id: 'backup', x: 32, z: -17.1, w: 1.4, d: 0.8, h: 1.0, seconds: 3 };

const HALF_W = MAP.width / 2, HALF_D = MAP.depth / 2;
const OUTER = 0.4, INNER = 0.3, FENCE = 0.3;

/* ========================================================================== *
 *  1. 벽과 문틀
 *
 *  run() 은 한 줄의 벽을 문 구멍만 비워 두고 채운다. 구멍 위에는 상인방(lintel)을
 *  올려서 문을 넘겨다볼 수 없게 한다. 몸통은 maps/build.js 에 있다 - 사무실도
 *  같은 것을 쓴다.
 * ========================================================================== */
const WALLS = [];
const DOORWAYS = [];
/** 문짝 없는 아치. 방 이름표를 아치 위에 거는 데 쓴다(문과 같은 자리). */
const ARCHES = [];
const run = makeRun({ WALLS, DOORWAYS, ARCHES }, MAP.doorHeight);

/* ---- 담장 (3.2m). 정문은 열려 있고 그곳이 철수 지점이다 ------------------- */
run('z', HALF_D - 0.15, -HALF_W, HALF_W, FENCE, MAP.fenceHeight, [{ at: 0, span: 6 }]);
run('z', -HALF_D + 0.15, -HALF_W, HALF_W, FENCE, MAP.fenceHeight);
run('x', -HALF_W + 0.15, -HALF_D, HALF_D, FENCE, MAP.fenceHeight);
run('x', HALF_W - 0.15, -HALF_D, HALF_D, FENCE, MAP.fenceHeight);

/* ---- 저택 외벽 (7m) + 진입구 5곳 -----------------------------------------
 * 어디로 들어갈지는 팀이 고른다. 정문으로 들어가면 현관에서 복도를 거쳐야 하고,
 * 뒷문으로 들어가면 북쪽 방에서 시작해 반대로 훑게 된다.
 * ------------------------------------------------------------------------ */
run('z', 26, -35, 35, OUTER, MAP.height, [
  { at: 0, span: 2.4, door: 'front', kind: 'entry', link: ['COURTYARD', 'ENTRANCE HALL'] },
  { at: 27, span: 1.6, door: 'terrace', kind: 'entry', link: ['COURTYARD', 'BALLROOM'], hinge: -1 },
]);
run('z', -26, -35, 35, OUTER, MAP.height, [
  { at: -17, span: 1.6, door: 'rear-west', kind: 'entry', link: ['GARDEN', 'LIBRARY'] },
  { at: 17, span: 1.6, door: 'rear-east', kind: 'entry', link: ['GARDEN', 'CONSERVATORY'], hinge: -1 },
]);
run('x', -35, -26, 26, OUTER, MAP.height, [
  { at: 5.5, span: 1.6, door: 'service', kind: 'entry', link: ['WEST YARD', 'PANTRY'] },
]);
run('x', 35, -26, 26, OUTER, MAP.height, [
  { at: -5.5, span: 1.6, door: 'greenhouse', kind: 'entry', link: ['EAST YARD', 'CHAPEL'], hinge: -1 },
]);

/* ---- 북쪽 방 ↔ 북 복도 ---------------------------------------------------- */
run('z', -15, -35, 35, INNER, MAP.height, [
  { at: -29, span: 1.8, door: 'corr-cellar', link: ['NORTH CORRIDOR', 'CELLAR'] },
  { at: -17, span: 1.8, door: 'corr-library', link: ['NORTH CORRIDOR', 'LIBRARY'], hinge: -1 },
  /* 계단홀은 아치 세 짝으로 열려 있다. 가운데는 계단이 그대로 올라가므로,
   * 걸어 들어가려면 양옆 아치로 돌아야 한다. */
  { at: -7, span: 2.6, arch: true },
  { at: 0, span: 3.2, arch: true, link: ['NORTH CORRIDOR', 'STAIR HALL'] },
  { at: 7, span: 2.6, arch: true },
  { at: 17, span: 1.8, door: 'corr-conservatory', link: ['NORTH CORRIDOR', 'CONSERVATORY'] },
  { at: 29, span: 1.8, door: 'corr-workshop', link: ['NORTH CORRIDOR', 'WORKSHOP'], hinge: -1 },
]);

/* ---- 북 복도 ↔ 가운데 방 -------------------------------------------------- */
run('z', -11, -35, 35, INNER, MAP.height, [
  { at: -29, span: 1.8, door: 'corr-kitchen', link: ['NORTH CORRIDOR', 'KITCHEN'] },
  { at: -17, span: 1.8, door: 'corr-study', link: ['NORTH CORRIDOR', 'STUDY'], hinge: -1 },
  { at: -5.5, span: 2.6, arch: true },                // 대홀 북쪽 아치
  { at: 5.5, span: 1.8, door: 'corr-hall-n', link: ['NORTH CORRIDOR', 'GRAND HALL'] },
  { at: 17, span: 1.8, door: 'corr-gallery', link: ['NORTH CORRIDOR', 'GALLERY'] },
  { at: 29, span: 1.8, door: 'corr-chapel', link: ['NORTH CORRIDOR', 'CHAPEL'], hinge: -1 },
]);

/* ---- 가운데 방을 앞뒤로 나누는 벽 (대홀은 건드리지 않는다) ----------------- */
run('z', 0, -35, -11, INNER, MAP.height, [
  { at: -29, span: 1.8, door: 'kitchen-pantry', link: ['KITCHEN', 'PANTRY'] },
  { at: -17, span: 1.8, door: 'study-drawing', link: ['STUDY', 'DRAWING ROOM'], hinge: -1 },
]);
run('z', 0, 11, 35, INNER, MAP.height, [
  { at: 17, span: 1.8, door: 'gallery-guest', link: ['GALLERY', 'GUEST SUITE'] },
  { at: 29, span: 1.8, door: 'chapel-servants', link: ['CHAPEL', "SERVANTS' HALL"], hinge: -1 },
]);

/* ---- 가운데 방 ↔ 남 복도 -------------------------------------------------- */
run('z', 11, -35, 35, INNER, MAP.height, [
  { at: -29, span: 1.8, door: 'corr-pantry', link: ['SOUTH CORRIDOR', 'PANTRY'] },
  { at: -17, span: 1.8, door: 'corr-drawing', link: ['SOUTH CORRIDOR', 'DRAWING ROOM'], hinge: -1 },
  { at: -5.5, span: 1.8, door: 'corr-hall-s', link: ['SOUTH CORRIDOR', 'GRAND HALL'] },
  { at: 5.5, span: 2.6, arch: true },                 // 대홀 남쪽 아치
  { at: 17, span: 1.8, door: 'corr-guest', link: ['SOUTH CORRIDOR', 'GUEST SUITE'] },
  { at: 29, span: 1.8, door: 'corr-servants', link: ['SOUTH CORRIDOR', "SERVANTS' HALL"], hinge: -1 },
]);

/* ---- 남 복도 ↔ 남쪽 방 ---------------------------------------------------- */
run('z', 15, -35, 35, INNER, MAP.height, [
  { at: -23, span: 1.8, door: 'corr-dining', link: ['SOUTH CORRIDOR', 'DINING ROOM'] },
  { at: 0, span: 3.2, arch: true, link: ['SOUTH CORRIDOR', 'ENTRANCE HALL'] },   // 현관에서 복도로 나가는 아치
  { at: 23, span: 1.8, door: 'corr-ballroom', link: ['SOUTH CORRIDOR', 'BALLROOM'], hinge: -1 },
]);

/* ---- 세로 내벽. 복도가 지나는 구간(z -15~-11, 11~15)은 비워 둔다 ---------- */
run('x', -23, -26, -15, INNER, MAP.height, [
  { at: -20.5, span: 1.8, door: 'cellar-library', link: ['CELLAR', 'LIBRARY'] },
]);
run('x', -23, -11, 11, INNER, MAP.height, [
  { at: -5.5, span: 1.8, door: 'kitchen-study', link: ['KITCHEN', 'STUDY'] },
  { at: 5.5, span: 1.8, door: 'pantry-drawing', link: ['PANTRY', 'DRAWING ROOM'], hinge: -1 },
]);
run('x', -11, -26, -15, INNER, MAP.height, [
  { at: -20.5, span: 2.4, arch: true },               // 서재 ↔ 계단홀
]);
run('x', -11, -11, 11, INNER, MAP.height, [
  { at: -5.5, span: 1.8, door: 'hall-study', link: ['GRAND HALL', 'STUDY'] },
  { at: 5.5, span: 1.8, door: 'hall-drawing', link: ['GRAND HALL', 'DRAWING ROOM'], hinge: -1 },
]);
run('x', -11, 15, 26, INNER, MAP.height, [
  { at: 20.5, span: 2.4, arch: true },                // 연회실 ↔ 현관
]);

run('x', 11, -26, -15, INNER, MAP.height, [
  { at: -20.5, span: 2.4, arch: true },               // 계단홀 ↔ 온실
]);
run('x', 11, -11, 11, INNER, MAP.height, [
  { at: -5.5, span: 1.8, door: 'hall-gallery', link: ['GRAND HALL', 'GALLERY'] },
  { at: 5.5, span: 1.8, door: 'hall-guest', link: ['GRAND HALL', 'GUEST SUITE'], hinge: -1 },
]);
run('x', 11, 15, 26, INNER, MAP.height, [
  { at: 20.5, span: 2.4, arch: true },                // 현관 ↔ 무도회장
]);

run('x', 23, -26, -15, INNER, MAP.height, [
  { at: -20.5, span: 1.8, door: 'conservatory-workshop', link: ['CONSERVATORY', 'WORKSHOP'] },
]);
run('x', 23, -11, 11, INNER, MAP.height, [
  { at: -5.5, span: 1.8, door: 'gallery-chapel', link: ['GALLERY', 'CHAPEL'] },
  { at: 5.5, span: 1.8, door: 'guest-servants', link: ['GUEST SUITE', "SERVANTS' HALL"], hinge: -1 },
]);


/* ========================================================================== *
 *  2. 구역 (방과 야외)
 * ========================================================================== */
/*
 * 방 17칸 + 복도 2줄.
 *
 * 첫 칸(GRAND HALL)은 "대표 구역"으로 여러 곳에서 참조하므로 자리를 지킨다.
 * 복도는 방이 아니라 통로지만, 구역 이름이 있어야 "어디서 소리가 났다"를
 * 말해 줄 수 있어서 ROOMS 에 함께 둔다.
 */
const ROOMS = [
  { name: 'GRAND HALL', label: '중앙 대홀', x: 0, z: 0, w: 21.6, d: 21.6 },
  // 북쪽 줄
  { name: 'CELLAR', label: '지하 저장고', x: -29, z: -20.5, w: 11.6, d: 10.6 },
  { name: 'LIBRARY', label: '서재', x: -17, z: -20.5, w: 11.6, d: 10.6 },
  { name: 'STAIR HALL', label: '계단홀', x: 0, z: -20.5, w: 21.6, d: 10.6 },
  { name: 'CONSERVATORY', label: '온실', x: 17, z: -20.5, w: 11.6, d: 10.6 },
  { name: 'WORKSHOP', label: '작업실', x: 29, z: -20.5, w: 11.6, d: 10.6 },
  // 가운데 줄
  { name: 'KITCHEN', label: '주방', x: -29, z: -5.5, w: 11.6, d: 10.6 },
  { name: 'PANTRY', label: '식품 저장실', x: -29, z: 5.5, w: 11.6, d: 10.6 },
  { name: 'STUDY', label: '서고', x: -17, z: -5.5, w: 11.6, d: 10.6 },
  { name: 'DRAWING ROOM', label: '응접실', x: -17, z: 5.5, w: 11.6, d: 10.6 },
  { name: 'GALLERY', label: '화랑', x: 17, z: -5.5, w: 11.6, d: 10.6 },
  { name: 'GUEST SUITE', label: '객실', x: 17, z: 5.5, w: 11.6, d: 10.6 },
  { name: 'CHAPEL', label: '예배실', x: 29, z: -5.5, w: 11.6, d: 10.6 },
  { name: "SERVANTS' HALL", label: '하인 구역', x: 29, z: 5.5, w: 11.6, d: 10.6 },
  // 남쪽 줄
  { name: 'DINING ROOM', label: '연회실', x: -23, z: 20.5, w: 23.6, d: 10.6 },
  { name: 'ENTRANCE HALL', label: '현관홀', x: 0, z: 20.5, w: 21.6, d: 10.6 },
  { name: 'BALLROOM', label: '무도회장', x: 23, z: 20.5, w: 23.6, d: 10.6 },
];

/** 복도. 방과 방 사이를 잇는 유일한 길이라 여기서 마주치면 피할 데가 없다. */
const CORRIDORS = [
  { name: 'NORTH CORRIDOR', label: '북쪽 복도', x: 0, z: -13, w: 69.6, d: 3.6 },
  { name: 'SOUTH CORRIDOR', label: '남쪽 복도', x: 0, z: 13, w: 69.6, d: 3.6 },
];

const OUTDOOR_AREAS = [
  { name: 'COURTYARD', label: '앞마당 · 진입로', x: 0, z: 35, w: 87, d: 17.6, outdoor: true },
  { name: 'WEST YARD', label: '서측 통로', x: -39.4, z: 0, w: 8.6, d: 87, outdoor: true },
  { name: 'EAST YARD', label: '동측 통로', x: 39.4, z: 0, w: 8.6, d: 87, outdoor: true },
  { name: 'GARDEN', label: '후원 테라스', x: 0, z: -35, w: 87, d: 17.6, outdoor: true },
];


/* ========================================================================== *
 *  3. 가구와 소품
 * ========================================================================== */
const FURNITURE = [];
const part = makePart(FURNITURE);

function table(x, z, w = 4, d = 1.8) {
  part(x, z, w, d, .16, .94);
  for (const dx of [-w / 2 + .16, w / 2 - .16]) {
    for (const dz of [-d / 2 + .16, d / 2 - .16]) part(x + dx, z + dz, .18, .18, .94);
  }
}
function sofa(x, z, ry = 0) {
  const add = (dx, dz, w, d, h, y) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    part(x + c * dx + s * dz, z - s * dx + c * dz, w, d, h, y, 'velvet', ry);
  };
  add(0, 0, 3.4, 1.05, .52, 0); add(0, .48, 3.4, .16, .65, .52);
  for (const dx of [-1.58, 1.58]) add(dx, 0, .24, 1.05, .3, .52);
}
/*
 * 책장.
 *
 * 벽에 딱 붙여 놓으면 책장의 뒷면과 벽면이 정확히 같은 평면에 놓인다. 깊이
 * 값이 같아서 카메라가 움직일 때마다 어느 쪽이 앞인지 뒤집히고, 책장이
 * 지지직거리며 깨져 보인다(z-fighting). 6cm 띄운다. 실제로도 책장은 벽에
 * 딱 붙지 않는다.
 */
const WALL_GAP = 0.06;
function shelf(x, z, w, d, ry = 0) {
  part(x, z, w, d, 2.9, 0, 'wood', ry);
}
function crateStack(x, z, ry = 0) {
  part(x, z, .9, .9, .9, 0, 'wood', ry);
  part(x + .1, z - .05, .7, .7, .7, .9, 'wood', ry + .3);
}
function hedge(x, z, w, d) { part(x, z, w, d, 1.45, 0, 'hedge'); }
function planter(x, z) { part(x, z, 1.5, 1.5, .55, 0, 'stone'); part(x, z, 1.1, 1.1, .7, .55, 'hedge'); }
function bench(x, z, ry = 0) { part(x, z, 1.9, .55, .45, 0, 'stone', ry); }
function van(x, z, ry = 0) {
  part(x, z, 2.2, 5.0, 1.25, .32, 'metal', ry);
  part(x, z, 2.0, 2.4, .85, 1.57, 'glass', ry);
  const c = Math.cos(ry), s = Math.sin(ry);
  for (const [dx, dz] of [[-1, -1.7], [1, -1.7], [-1, 1.7], [1, 1.7]]) {
    part(x + c * dx + s * dz, z - s * dx + c * dz, .36, .72, .64, 0, 'metal', ry);
  }
}

/* ---- 북쪽 줄 -------------------------------------------------------------- *
 *  벽 안쪽 면 좌표 (가구를 붙일 기준)
 *    외벽 x = ±34.8 / z = ±25.8    내벽 x = ±23, ±11 의 양면 = ∓0.15
 *  전부 WALL_GAP 만큼 띄운다. 딱 붙이면 면이 겹쳐 지지직거린다.
 * ------------------------------------------------------------------------- */
// 지하 저장고: 궤짝과 선반이 시야를 끊는다. 숨기 좋고, 그래서 위험하다.
for (const z of [-24, -20.5, -17]) shelf(-34.04, z, 1.4, 2.6);
crateStack(-27.5, -23.5); crateStack(-26.1, -22.8, .4); crateStack(-29.5, -18);
part(-27, -25.14, 4.4, 1.1, .95, 0, 'wood');
// 서재: 북벽을 따라 책장, 가운데 열람 책상 (뒷문 x=-17 앞은 비워 둔다)
for (const x of [-21, -13]) shelf(x, -25.14, 2.4, 1.2);
table(-17, -20.5, 3.6, 1.6);
sofa(-13.2, -17.5, Math.PI / 2);
/* 계단홀: 의식용 계단이 동쪽 벽을 타고 층계참까지 올라간다. 위에 서면 복도
 * 입구가 내려다보인다 - 지키는 쪽에도, 올라간 쪽에도 좋은 자리다.
 * 계단을 방 한가운데 두면 홀을 가로지를 수가 없어서 한쪽으로 붙였다. */
for (let i = 0; i < 12; i++) part(5.5, -17 - i * .42, 5, .42, (i + 1) * .2, 0, 'stone');
part(5.5, -23.85, 7, 4.1, 2.4, 0, 'stone');
for (const x of [2.3, 8.7]) part(x, -23.85, .25, 4.1, 1.1, 2.4, 'brass');
for (const z of [-24, -17.4]) part(-8.2, z, .65, .65, 6.9, 0, 'stone');
part(-4.5, -24.6, 3.2, 1.2, 1, 0, 'stone');
/* 온실. 문이 네 짝(뒷문 x=17 · 복도 x=17 · 계단홀 x=11 · 작업실 x=23)이라
 * 방 한가운데가 십자로 뚫려 있다. 가구는 네 귀퉁이에만 둔다. */
part(13.4, -23.6, 4, 1.3, .75, 0, 'stone');
part(20.8, -17.6, 3.6, 1.2, .9, 0, 'glass');
table(20.6, -23.4, 3.2, 1.6);
// 북동 작업실의 예비 발전기. 렌더링과 이동 충돌이 같은 치수를 쓴다.
part(BACKUP_GENERATOR.x, BACKUP_GENERATOR.z, BACKUP_GENERATOR.w, BACKUP_GENERATOR.d, BACKUP_GENERATOR.h, 0, 'metal');
// 작업실: 작업대와 자재
table(29, -24, 5, 1.8);
shelf(34.04, -20.5, 1.4, 4.2);
crateStack(25.4, -17.4); crateStack(26.8, -18, .5);

/* ---- 가운데 줄 ------------------------------------------------------------ */
// 주방: 긴 조리대. 가운데를 막고 있어서 한 바퀴 돌아야 한다.
table(-29, -5.5, 5.4, 1.8);
part(-34.09, -8, 1.3, 4.4, .95, 0, 'stone');
part(-34.09, -2.6, 1.3, 3.2, .95, 0, 'stone');
crateStack(-24.4, -9.6);
// 식품 저장실: 선반 두 줄 (서쪽 통용문 z=5.5 앞은 비워 둔다)
shelf(-34.04, 2.4, 1.4, 3.4); shelf(-34.04, 8.6, 1.4, 3.4);
crateStack(-27.2, 2.2); crateStack(-25.8, 2.9, .4); crateStack(-28, 9.2);
// 서고: 책장과 열람대
shelf(-22.09, -8.5, 1.4, 3.6); shelf(-22.09, -2.5, 1.4, 2.6);
table(-17, -5.5, 3.6, 1.6);
sofa(-13.4, -8.6, Math.PI / 2);
// 응접실
sofa(-17, 3.4); sofa(-17, 7.4, Math.PI); table(-17, 5.4, 2.2, 1.2);
shelf(-22.09, 9.4, 1.4, 3.2);
// 화랑: 좌대 넷과 벽면 진열대 (여기도 문이 네 짝이라 가운데를 비운다)
for (const x of [13.4, 20.6]) for (const z of [-8.6, -2.4]) part(x, z, 1, 1, 1.15, 0, 'stone');
part(22.19, -8.6, 1.1, 3.6, 1.1, 0, 'stone');
// 객실
sofa(17, 3.2); table(17, 6.8, 3.2, 1.8);
shelf(22.09, 9.4, 1.4, 3.2);
crateStack(12.8, 9.4); crateStack(14.2, 10, .4);
/* 예배실: 가운데 통로(x = 29)를 비우고 신도석을 양옆에 둔다. 통로는 문 세 짝을
 * 잇는 길이라 막으면 안 된다. 신도석은 0.4m 라서 넘어 다닐 수 있다 - 엄폐물이지
 * 벽이 아니다. */
for (const z of [-8.8, -7.4, -3.6, -2.2]) {
  part(26.2, z, 4, .5, .4, 0, 'wood'); part(31.8, z, 4, .5, .4, 0, 'wood');
}
part(26.4, -9.9, 2.6, 1, 1, 0, 'stone');   // 제단
// 하인 구역: 식탁과 사물함
table(29, 5.6, 5, 1.8);
part(34.09, 3, 1.3, 3.4, 2.1, 0, 'metal'); part(34.09, 8.2, 1.3, 3.4, 2.1, 0, 'metal');
// 대홀: 기둥 넷과 응접 소파
sofa(-4.6, 2, Math.PI / 2); sofa(4.6, 2, -Math.PI / 2); table(0, 2, 2.4, 1.2);
for (const x of [-7.4, 7.4]) for (const z of [-7.4, 7.4]) part(x, z, .8, .8, 6.9, 0, 'stone');
part(0, -7.4, 4.2, 1.2, 1, 0, 'stone');

/* ---- 남쪽 줄 -------------------------------------------------------------- */
// 연회실: 긴 식탁과 의자
table(-23, 20.5, 9, 2.4);
for (const x of [-27, -23, -19]) for (const z of [18.4, 22.6]) {
  part(x, z, .8, .8, .55, 0, 'velvet'); part(x, z + (z > 20.5 ? .35 : -.35), .8, .1, .6, .55, 'velvet');
}
shelf(-34.04, 17.6, 1.4, 3.4); shelf(-34.04, 23.4, 1.4, 3.4);
// 현관홀: 정문 정면(x=0)은 비워 둔다. 들어오자마자 막히면 안 된다.
part(-7.6, 17.6, 3.2, 1, 1, 0, 'wood');
bench(-6.4, 24, 0); bench(6.4, 24, 0);
planter(8.6, 17.4);
// 무도회장: 넓게 비워 둔다. 여기서 붙으면 엄폐가 없다.
table(31, 17.8, 3.2, 1.6); table(31, 23.4, 3.2, 1.6);
part(14.2, 24.3, 2.6, 1.6, 1.1, 0, 'wood');
for (const x of [18.5, 27.5]) part(x, 20.5, .8, .8, 6.9, 0, 'stone');

/* ---- 앞마당 -------------------------------------------------------------- */
part(0, 27.5, 9, 2.4, .22, 0, 'stone');                 // 현관 포치 (외벽에서 띄운다)
for (const x of [-4.2, 4.2]) part(x, 27.7, .7, .7, 3.6, .22, 'stone');
for (const x of [-26, 26]) hedge(x, 34, 13, 1.3);        // 진입로 양쪽 생울타리
for (const z of [29.5, 38.5]) { hedge(-7.4, z, 1.3, 5.4); hedge(7.4, z, 1.3, 5.4); }
planter(-13.5, 28.5); planter(13.5, 28.5);
van(-18.5, 31.5, .18); van(19, 35.5, -.12);
bench(-3.6, 32.6, Math.PI / 2); bench(3.6, 32.6, -Math.PI / 2);
// 게이트 경비 초소. 앞면(z 작은 쪽)이 열려 있고 카운터는 한쪽으로 치워 두어
// 사람이 들어갈 통로가 남는다.
part(-22.8, 39, .3, 3.6, 2.6, 0, 'wood'); part(-18.2, 39, .3, 3.6, 2.6, 0, 'wood');
part(-20.5, 40.65, 4.9, .3, 2.6, 0, 'wood'); part(-20.5, 39, 4.9, 3.6, .2, 2.6, 'wood');
part(-21.4, 38.4, 2.0, .7, .95, 0, 'wood');
crateStack(14.6, 39.4); crateStack(16, 38.8, .5);

/* ---- 서·동측 통로 -------------------------------------------------------- */
for (const z of [-19, -6, 8, 20]) { crateStack(-41.5, z); }
part(-39.5, 5, 2.2, 1.6, 1.5, 0, 'metal');              // 발전기 (두꺼비집이 여기 있다)
hedge(-37.4, 30.5, 1.3, 4.4); hedge(37.4, 30.5, 1.3, 4.4);
for (const z of [-20, -8, 6, 18]) part(41, z, 1.4, 3.4, 1.2, 0, 'glass');  // 온실 골조
bench(38, -14, Math.PI / 2); bench(-38, 16, Math.PI / 2);

/* ---- 후원 테라스 --------------------------------------------------------- */
for (let i = 0; i < 3; i++) part(0, -26.7 - i * .5, 26, .5, .4 - i * .12, 0, 'stone');
part(0, -29.4, 26, 4.2, .16, 0, 'stone');
for (const x of [-22, 22]) hedge(x, -32, 11, 1.3);
for (const z of [-35, -39]) { hedge(-7.4, z, 1.3, 3.4); hedge(7.4, z, 1.3, 3.4); }
bench(-4.4, -32.6); bench(4.4, -32.6);
crateStack(-27.5, -38); crateStack(27.5, -38, .6);

const PROPS = [
  { model: 'vase', x: -8.6, z: 23.4, ry: 0, s: .7 },        // 현관홀
  { model: 'vase', x: 8.6, z: 23.4, ry: 0, s: .7 },
  { model: 'vase', x: 13.8, z: -8.6, yOff: 1.15, ry: 0, s: .65 },  // 화랑 좌대 위
  { model: 'vase', x: 20.2, z: -3.4, yOff: 1.15, ry: 0, s: .65 },
  { model: 'crate', x: 32.4, z: -17.6, ry: .4, s: 1 },      // 작업실
  { model: 'crate', x: 33.4, z: -18.6, ry: -.2, s: 1.25 },
  { model: 'barrel', x: -31.6, z: -15.9, ry: 0, s: 1 },     // 저장고
  { model: 'barrel', x: -32.6, z: 10, ry: 0, s: 1 },        // 식품 저장실
  { model: 'barrel', x: 26.4, z: 9.8, ry: 0, s: 1 },        // 하인 구역
  { model: 'well', x: 0, z: 34.6, ry: 0, s: 1 },            // 앞마당
  { model: 'well', x: 0, z: -36, ry: 0, s: 1 },             // 후원
];
for (const p of PROPS) {
  const [w, h, d] = MODELS[p.model].fit.size ?? [1.6, MODELS[p.model].fit.height, 1.6];
  p.col = { w: w * p.s, h: h * p.s, d: d * p.s };
}


/* ========================================================================== *
 *  4. 조명
 * ========================================================================== */
/*
 * 실내등(chandelier)은 저택의 전기로 켜지고, 야외등(lamp)은 담장 밖 배선이라
 * 따로 돈다. 작전 중간에 저택 전기가 끊기면 chandelier 만 전부 꺼진다
 * (server.js 의 room.power / world.js 의 setPower).
 */
const LIGHTS = [
  { x: 0, y: 5.5, z: 0, color: 0xffdfad, intensity: 80, distance: 26, kind: 'chandelier' },
  ...ROOMS.slice(1).map((r) => ({
    x: r.x, y: 5.2, z: r.z, distance: r.w > 20 ? 24 : 19, intensity: r.w > 20 ? 65 : 52,
    kind: 'chandelier',
    color: r.name === 'CONSERVATORY' ? 0xc9e7ff : r.name === 'CHAPEL' ? 0xffcf90 : 0xffd8a4,
  })),
  // 복도등. 복도는 길어서 등 사이가 어둡다 - 그 어둠이 곧 엄폐다.
  ...[-26, -9, 9, 26].flatMap((x) => [
    { x, y: 4.6, z: -13, color: 0xffd8a4, intensity: 34, distance: 15, kind: 'chandelier' },
    { x, y: 4.6, z: 13, color: 0xffd8a4, intensity: 34, distance: 15, kind: 'chandelier' },
  ]),
  // 야외 가로등. 밤이므로 빛 사이의 어둠이 곧 엄폐다.
  { x: -15, y: 4.2, z: 38, color: 0xbfd4e8, intensity: 34, distance: 17, kind: 'lamp' },
  { x: 15, y: 4.2, z: 30, color: 0xbfd4e8, intensity: 34, distance: 17, kind: 'lamp' },
  { x: 0, y: 4.6, z: 28.4, color: 0xffe0b0, intensity: 26, distance: 13, kind: 'lamp' },
  { x: -39, y: 4.2, z: 14, color: 0xbfd4e8, intensity: 26, distance: 15, kind: 'lamp' },
  { x: -39, y: 4.2, z: -16, color: 0xbfd4e8, intensity: 26, distance: 15, kind: 'lamp' },
  { x: 39, y: 4.2, z: -8, color: 0xbfd4e8, intensity: 26, distance: 15, kind: 'lamp' },
  { x: 39, y: 4.2, z: 18, color: 0xbfd4e8, intensity: 26, distance: 15, kind: 'lamp' },
  { x: 0, y: 4.2, z: -32, color: 0xbfd4e8, intensity: 30, distance: 16, kind: 'lamp' },
];


/* ========================================================================== *
 *  5. 스폰 / 목표 / 경비 배치
 * ========================================================================== */
/** 팀은 정문 바깥 진입로에서 시작한다. */
const SPAWNS = [
  { x: -2.2, z: 38.4, yaw: 0 }, { x: 2.2, z: 38.4, yaw: 0 },
  { x: -2.2, z: 40.2, yaw: 0 }, { x: 2.2, z: 40.2, yaw: 0 },
];

/** 철수 지점 (담장 정문). */
const EXTRACTION = { x: 0, z: 41.4, radius: 3.2, label: '정문 · 철수' };

/**
 * 폭발물 두 개. 저택의 양 끝에 둔다. 한 번에 두 곳을 볼 수 없어야 한다.
 */
const BOMB_SITES = [
  { id: 'A', x: -29, z: -21.5, label: '저장고 A', room: 'CELLAR' },
  { id: 'B', x: 30.4, z: 3.4, label: '하인 구역 B', room: "SERVANTS' HALL" },
];

/** 증거 후보 위치. 임무 시작 때 일부만 고른다. */
const EVIDENCE_SPOTS = [
  { id: 'ledger', x: -17, z: -19.2, label: '거래 장부', room: 'LIBRARY' },
  { id: 'drive', x: 17, z: -6.2, label: '암호 드라이브', room: 'GALLERY' },
  { id: 'radio', x: -31.4, z: 19, label: '무전 기록', room: 'DINING ROOM' },
  { id: 'passport', x: 17, z: 9.2, label: '위조 여권', room: 'GUEST SUITE' },
  { id: 'cash', x: -20.4, z: 4.2, label: '현금 가방', room: 'DRAWING ROOM' },
  { id: 'manifest', x: -21.4, z: 39.6, label: '초소 출입 기록', room: 'COURTYARD' },
  { id: 'keys', x: -32.6, z: -4.4, label: '금고 열쇠', room: 'KITCHEN' },
  { id: 'chart', x: 29, z: -3.4, label: '항해 도면', room: 'CHAPEL' },
  { id: 'crate', x: 31.6, z: -22.4, label: '표식 없는 상자', room: 'WORKSHOP' },
];

/**
 * 방마다 경비가 설 수 있는 자리. 임무 시작 때 일부만 채운다.
 *
 * 방이 17칸이라 6~10명으로는 절반 넘게 빈다. 그게 노린 것이다 - 어느 방이
 * 비었는지 모르니 전부 확인해야 하고, 그래서 탐색이 된다.
 */
const POSTS = [
  // 야외 경비. 시작 지점을 정면으로 보고 있는 자리는 서버가 배치에서 제외한다.
  { room: 'COURTYARD', x: -16.4, z: 41.4, yaw: Math.PI },
  { room: 'COURTYARD', x: 18.4, z: 39.4, yaw: -Math.PI / 2 },
  { room: 'COURTYARD', x: -21.6, z: 29.4, yaw: Math.PI * .8 },
  { room: 'COURTYARD', x: 5.2, z: 30.4, yaw: -Math.PI / 2 },
  { room: 'COURTYARD', x: -25.6, z: 31.4, yaw: 0 },
  { room: 'COURTYARD', x: 25.6, z: 31.4, yaw: 0 },
  { room: 'COURTYARD', x: 19.4, z: 28.4, yaw: Math.PI / 2 },
  { room: 'WEST YARD', x: -39.4, z: 20.6, yaw: -Math.PI / 2 },
  { room: 'WEST YARD', x: -39.4, z: -2.4, yaw: 0 },
  { room: 'WEST YARD', x: -39.4, z: -23.4, yaw: 0 },
  { room: 'EAST YARD', x: 39.4, z: -14.4, yaw: Math.PI / 2 },
  { room: 'EAST YARD', x: 39.4, z: 4.4, yaw: 0 },
  { room: 'EAST YARD', x: 39.4, z: 24.4, yaw: Math.PI },
  { room: 'GARDEN', x: -14.6, z: -32.8, yaw: 0 },
  { room: 'GARDEN', x: 14.6, z: -34.2, yaw: 0 },
  { room: 'GARDEN', x: 0, z: -38.4, yaw: 0 },
  // 복도. 여기 선 경비는 방 여럿을 동시에 지킨다.
  { room: 'NORTH CORRIDOR', x: -25.4, z: -13, yaw: Math.PI / 2 },
  { room: 'NORTH CORRIDOR', x: 25.4, z: -13, yaw: -Math.PI / 2 },
  { room: 'SOUTH CORRIDOR', x: -25.4, z: 13, yaw: Math.PI / 2 },
  { room: 'SOUTH CORRIDOR', x: 25.4, z: 13, yaw: -Math.PI / 2 },
  // 실내
  { room: 'ENTRANCE HALL', x: -7.4, z: 21.4, yaw: Math.PI },
  { room: 'ENTRANCE HALL', x: 7.4, z: 18.4, yaw: Math.PI },
  { room: 'BALLROOM', x: 22.4, z: 18.4, yaw: Math.PI },
  { room: 'BALLROOM', x: 32.4, z: 21.4, yaw: -Math.PI / 2 },
  { room: 'DINING ROOM', x: -14.4, z: 18.4, yaw: -Math.PI / 2 },
  { room: 'DINING ROOM', x: -31.4, z: 21.4, yaw: Math.PI / 2 },
  { room: 'GRAND HALL', x: -3.4, z: 8.6, yaw: 0 },
  { room: 'GRAND HALL', x: 3.6, z: -8.4, yaw: Math.PI },
  { room: 'DRAWING ROOM', x: -13.4, z: 3.4, yaw: -Math.PI / 2 },
  { room: 'DRAWING ROOM', x: -20.4, z: 1.6, yaw: 0 },
  { room: 'STUDY', x: -13.4, z: -3.4, yaw: -Math.PI / 2 },
  { room: 'STUDY', x: -19.4, z: -9.6, yaw: 0 },
  { room: 'KITCHEN', x: -25.4, z: -3.4, yaw: Math.PI / 2 },
  { room: 'KITCHEN', x: -31.4, z: -9.4, yaw: 0 },
  { room: 'PANTRY', x: -25.4, z: 8.4, yaw: Math.PI / 2 },
  { room: 'PANTRY', x: -30.4, z: 5.4, yaw: -Math.PI / 2 },
  { room: 'CELLAR', x: -24.6, z: -22.4, yaw: Math.PI / 2 },
  { room: 'CELLAR', x: -31.4, z: -21.4, yaw: 0 },
  { room: 'LIBRARY', x: -13.4, z: -23.4, yaw: -Math.PI / 2 },
  { room: 'LIBRARY', x: -20.4, z: -17.4, yaw: Math.PI / 2 },
  { room: 'STAIR HALL', x: -6.4, z: -19.4, yaw: Math.PI / 2 },
  { room: 'STAIR HALL', x: -5.4, z: -22.4, yaw: -Math.PI / 2 },
  { room: 'CONSERVATORY', x: 13.8, z: -18.4, yaw: -Math.PI / 2 },
  { room: 'CONSERVATORY', x: 21.4, z: -21.4, yaw: Math.PI / 2 },
  { room: 'WORKSHOP', x: 25.4, z: -18.4, yaw: Math.PI / 2 },
  { room: 'WORKSHOP', x: 32.4, z: -21.4, yaw: 0 },
  { room: 'GALLERY', x: 12.4, z: -4.6, yaw: -Math.PI / 2 },
  { room: 'GALLERY', x: 21.6, z: -4.4, yaw: Math.PI / 2 },
  { room: 'GUEST SUITE', x: 13.4, z: 8.4, yaw: -Math.PI / 2 },
  { room: 'GUEST SUITE', x: 20.4, z: 2.4, yaw: Math.PI / 2 },
  { room: 'CHAPEL', x: 24.4, z: -5.5, yaw: Math.PI / 2 },
  { room: 'CHAPEL', x: 33.8, z: -5.5, yaw: 0 },
  { room: "SERVANTS' HALL", x: 25.4, z: 8.4, yaw: Math.PI / 2 },
  { room: "SERVANTS' HALL", x: 31.4, z: 2.4, yaw: -Math.PI / 2 },
];

/**
 * 민간인(과 인질)이 있을 수 있는 자리.
 *
 * 방마다 두세 곳씩 둔다. 한 방에 한 자리뿐이면 인질이 늘 같은 구석에 서 있어서
 * 두 번째 판부터는 문을 열기 전에 어디 있는지 알아 버린다.
 */
const CIVILIAN_SPOTS = [
  { room: 'DINING ROOM', x: -14.4, z: 23.4 },
  { room: 'DINING ROOM', x: -31.4, z: 17.4 },
  { room: 'DINING ROOM', x: -20.4, z: 24.4 },
  { room: 'DRAWING ROOM', x: -20.4, z: 8.4 },
  { room: 'DRAWING ROOM', x: -13.2, z: 2.4 },
  { room: 'DRAWING ROOM', x: -19.4, z: 1.4 },
  { room: 'GUEST SUITE', x: 21.4, z: 6.4 },
  { room: 'GUEST SUITE', x: 13.4, z: 5.4 },
  { room: 'GUEST SUITE', x: 19.2, z: 1.4 },
  { room: 'GALLERY', x: 21.6, z: -2.4 },
  { room: 'GALLERY', x: 12.6, z: -6.4 },
  { room: 'GALLERY', x: 17, z: -3 },
  { room: 'LIBRARY', x: -12.4, z: -21.4 },
  { room: 'LIBRARY', x: -20.2, z: -22.6 },
  { room: 'CONSERVATORY', x: 21.6, z: -22.4 },
  { room: 'CONSERVATORY', x: 12.6, z: -21.6 },
  { room: 'STUDY', x: -13.4, z: -1.4 },
  { room: 'STUDY', x: -19.4, z: -1.6 },
  { room: 'KITCHEN', x: -31.4, z: -1.4 },
  { room: 'KITCHEN', x: -25.4, z: -8.4 },
  { room: 'PANTRY', x: -30.4, z: 1.4 },
  { room: 'PANTRY', x: -25.4, z: 5.4 },
  { room: 'CHAPEL', x: 33.2, z: -8.6 },
  { room: 'CHAPEL', x: 25.6, z: -2.4 },
  { room: "SERVANTS' HALL", x: 31.4, z: 9.4 },
  { room: "SERVANTS' HALL", x: 25.4, z: 2.4 },
  { room: 'BALLROOM', x: 16.4, z: 18.4 },
  { room: 'BALLROOM', x: 25.4, z: 24.4 },
  { room: 'WORKSHOP', x: 25.4, z: -22.4 },
  { room: 'CELLAR', x: -26.4, z: -17.4 },
  { room: 'ENTRANCE HALL', x: -6.4, z: 20.4 },
  { room: 'ENTRANCE HALL', x: 6.6, z: 22.4 },
];

/**
 * 주요 용의자가 인질과 함께 농성할 수 있는 방.
 * 진입구에서 먼 안쪽 방들. 문 하나 열어 보고 끝나면 3단계가 너무 빨리 끝난다.
 */
const HVT_ROOMS = [
  'DINING ROOM', 'GALLERY', 'GUEST SUITE', 'DRAWING ROOM', 'LIBRARY', 'CONSERVATORY',
  'STUDY', 'CHAPEL', "SERVANTS' HALL", 'KITCHEN', 'PANTRY', 'BALLROOM',
];


/* ========================================================================== *
 *  완성
 * ========================================================================== */
export const MANSION = finishMap({
  id: 'mansion',
  label: '라벤우드 저택',
  blurb: '17칸짜리 저택. 복도 두 줄이 대홀을 가두고, 방은 전부 복도에서 열린다.',
  defaultZone: 'COURTYARD',
  MAP, BACKUP_GENERATOR,
  WALLS, DOORWAYS, ARCHES,
  ROOMS, CORRIDORS, OUTDOOR_AREAS,
  FURNITURE, PROPS, LIGHTS,
  SPAWNS, EXTRACTION, BOMB_SITES, EVIDENCE_SPOTS,
  POSTS, CIVILIAN_SPOTS, HVT_ROOMS,
});
