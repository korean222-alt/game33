/* =============================================================================
 *  map-data.js  -  라벤우드 저택 "구역" 전체 (서버/클라이언트 공용)
 *
 *  좌표 규약
 *    - y = 0 이 바닥. 콜라이더의 y 는 "밑면", h 는 두께/높이.
 *    - ry 는 Three.js 의 yaw. yaw = 0 은 -Z 를 본다.
 *    - 저택 내부는 x ∈ [-24, 24], z ∈ [-18, 18]. 그 바깥은 정원/앞마당이다.
 *
 *  이 파일은 "보이는 것"과 "막히는 것"의 단일 원본이다. world.js 가 그리고
 *  server.js 가 판정에 쓰므로 둘이 어긋날 수 없다.
 * ========================================================================== */
import { MODELS } from './config.js';

export const MAP = {
  name: '라벤우드 저택 구역',
  width: 64, depth: 68, height: 7,
  floorColor: 0xb6afa3, wallColor: 0xebe2d0, ceilColor: 0xd9d1bf,
  // 저택 껍데기. 이 사각형 안이 실내고, 밖은 하늘이 보이는 야외다.
  interior: { minX: -24, maxX: 24, minZ: -18, maxZ: 18 },
  fenceHeight: 3.2,
  doorHeight: 2.1,
};

const HALF_W = MAP.width / 2, HALF_D = MAP.depth / 2;
const OUTER = 0.4, INNER = 0.3, FENCE = 0.3;

/* ========================================================================== *
 *  1. 벽과 문틀
 *
 *  run() 은 한 줄의 벽을 문 구멍만 비워 두고 채운다. 구멍 위에는 상인방(lintel)을
 *  올려서 문을 넘겨다볼 수 없게 한다.
 * ========================================================================== */
export const WALLS = [];
export const DOORWAYS = [];

/**
 * @param axis      'x' 면 x=at 에 서서 z 로 뻗는 벽, 'z' 면 z=at 에 서서 x 로 뻗는 벽
 * @param gaps      [{ at, span, door }] - door 가 있으면 문으로 등록된다
 */
function run(axis, at, from, to, thickness, height, gaps = []) {
  const place = (a, b, y = 0, h = height) => {
    if (b - a < 0.001 || h < 0.001) return;
    const mid = (a + b) / 2, len = b - a;
    WALLS.push(axis === 'x'
      ? { x: at, z: mid, w: thickness, d: len, h, y }
      : { x: mid, z: at, w: len, d: thickness, h, y });
  };

  const sorted = [...gaps].sort((a, b) => a.at - b.at);
  let cursor = from;
  for (const gap of sorted) {
    place(cursor, gap.at - gap.span / 2);
    cursor = gap.at + gap.span / 2;
    if (!gap.door) continue;
    // 문 위쪽 벽
    place(gap.at - gap.span / 2, cursor, MAP.doorHeight, height - MAP.doorHeight);
    DOORWAYS.push({
      id: gap.door, axis, span: gap.span, thickness,
      x: axis === 'x' ? at : gap.at,
      z: axis === 'x' ? gap.at : at,
      hinge: gap.hinge ?? 1,
      kind: gap.kind || 'interior',
      link: gap.link || [],
    });
  }
  place(cursor, to);
}

/* ---- 담장 (3.2m). 정문은 열려 있고 그곳이 철수 지점이다 ------------------- */
run('z', HALF_D - 0.15, -HALF_W, HALF_W, FENCE, MAP.fenceHeight, [{ at: 0, span: 6 }]);
run('z', -HALF_D + 0.15, -HALF_W, HALF_W, FENCE, MAP.fenceHeight);
run('x', -HALF_W + 0.15, -HALF_D, HALF_D, FENCE, MAP.fenceHeight);
run('x', HALF_W - 0.15, -HALF_D, HALF_D, FENCE, MAP.fenceHeight);

/* ---- 저택 외벽 (7m) + 진입구 3곳 ----------------------------------------- */
run('z', 18, -24, 24, OUTER, MAP.height, [
  { at: 0, span: 2.4, door: 'front', kind: 'entry', link: ['COURTYARD', 'GRAND HALL'] },
]);
run('z', -18, -24, 24, OUTER, MAP.height, [
  { at: -15, span: 1.6, door: 'rear-west', kind: 'entry', link: ['GARDEN', 'LIBRARY'] },
  { at: 15, span: 1.6, door: 'rear-east', kind: 'entry', link: ['GARDEN', 'CONSERVATORY'], hinge: -1 },
]);
run('x', -24, -18, 18, OUTER, MAP.height, [
  { at: 12, span: 1.6, door: 'service', kind: 'entry', link: ['WEST YARD', 'DINING ROOM'] },
]);
run('x', 24, -18, 18, OUTER, MAP.height, [
  { at: -12, span: 1.6, door: 'greenhouse', kind: 'entry', link: ['EAST YARD', 'CONSERVATORY'], hinge: -1 },
]);

/* ---- 대홀과 양쪽 날개를 가르는 내벽 + 문 6개 ------------------------------ */
run('x', -9, -18, 18, INNER, MAP.height, [
  { at: -12, span: 1.8, door: 'hall-library', link: ['GRAND HALL', 'LIBRARY'] },
  { at: 0, span: 1.8, door: 'hall-drawing', link: ['GRAND HALL', 'DRAWING ROOM'], hinge: -1 },
  { at: 12, span: 1.8, door: 'hall-dining', link: ['GRAND HALL', 'DINING ROOM'] },
]);
run('x', 9, -18, 18, INNER, MAP.height, [
  { at: -12, span: 1.8, door: 'hall-conservatory', link: ['GRAND HALL', 'CONSERVATORY'] },
  { at: 0, span: 1.8, door: 'hall-gallery', link: ['GRAND HALL', 'GALLERY'], hinge: -1 },
  { at: 12, span: 1.8, door: 'hall-guest', link: ['GRAND HALL', 'GUEST SUITE'] },
]);

/* ---- 날개 안쪽 방을 나누는 벽 + 문 4개 ------------------------------------ */
run('z', -6, -24, -9, INNER, MAP.height, [
  { at: -16.5, span: 1.8, door: 'library-drawing', link: ['LIBRARY', 'DRAWING ROOM'] },
]);
run('z', 6, -24, -9, INNER, MAP.height, [
  { at: -16.5, span: 1.8, door: 'drawing-dining', link: ['DRAWING ROOM', 'DINING ROOM'], hinge: -1 },
]);
run('z', -6, 9, 24, INNER, MAP.height, [
  { at: 16.5, span: 1.8, door: 'conservatory-gallery', link: ['CONSERVATORY', 'GALLERY'] },
]);
run('z', 6, 9, 24, INNER, MAP.height, [
  { at: 16.5, span: 1.8, door: 'gallery-guest', link: ['GALLERY', 'GUEST SUITE'], hinge: -1 },
]);

/* ========================================================================== *
 *  2. 구역 (방과 야외)
 * ========================================================================== */
export const ROOMS = [
  { name: 'GRAND HALL', label: '중앙 대홀', x: 0, z: 0, w: 17.6, d: 35.6 },
  { name: 'LIBRARY', label: '서재', x: -16.5, z: -12, w: 14.4, d: 11.4 },
  { name: 'DRAWING ROOM', label: '응접실', x: -16.5, z: 0, w: 14.4, d: 11.4 },
  { name: 'DINING ROOM', label: '연회실', x: -16.5, z: 12, w: 14.4, d: 11.4 },
  { name: 'CONSERVATORY', label: '온실', x: 16.5, z: -12, w: 14.4, d: 11.4 },
  { name: 'GALLERY', label: '미술관', x: 16.5, z: 0, w: 14.4, d: 11.4 },
  { name: 'GUEST SUITE', label: '게스트 스위트', x: 16.5, z: 12, w: 14.4, d: 11.4 },
];

export const AREAS = [
  { name: 'COURTYARD', label: '앞마당 · 진입로', x: 0, z: 26, w: 63, d: 15.6, outdoor: true },
  { name: 'WEST YARD', label: '서측 통로', x: -28, z: 0, w: 7.6, d: 67, outdoor: true },
  { name: 'EAST YARD', label: '동측 통로', x: 28, z: 0, w: 7.6, d: 67, outdoor: true },
  { name: 'GARDEN', label: '후원 테라스', x: 0, z: -26, w: 63, d: 15.6, outdoor: true },
  ...ROOMS.map((r) => ({ ...r, outdoor: false })),
];

/** 좌표가 속한 구역 이름. 실내 우선. */
export function zoneAt(x, z) {
  for (const a of AREAS) {
    if (Math.abs(x - a.x) <= a.w / 2 && Math.abs(z - a.z) <= a.d / 2) return a.name;
  }
  return 'COURTYARD';
}

export const isIndoors = (x, z) => {
  const i = MAP.interior;
  return x > i.minX && x < i.maxX && z > i.minZ && z < i.maxZ;
};

/* ========================================================================== *
 *  3. 가구와 소품
 * ========================================================================== */
export const FURNITURE = [];
const part = (x, z, w, d, h, y = 0, material = 'wood', ry = 0) =>
  FURNITURE.push({ x, z, w, d, h, y, material, ry });

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

/* ---- 실내 ---------------------------------------------------------------- */
// 서재: 서쪽 벽을 따라 책장, 가운데 열람 책상
for (const z of [-16, -13, -10]) shelf(-23.1, z, 1.4, 2.6);
for (const x of [-22.6, -19.8]) shelf(x, -17.1, 2.4, 1.2);
table(-15, -12, 3.6, 1.6);
sofa(-12.6, -15, Math.PI / 2);
// 응접실
sofa(-16.5, 2); sofa(-16.5, -2, Math.PI); table(-16.5, 0, 2.2, 1.2);
shelf(-23.1, 0, 1.4, 4.2);
// 연회실: 긴 식탁과 의자
table(-16.5, 12, 6, 2.2);
for (const x of [-19, -16.5, -14]) for (const z of [9.8, 14.2]) {
  part(x, z, .8, .8, .55, 0, 'velvet'); part(x, z + (z > 12 ? .35 : -.35), .8, .1, .6, .55, 'velvet');
}
shelf(-23.1, 15.4, 1.4, 3.4);
// 온실: 화단과 유리 진열대
for (const z of [-16, -8]) part(21, z, 4.6, 1.3, .75, 0, 'stone');
part(13.5, -12, 1.2, 5.4, .9, 0, 'glass');
table(16.5, -14, 3.2, 1.6);
// 미술관: 좌대
for (const z of [-3, 3]) part(18, z, 1, 1, 1.15, 0, 'stone');
part(12.2, 0, 1.1, 6.2, 1.1, 0, 'stone');
// 게스트 스위트
sofa(16.5, 14); table(16.5, 10.5, 3.2, 1.8);
shelf(23.1, 12, 1.4, 3.6);
crateStack(20.5, 16); crateStack(22, 15.4, .4);
// 대홀: 응접 소파와 의식용 계단
sofa(-5, 5, Math.PI / 2); sofa(5, 5, -Math.PI / 2); table(0, 5, 2.4, 1.2);
for (let i = 0; i < 12; i++) part(0, -6 - i * .42, 5, .42, (i + 1) * .2, 0, 'stone');
part(0, -13.4, 8, 5.2, 2.4, 0, 'stone');
for (const x of [-4.2, 4.2]) part(x, -13.4, .25, 5.2, 1.1, 2.4, 'brass');
for (const x of [-6.5, 6.5]) for (const z of [-4, 10]) part(x, z, .65, .65, 6.9, 0, 'stone');

/* ---- 앞마당 -------------------------------------------------------------- */
part(0, 19.4, 9, 2.4, .22, 0, 'stone');                 // 현관 포치
for (const x of [-4.2, 4.2]) part(x, 19.6, .7, .7, 3.6, .22, 'stone');
for (const x of [-20, 20]) hedge(x, 26, 11, 1.3);        // 진입로 양쪽 생울타리
for (const z of [21.5, 30.5]) { hedge(-7.4, z, 1.3, 5.4); hedge(7.4, z, 1.3, 5.4); }
planter(-10.5, 20.5); planter(10.5, 20.5);
van(-13.5, 23.5, .18); van(14, 27.5, -.12);
bench(-3.6, 24.6, Math.PI / 2); bench(3.6, 24.6, -Math.PI / 2);
// 게이트 경비 초소. 앞면(z 작은 쪽)이 열려 있고 카운터는 한쪽으로 치워 두어
// 사람이 들어갈 통로가 남는다.
part(-15.8, 31, .3, 3.6, 2.6, 0, 'wood'); part(-11.2, 31, .3, 3.6, 2.6, 0, 'wood');
part(-13.5, 32.65, 4.9, .3, 2.6, 0, 'wood'); part(-13.5, 31, 4.9, 3.6, .2, 2.6, 'wood');
part(-14.4, 30.4, 2.0, .7, .95, 0, 'wood');
crateStack(9.6, 31.4); crateStack(11, 30.8, .5);

/* ---- 서·동측 통로 -------------------------------------------------------- */
for (const z of [-13, -2, 9]) { crateStack(-30, z); }
part(-28.5, 5, 2.2, 1.6, 1.5, 0, 'metal');              // 발전기
hedge(-26.4, 20.5, 1.3, 4.4); hedge(26.4, 20.5, 1.3, 4.4);
for (const z of [-14, -4, 6, 16]) part(29.6, z, 1.4, 3.4, 1.2, 0, 'glass');  // 온실 골조
bench(26.6, -8, Math.PI / 2); bench(-26.6, 14, Math.PI / 2);

/* ---- 후원 테라스 --------------------------------------------------------- */
for (let i = 0; i < 3; i++) part(0, -18.7 - i * .5, 22, .5, .4 - i * .12, 0, 'stone');
part(0, -21, 22, 4.2, .16, 0, 'stone');
for (const x of [-16, 16]) hedge(x, -24, 9, 1.3);
for (const z of [-27, -31]) { hedge(-7.4, z, 1.3, 3.4); hedge(7.4, z, 1.3, 3.4); }
bench(-4.4, -24.6); bench(4.4, -24.6);
crateStack(-19.5, -30); crateStack(19.5, -30, .6);

export const PROPS = [
  { model: 'vase', x: -7, z: 14, ry: 0, s: .7 },
  { model: 'vase', x: 7, z: 14, ry: 0, s: .7 },
  { model: 'vase', x: 18, z: -3, yOff: 1.15, ry: 0, s: .65 },
  { model: 'vase', x: 18, z: 3, yOff: 1.15, ry: 0, s: .65 },
  { model: 'crate', x: 20.4, z: 8, ry: .4, s: 1 },
  { model: 'crate', x: 21.8, z: 8, ry: -.2, s: 1.25 },
  { model: 'barrel', x: 22, z: -15.4, ry: 0, s: 1 },
  { model: 'barrel', x: -29.4, z: 16, ry: 0, s: 1 },
  { model: 'barrel', x: -28.6, z: -22, ry: 0, s: 1 },
  { model: 'well', x: 0, z: 25.6, ry: 0, s: 1 },
  { model: 'well', x: 0, z: -28, ry: 0, s: 1 },
];
for (const p of PROPS) {
  const [w, h, d] = MODELS[p.model].fit.size ?? [1.6, MODELS[p.model].fit.height, 1.6];
  p.col = { w: w * p.s, h: h * p.s, d: d * p.s };
}

/* ========================================================================== *
 *  4. 조명
 * ========================================================================== */
export const LIGHTS = [
  { x: 0, y: 5.5, z: 4, color: 0xffdfad, intensity: 80, distance: 27, kind: 'chandelier' },
  { x: 0, y: 5.5, z: -11, color: 0xffdfa8, intensity: 60, distance: 22, kind: 'chandelier' },
  ...ROOMS.slice(1).map((r) => ({
    x: r.x, y: 5.2, z: r.z, distance: 21, intensity: 55, kind: 'chandelier',
    color: r.name === 'CONSERVATORY' ? 0xc9e7ff : 0xffd8a4,
  })),
  // 야외 가로등. 밤이므로 빛 사이의 어둠이 곧 엄폐다.
  { x: -11, y: 4.2, z: 30, color: 0xbfd4e8, intensity: 34, distance: 17, kind: 'lamp' },
  { x: 11, y: 4.2, z: 22, color: 0xbfd4e8, intensity: 34, distance: 17, kind: 'lamp' },
  { x: 0, y: 4.6, z: 20.4, color: 0xffe0b0, intensity: 26, distance: 13, kind: 'lamp' },
  { x: -28, y: 4.2, z: 10, color: 0xbfd4e8, intensity: 26, distance: 15, kind: 'lamp' },
  { x: 28, y: 4.2, z: -6, color: 0xbfd4e8, intensity: 26, distance: 15, kind: 'lamp' },
  { x: 0, y: 4.2, z: -24, color: 0xbfd4e8, intensity: 30, distance: 16, kind: 'lamp' },
];

/* ========================================================================== *
 *  5. 스폰 / 목표 / 경비 배치
 * ========================================================================== */
/** 팀은 정문 바깥 진입로에서 시작한다. */
export const SPAWNS = [
  { x: -2.2, z: 30.4, yaw: 0 }, { x: 2.2, z: 30.4, yaw: 0 },
  { x: -2.2, z: 32.2, yaw: 0 }, { x: 2.2, z: 32.2, yaw: 0 },
];

/** 철수 지점 (담장 정문). */
export const EXTRACTION = { x: 0, z: 33, radius: 3.2, label: '정문 · 철수' };

/** 폭발물 두 개. 기존 목표 이름을 유지한다. */
export const BOMB_SITES = [
  { id: 'A', x: -20.2, z: -10, label: '서재 A', room: 'LIBRARY' },
  { id: 'B', x: 16.6, z: -16.4, label: '온실 B', room: 'CONSERVATORY' },
];

/** 증거 후보 위치. 임무 시작 때 일부만 고른다. */
export const EVIDENCE_SPOTS = [
  { id: 'ledger', x: -15, z: -13.3, label: '거래 장부', room: 'LIBRARY' },
  { id: 'drive', x: 13.8, z: 2.4, label: '암호 드라이브', room: 'GALLERY' },
  { id: 'radio', x: -21.6, z: 14.2, label: '무전 기록', room: 'DINING ROOM' },
  { id: 'passport', x: 16.5, z: 8.4, label: '위조 여권', room: 'GUEST SUITE' },
  { id: 'cash', x: -20.6, z: 1.2, label: '현금 가방', room: 'DRAWING ROOM' },
  { id: 'manifest', x: -14.4, z: 31.6, label: '초소 출입 기록', room: 'COURTYARD' },
];

/** 방마다 경비가 설 수 있는 자리. 임무 시작 때 일부만 채운다. */
export const POSTS = [
  // 야외 경비. 시작 지점을 정면으로 보고 있는 자리는 서버가 배치에서 제외한다.
  { room: 'COURTYARD', x: -12.4, z: 31.4, yaw: Math.PI },
  { room: 'COURTYARD', x: 12.4, z: 31.4, yaw: -Math.PI / 2 },
  { room: 'COURTYARD', x: -15.6, z: 21.4, yaw: Math.PI * .8 },
  { room: 'COURTYARD', x: 5.4, z: 22.4, yaw: -Math.PI / 2 },
  { room: 'COURTYARD', x: -19.6, z: 23.4, yaw: 0 },
  { room: 'COURTYARD', x: 19.6, z: 23.4, yaw: 0 },
  { room: 'COURTYARD', x: 13.4, z: 20.4, yaw: Math.PI / 2 },
  { room: 'WEST YARD', x: -28.4, z: 12.6, yaw: -Math.PI / 2 },
  { room: 'WEST YARD', x: -28.4, z: -6.4, yaw: 0 },
  { room: 'EAST YARD', x: 27.6, z: -10.4, yaw: Math.PI / 2 },
  { room: 'EAST YARD', x: 27.6, z: 8.4, yaw: 0 },
  { room: 'GARDEN', x: -10.6, z: -24.8, yaw: 0 },
  { room: 'GARDEN', x: 10.6, z: -26.2, yaw: 0 },
  { room: 'GARDEN', x: 0, z: -30.4, yaw: 0 },
  { room: 'GRAND HALL', x: -3.4, z: 10.6, yaw: 0 },
  { room: 'GRAND HALL', x: 3.6, z: -2.4, yaw: Math.PI },
  { room: 'LIBRARY', x: -17.8, z: -9.2, yaw: Math.PI / 2 },
  { room: 'LIBRARY', x: -13.6, z: -16, yaw: Math.PI / 2 },
  { room: 'DRAWING ROOM', x: -12.4, z: 3.4, yaw: -Math.PI / 2 },
  { room: 'DRAWING ROOM', x: -20.4, z: -3.4, yaw: 0 },
  { room: 'DINING ROOM', x: -12.4, z: 15.4, yaw: -Math.PI / 2 },
  { room: 'DINING ROOM', x: -21.4, z: 9.4, yaw: Math.PI / 2 },
  { room: 'CONSERVATORY', x: 12.4, z: -15.4, yaw: -Math.PI / 2 },
  { room: 'CONSERVATORY', x: 19.4, z: -12.6, yaw: Math.PI / 2 },
  { room: 'GALLERY', x: 13.4, z: -3.4, yaw: -Math.PI / 2 },
  { room: 'GALLERY', x: 21.4, z: 3.4, yaw: Math.PI / 2 },
  { room: 'GUEST SUITE', x: 12.6, z: 13.4, yaw: -Math.PI / 2 },
  { room: 'GUEST SUITE', x: 21.4, z: 12.6, yaw: Math.PI / 2 },
];

/** 민간인이 숨을 수 있는 자리. */
export const CIVILIAN_SPOTS = [
  { room: 'DINING ROOM', x: -22, z: 12.4 },
  { room: 'DRAWING ROOM', x: -22, z: 4.4 },
  { room: 'GUEST SUITE', x: 22, z: 9.4 },
  { room: 'GALLERY', x: 21.6, z: -3.6 },
  { room: 'LIBRARY', x: -11.4, z: -11.4 },
  { room: 'CONSERVATORY', x: 21.6, z: -4.4 },
  { room: 'GRAND HALL', x: -6.4, z: 15.4 },
];

/** 주요 용의자가 인질과 함께 농성할 수 있는 방. */
export const HVT_ROOMS = ['DINING ROOM', 'GALLERY', 'GUEST SUITE', 'DRAWING ROOM'];

export const BOT_SPAWNS = POSTS.map((p) => ({ x: p.x, z: p.z }));
export const PATROL_NODES = POSTS.map((p) => ({ x: p.x, z: p.z }));

/* ========================================================================== *
 *  6. 콜라이더와 브로드페이즈
 * ========================================================================== */
export const COLLIDERS = [
  ...WALLS.map((w) => ({ ...w, kind: 'wall' })),
  ...FURNITURE.map((f) => ({ ...f, kind: 'prop' })),
  ...PROPS.map((p) => ({
    x: p.x, z: p.z, y: p.yOff || 0, ...p.col, ry: p.ry || 0, kind: 'prop',
    shape: p.model === 'crate' ? 'box' : 'cylinder',
  })),
];

const top = (c) => (c.y || 0) + c.h;

/* 콜라이더가 300개를 넘으면 전수 검사는 매 틱 수십만 번이 된다. 4m 격자에
 * 미리 담아 두고 주변 칸만 본다. 배열 단위로 캐시하므로 테스트에서 임시 배열을
 * 넘겨도 그대로 동작한다. */
const CELL = 4;
const gridCache = new WeakMap();
const cellKey = (cx, cz) => cx * 100003 + cz;

function colliderExtent(c) {
  if (c.shape === 'cylinder') return { ex: c.w / 2, ez: c.w / 2 };
  const co = Math.abs(Math.cos(c.ry || 0)), si = Math.abs(Math.sin(c.ry || 0));
  return { ex: (co * c.w + si * c.d) / 2, ez: (si * c.w + co * c.d) / 2 };
}

function colliderGrid(list) {
  let grid = gridCache.get(list);
  if (grid) return grid;
  grid = new Map();
  for (const c of list) {
    const { ex, ez } = colliderExtent(c);
    const x0 = Math.floor((c.x - ex) / CELL), x1 = Math.floor((c.x + ex) / CELL);
    const z0 = Math.floor((c.z - ez) / CELL), z1 = Math.floor((c.z + ez) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = cellKey(cx, cz);
        const bucket = grid.get(key);
        if (bucket) bucket.push(c); else grid.set(key, [c]);
      }
    }
  }
  gridCache.set(list, grid);
  return grid;
}

/** (x,z) 반경 r 주변에 있을 수 있는 콜라이더만 모아 준다. */
export function nearbyColliders(x, z, r, list = COLLIDERS) {
  if (list.length < 48) return list;
  const grid = colliderGrid(list);
  const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
  const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
  if (x0 === x1 && z0 === z1) return grid.get(cellKey(x0, z0)) || EMPTY;
  const out = new Set();
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const bucket = grid.get(cellKey(cx, cz));
      if (bucket) for (const c of bucket) out.add(c);
    }
  }
  return [...out];
}
const EMPTY = [];

/* ========================================================================== *
 *  7. 충돌 / 시야 판정
 * ========================================================================== */
function local(x, z, c) {
  const co = Math.cos(c.ry || 0), si = Math.sin(c.ry || 0), dx = x - c.x, dz = z - c.z;
  return { x: co * dx - si * dz, z: si * dx + co * dz, co, si };
}

export function overlaps(x, z, r, c) {
  if (c.shape === 'cylinder') return Math.hypot(x - c.x, z - c.z) < r + c.w / 2;
  const p = local(x, z, c);
  return Math.hypot(p.x - Math.max(-c.w / 2, Math.min(c.w / 2, p.x)),
    p.z - Math.max(-c.d / 2, Math.min(c.d / 2, p.z))) < r;
}

export function outOfBounds(x, z) {
  return Math.abs(x) > HALF_W - .2 || Math.abs(z) > HALF_D - .2;
}

// 원 vs 회전 사각형. 모서리는 둥글게 처리한다(보이지 않는 큰 상자가 생기지 않게).
export function resolveCircle(x, z, r, colliders = COLLIDERS, feet = 0, height = 1.8) {
  const candidates = nearbyColliders(x, z, r + 1.2, colliders);
  for (let pass = 0; pass < 4; pass++) for (const c of candidates) {
    if (feet >= top(c) - .001 || feet + height <= (c.y || 0) + .001) continue;
    if (c.shape === 'cylinder') {
      const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), limit = c.w / 2 + r;
      if (d < limit) { x += d > 1e-8 ? dx * (limit - d) / d : limit; z += d > 1e-8 ? dz * (limit - d) / d : 0; }
      continue;
    }
    const p = local(x, z, c), hw = c.w / 2, hd = c.d / 2;
    let dx = p.x - Math.max(-hw, Math.min(hw, p.x)), dz = p.z - Math.max(-hd, Math.min(hd, p.z));
    const len = Math.hypot(dx, dz); if (len >= r) continue;
    if (len > 1e-8) { dx *= (r - len) / len; dz *= (r - len) / len; }
    else if (hw - Math.abs(p.x) < hd - Math.abs(p.z)) { dx = (p.x >= 0 ? 1 : -1) * (hw - Math.abs(p.x) + r); dz = 0; }
    else { dz = (p.z >= 0 ? 1 : -1) * (hd - Math.abs(p.z) + r); dx = 0; }
    x += p.co * dx + p.si * dz; z += -p.si * dx + p.co * dz;
  }
  return {
    x: Math.max(-HALF_W + .2 + r, Math.min(HALF_W - .2 - r, x)),
    z: Math.max(-HALF_D + .2 + r, Math.min(HALF_D - .2 - r, z)),
  };
}

export function moveBody(pos, velocity, dt, opts = {}, colliders = COLLIDERS) {
  const { radius = .32, height = 1.8, stepHeight = .32, grounded = false, gravity = -18 } = opts;
  const p = { ...pos }, v = { ...velocity };
  let onGround = grounded;
  const steps = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const oldY = p.y;
    v.y += gravity * h;
    let ny = p.y + v.y * h, nx = p.x + v.x * h, nz = p.z + v.z * h;
    const near = nearbyColliders(nx, nz, radius + 1.2, colliders);
    if (onGround && v.y <= 0) {
      let stair = p.y;
      for (const c of near) {
        if (top(c) > p.y + .001 && top(c) <= p.y + stepHeight && overlaps(nx, nz, radius, c)) stair = Math.max(stair, top(c));
      }
      if (stair > p.y) {
        const fit = resolveCircle(nx, nz, radius, colliders, stair, height);
        if (Math.hypot(fit.x - nx, fit.z - nz) < .001) { p.y = ny = stair; v.y = 0; }
      }
    }
    // 올라가는 머리를 옆 판정 전에 잡아 준다. 그러지 않으면 선반 아래에서
    // 몸이 옆으로 튕겨 나간다.
    if (v.y > 0) {
      let headLimit = MAP.height;
      for (const c of near) if ((c.y || 0) >= oldY + height - .002 && overlaps(nx, nz, radius, c)) headLimit = Math.min(headLimit, c.y);
      if (ny + height > headLimit) { ny = headLimit - height; v.y = 0; }
    }
    const fixed = resolveCircle(nx, nz, radius, colliders, Math.max(p.y, ny), height);
    if (Math.abs(fixed.x - nx) > .001) v.x = 0;
    if (Math.abs(fixed.z - nz) > .001) v.z = 0;
    p.x = fixed.x; p.z = fixed.z; onGround = false;
    if (v.y <= 0) {
      let support = 0;
      for (const c of nearbyColliders(p.x, p.z, radius + 1.2, colliders)) {
        if (top(c) <= Math.max(oldY, p.y) + .002 && top(c) >= ny - .002 && overlaps(p.x, p.z, radius, c)) support = Math.max(support, top(c));
      }
      if (ny <= support + .002) { ny = support; v.y = 0; onGround = true; }
    } else {
      let headLimit = MAP.height;
      for (const c of nearbyColliders(p.x, p.z, radius + 1.2, colliders)) {
        if ((c.y || 0) >= oldY + height - .002 && overlaps(p.x, p.z, radius, c)) headLimit = Math.min(headLimit, c.y);
      }
      if (ny + height > headLimit) { ny = headLimit - height; v.y = 0; }
    }
    p.y = Math.max(0, ny);
  }
  return { pos: p, vel: v, onGround };
}

/**
 * (x,z) 에서 발을 디딜 높이. 계단·테라스·포치 위에 NPC 를 올려 놓는 데 쓴다.
 * from + step 보다 높은 면은 "올라갈 수 없는 것"으로 보고 무시한다.
 */
export function groundHeight(x, z, radius = .38, colliders = COLLIDERS, from = 0, step = .45) {
  let best = 0;
  for (const c of nearbyColliders(x, z, radius + 1.2, colliders)) {
    const t = top(c);
    if (t <= from + step && t > best && overlaps(x, z, radius, c)) best = t;
  }
  return best;
}

function boxRay(ox, oy, oz, dx, dy, dz, maxDist, c) {
  if (c.shape === 'cylinder') {
    const px = ox - c.x, pz = oz - c.z, a = dx * dx + dz * dz, b = 2 * (px * dx + pz * dz);
    const k = px * px + pz * pz - c.w * c.w / 4;
    let near = 0, far = maxDist;
    if (a < 1e-12) { if (k > 0) return Infinity; }
    else {
      const disc = b * b - 4 * a * k; if (disc < 0) return Infinity;
      const root = Math.sqrt(disc);
      near = Math.max(near, (-b - root) / (2 * a)); far = Math.min(far, (-b + root) / (2 * a));
    }
    if (Math.abs(dy) < 1e-8) { if (oy < (c.y || 0) || oy > top(c)) return Infinity; }
    else {
      const t0 = ((c.y || 0) - oy) / dy, t1 = (top(c) - oy) / dy;
      near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1));
    }
    return near <= far ? near : Infinity;
  }
  const p = local(ox, oz, c), lx = p.co * dx - p.si * dz, lz = p.si * dx + p.co * dz;
  let near = 0, far = maxDist;
  for (const [o, d, lo, hi] of [[p.x, lx, -c.w / 2, c.w / 2], [oy, dy, c.y || 0, top(c)], [p.z, lz, -c.d / 2, c.d / 2]]) {
    if (Math.abs(d) < 1e-8) { if (o < lo || o > hi) return Infinity; continue; }
    const a = (lo - o) / d, b = (hi - o) / d;
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return Infinity;
  }
  return near;
}

/** 선분이 지나는 칸의 콜라이더만 추린다 (광선 판정 브로드페이즈). */
function segmentCandidates(ox, oz, dx, dz, maxDist, list) {
  if (list.length < 48) return list;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return nearbyColliders(ox, oz, 2, list);
  const span = Math.min(maxDist, 200), stepCount = Math.ceil(span / CELL) + 1;
  const out = new Set();
  for (let i = 0; i <= stepCount; i++) {
    const t = Math.min(span, i * CELL);
    for (const c of nearbyColliders(ox + dx / len * t, oz + dz / len * t, CELL, list)) out.add(c);
  }
  return [...out];
}

export function segmentHitsBox(ax, az, dx, dz, c) {
  return boxRay(ax, (c.y || 0) + c.h / 2, az, dx, 0, dz, 1, c) <= 1;
}

export function hasLineOfSight(ax, az, bx, bz, eyeH = 1.4, colliders = COLLIDERS) {
  const dx = bx - ax, dz = bz - az;
  return !segmentCandidates(ax, az, dx, dz, Math.hypot(dx, dz), colliders)
    .some((c) => boxRay(ax, eyeH, az, dx, 0, dz, 1, c) <= 1);
}

export function rayWallDistance(ox, oz, dx, dz, maxDist, eyeH = 1.4, colliders = COLLIDERS) {
  let best = Infinity;
  for (const c of segmentCandidates(ox, oz, dx, dz, maxDist, colliders)) {
    best = Math.min(best, boxRay(ox, eyeH, oz, dx, 0, dz, maxDist, c));
  }
  return best;
}

export function rayObstacleDistance(o, d, maxDist, colliders = COLLIDERS) {
  let best = maxDist;
  for (const c of segmentCandidates(o.x, o.z, d.x, d.z, maxDist, colliders)) {
    best = Math.min(best, boxRay(o.x, o.y, o.z, d.x, d.y, d.z, best, c));
  }
  if (Math.abs(d.y) > 1e-8) {
    // 바닥과 (실내라면) 천장
    for (const y of [0, MAP.height]) {
      const t = (y - o.y) / d.y;
      if (t >= 0 && t < best && (y === 0 || isIndoors(o.x + d.x * t, o.z + d.z * t))) best = t;
    }
  }
  return best;
}

/** 두 점 사이를 가로막는 고체의 개수 (소리 감쇠용). */
export function obstaclesBetween(a, b, eyeH = 1.3, colliders = COLLIDERS) {
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  if (len < .001) return 0;
  let count = 0;
  for (const c of segmentCandidates(a.x, a.z, dx, dz, len, colliders)) {
    if ((c.y || 0) > eyeH || top(c) < eyeH) continue;
    if (boxRay(a.x, eyeH, a.z, dx, 0, dz, 1, c) <= 1) count++;
  }
  return count;
}

/* ========================================================================== *
 *  8. 길찾기
 *
 *  0.5m 격자를 한 번만 만들어 두고 매번 너비 우선 탐색만 한다. 문은 봇이 열 수
 *  있으므로 통행 가능한 것으로 본다(대신 실제로 열 때 소리가 난다).
 * ========================================================================== */
const NAV_STEP = .5, NAV_RADIUS = .4;
const NAV_W = Math.round(MAP.width / NAV_STEP), NAV_D = Math.round(MAP.depth / NAV_STEP);
const NAV_LEFT = -HALF_W + NAV_STEP / 2, NAV_TOP = -HALF_D + NAV_STEP / 2;
let navFree = null, navEdges = null;

const navPoint = (i) => ({
  x: NAV_LEFT + (i % NAV_W) * NAV_STEP,
  z: NAV_TOP + Math.floor(i / NAV_W) * NAV_STEP,
});
const navIndex = (p) => {
  const cx = Math.max(0, Math.min(NAV_W - 1, Math.round((p.x - NAV_LEFT) / NAV_STEP)));
  const cz = Math.max(0, Math.min(NAV_D - 1, Math.round((p.z - NAV_TOP) / NAV_STEP)));
  return cz * NAV_W + cx;
};

function buildNav() {
  navFree = new Uint8Array(NAV_W * NAV_D);
  navEdges = new Uint8Array(NAV_W * NAV_D);
  // 0.42m 이하의 단·계단·테라스는 걸어 올라갈 수 있으므로 장애물이 아니다.
  const solid = COLLIDERS.filter((c) => (c.y || 0) < 1.5 && top(c) > .42);
  for (let i = 0; i < navFree.length; i++) {
    const p = navPoint(i);
    navFree[i] = nearbyColliders(p.x, p.z, NAV_RADIUS + 1.2, solid)
      .some((c) => overlaps(p.x, p.z, NAV_RADIUS, c)) ? 0 : 1;
  }
  // 대각선 끼임을 막기 위해 이웃으로 가는 선분도 미리 확인한다.
  const dirs = [[1, 0, 1], [-1, 0, 2], [0, 1, 4], [0, -1, 8]];
  for (let i = 0; i < navFree.length; i++) {
    if (!navFree[i]) continue;
    const cx = i % NAV_W, cz = Math.floor(i / NAV_W), a = navPoint(i);
    for (const [ox, oz, bit] of dirs) {
      const nx = cx + ox, nz = cz + oz;
      if (nx < 0 || nx >= NAV_W || nz < 0 || nz >= NAV_D) continue;
      const j = nz * NAV_W + nx;
      if (!navFree[j]) continue;
      const b = navPoint(j);
      const blocked = nearbyColliders((a.x + b.x) / 2, (a.z + b.z) / 2, NAV_STEP + NAV_RADIUS + 1.2, solid)
        .some((c) => segmentHitsBox(a.x, a.z, b.x - a.x, b.z - a.z,
          { ...c, w: c.w + NAV_RADIUS * 2, d: c.d + NAV_RADIUS * 2 }));
      if (!blocked) navEdges[i] |= bit;
    }
  }
}

function nearestFree(p) {
  const start = navIndex(p);
  if (navFree[start]) return start;
  // 나선형으로 가까운 자유 칸을 찾는다 (전수 검색보다 훨씬 빠르다).
  const cx = start % NAV_W, cz = Math.floor(start / NAV_W);
  for (let r = 1; r < 24; r++) {
    for (let dx = -r; dx <= r; dx++) for (const dz of [-r, r]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx >= 0 && nx < NAV_W && nz >= 0 && nz < NAV_D && navFree[nz * NAV_W + nx]) return nz * NAV_W + nx;
    }
    for (let dz = -r + 1; dz <= r - 1; dz++) for (const dx of [-r, r]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx >= 0 && nx < NAV_W && nz >= 0 && nz < NAV_D && navFree[nz * NAV_W + nx]) return nz * NAV_W + nx;
    }
  }
  return -1;
}

const prevBuffer = new Int32Array(NAV_W * NAV_D);
const queueBuffer = new Int32Array(NAV_W * NAV_D);
// [격자 인덱스 증감, navEdges 비트] - buildNav 의 dirs 순서와 같아야 한다.
const NAV_MOVES = [[1, 1], [-1, 2], [NAV_W, 4], [-NAV_W, 8]];

/** start 에서 goal 까지의 경유점 목록. 길이 0 이면 경로가 없다. */
export function findRoute(start, goal) {
  if (!navFree) buildNav();
  const a = nearestFree(start), b = nearestFree(goal);
  if (a < 0 || b < 0) return [];
  if (a === b) return [navPoint(b)];
  prevBuffer.fill(-1);
  prevBuffer[a] = a;
  queueBuffer[0] = a;
  let head = 0, tail = 1;
  while (head < tail && prevBuffer[b] < 0) {
    const i = queueBuffer[head++], edges = navEdges[i];
    for (const [offset, bit] of NAV_MOVES) {
      if (!(edges & bit)) continue;
      const j = i + offset;
      if (j < 0 || j >= navFree.length || prevBuffer[j] >= 0) continue;
      prevBuffer[j] = i;
      queueBuffer[tail++] = j;
    }
  }
  if (prevBuffer[b] < 0) return [];
  const path = [];
  for (let i = b; i !== a; i = prevBuffer[i]) path.push(navPoint(i));
  return path.reverse();
}

/** 격자 위에서 서로 닿을 수 있는지 (경로 존재 여부만 빠르게 확인). */
export function isReachable(from, to) { return findRoute(from, to).length > 0; }

/* ========================================================================== *
 *  9. 엄폐 지점
 *
 *  허리 높이 장애물의 네 변 바깥쪽을 후보로 삼는다. AI 가 "벽 뒤에 숨는" 판단을
 *  할 때 쓴다.
 * ========================================================================== */
export const COVER_POINTS = [];
for (const c of COLLIDERS) {
  const height = top(c);
  if ((c.y || 0) > .35 || height < .5 || height > 2.0) continue;
  const co = Math.cos(c.ry || 0), si = Math.sin(c.ry || 0);
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const lx = sx * (c.w / 2 + .55), lz = sz * (c.d / 2 + .55);
    const x = c.x + co * lx + si * lz, z = c.z - si * lx + co * lz;
    if (Math.abs(x) > HALF_W - 1 || Math.abs(z) > HALF_D - 1) continue;
    const fixed = resolveCircle(x, z, .4);
    if (Math.hypot(fixed.x - x, fixed.z - z) > .01) continue;
    COVER_POINTS.push({ x, z, height, cx: c.x, cz: c.z, room: zoneAt(x, z) });
  }
}
