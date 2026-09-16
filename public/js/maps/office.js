/* =============================================================================
 *  maps/office.js  -  한빛타워 사옥 (사무실 맵)
 *
 *  같은 사람들이 만든 다른 게임(game22)의 사옥 모형을 이 게임의 규칙으로 옮겨
 *  지은 것이다. 저쪽의 평면 - 남쪽 유리문과 리셉션, 한가운데 승강기 코어,
 *  북동쪽 대회의실, 남서쪽 휴게실 겸 탕비실, 동쪽 벽의 폰부스, 서버실 - 을
 *  그대로 가져오되, 층을 쌓는 대신 한 층을 크게 펼쳐 방을 늘렸다. 이 게임은
 *  층을 오갈 수 없고 방-복도-문으로만 전개되기 때문이다.
 *
 *  저택과 무엇이 다른가
 *    - 층고가 낮다 (3.6m vs 7m). 실내가 답답하고, 수류탄이 천장에 잘 맞는다.
 *    - 복도가 길고 곧다. 한 번 발각되면 끝까지 총알이 날아온다.
 *    - 조명이 차가운 형광등이다. 정전되면 비상구 표시등 색만 남는다.
 *    - 소음원이 있다. 서버실 냉각팬 · 복사기 · 승강기가 주기적으로 소리를
 *      내고, NPC 는 그 소리에도 반응한다. 그 틈에 움직이는 것이 이 맵의 요령이다.
 *    - 화재경보기를 당겨 반대편으로 사람을 끌어낼 수 있다.
 *
 *  좌표
 *    - 실내는 x ∈ [-46, 46], z ∈ [-30, 30]. 그 바깥은 광장과 주차장이다.
 *    - -Z 가 북쪽. yaw = 0 은 -Z 를 본다.
 *
 *     x -46   -31   -18   -6     14    28    46
 *   z -30 ┌──────┬─────┬─────┬─────┬─────┬─────┐
 *         │ 서버 │ 통신 │임원 │  대회의실 │자료│인쇄│   북쪽 줄 6칸
 *   z -18 ├──────┴─────┴─────┴─────┴─────┴─────┤
 *         │ ═══════════ 북 복도 ═════════════ │
 *   z-13.5├──────┬─────┬───────────┬─────┬─────┤
 *         │ 탕비 │개발서│           │개발동│회의A│
 *   z   0 ├──────┼─────┤ 중앙 코어  ├─────┼─────┤   가운데 8칸 + 코어
 *         │ 휴게 │디자인│  (승강기)  │ 품질 │회의B│
 *   z 13.5├──────┴─────┴───────────┴─────┴─────┤
 *         │ ═══════════ 남 복도 ═════════════ │
 *   z  18 ├────────────┬───────────┬───────────┤
 *         │ 로비·안내  │  정문홀   │  전시홀   │   남쪽 줄 3칸
 *   z  30 └────────────┴───────────┴───────────┘
 *                        (정문)
 * ========================================================================== */
import { MODELS } from '../config.js';
import { makeRun, makePart, finishMap } from './build.js';

const MAP = {
  name: '한빛타워 사옥',
  width: 112, depth: 104, height: 3.6,
  floorColor: 0x3a3f43, wallColor: 0xd5dadd, ceilColor: 0xe2e6e8,
  interior: { minX: -46, maxX: 46, minZ: -30, maxZ: 30 },
  style: 'office',   // world/visuals 가 내장재와 조명 기구를 고르는 열쇠
  fenceHeight: 2.8,
  doorHeight: 2.1,
  // 벽 띠는 사무실 것으로. 저택의 벽돌 띠를 3.6m 벽에 쓰면 천장까지 벽돌이다.
  wallBands: 'office',
};

/* 비상 발전기. 저택은 뒤뜰 담장 옆이었는데, 사옥은 지하 전기실 대신 서버실
 * 옆 배전반으로 둔다 - 정전 복구를 하려면 제일 깊은 방까지 들어가야 한다. */
const BACKUP_GENERATOR = { id: 'backup', x: -44.6, z: -21.0, w: 0.8, d: 1.6, h: 1.8, seconds: 4 };

const HALF_W = MAP.width / 2, HALF_D = MAP.depth / 2;
const OUTER = 0.45, INNER = 0.25, GLASS = 0.2, FENCE = 0.3;

/* ========================================================================== *
 *  1. 벽과 문틀
 * ========================================================================== */
const WALLS = [];
const DOORWAYS = [];
const ARCHES = [];
const run = makeRun({ WALLS, DOORWAYS, ARCHES }, MAP.doorHeight);

/* ---- 부지 담장. 정문이 열려 있고 그곳이 철수 지점이다 -------------------- */
run('z', HALF_D - 0.15, -HALF_W, HALF_W, FENCE, MAP.fenceHeight, [{ at: 0, span: 7 }]);
run('z', -HALF_D + 0.15, -HALF_W, HALF_W, FENCE, MAP.fenceHeight);
run('x', -HALF_W + 0.15, -HALF_D, HALF_D, FENCE, MAP.fenceHeight);
run('x', HALF_W - 0.15, -HALF_D, HALF_D, FENCE, MAP.fenceHeight);

/* ---- 외벽 + 진입구 5곳 ----------------------------------------------------
 * 어디로 들어갈지는 팀이 고른다. 정문은 훤하고 넓지만 리셉션이 정면으로
 * 보고 있고, 하역장과 비상구는 좁고 어둡지만 깊은 방으로 바로 들어간다.
 * ------------------------------------------------------------------------ */
run('z', 30, -46, 46, OUTER, MAP.height, [
  { at: 0, span: 3.2, door: 'front', kind: 'entry', link: ['PLAZA', 'ENTRANCE HALL'] },
  { at: -34, span: 2.4, door: 'garage', kind: 'entry', link: ['PLAZA', 'RECEPTION'], hinge: -1 },
]);
run('z', -30, -46, 46, OUTER, MAP.height, [
  { at: -38, span: 2.2, door: 'dock', kind: 'entry', link: ['NORTH YARD', 'SERVER ROOM'] },
]);
run('x', -46, -30, 30, OUTER, MAP.height, [
  { at: 6, span: 1.7, door: 'fireWest', kind: 'entry', link: ['WEST LOT', 'LOUNGE'], hinge: -1 },
]);
run('x', 46, -30, 30, OUTER, MAP.height, [
  { at: -6, span: 1.7, door: 'fireEast', kind: 'entry', link: ['EAST LOT', 'MEETING A'] },
]);

/* ---- 북쪽 줄 ↔ 북 복도 --------------------------------------------------- */
run('z', -18, -46, 46, INNER, MAP.height, [
  { at: -38.5, span: 1.5, door: 'serverDoor', link: ['SERVER ROOM', 'NORTH CORRIDOR'] },
  { at: -24.5, span: 1.5, door: 'networkDoor', link: ['NETWORK ROOM', 'NORTH CORRIDOR'] },
  { at: -12, span: 1.5, door: 'execDoor', link: ['EXEC OFFICE', 'NORTH CORRIDOR'] },
  { at: 4, span: 2.2, door: 'boardDoor', link: ['BOARDROOM', 'NORTH CORRIDOR'], hinge: -1 },
  { at: 21, span: 1.5, door: 'archiveDoor', link: ['ARCHIVE', 'NORTH CORRIDOR'] },
  { at: 37, span: 1.5, door: 'printDoor', link: ['PRINT ROOM', 'NORTH CORRIDOR'] },
]);

/* ---- 북 복도 ↔ 가운데 줄 ------------------------------------------------- */
run('z', -13.5, -46, 46, INNER, MAP.height, [
  { at: -38, span: 1.5, door: 'pantryDoor', link: ['PANTRY', 'NORTH CORRIDOR'] },
  { at: -22, span: 1.8, door: 'devWestDoor', link: ['DEV WEST', 'NORTH CORRIDOR'], hinge: -1 },
  // 코어로 들어가는 북쪽 아치. 문짝이 없어서 소리 없이 드나들 수 있다.
  { at: 0, span: 5.2, arch: true, link: ['ATRIUM', 'NORTH CORRIDOR'] },
  { at: 22, span: 1.8, door: 'devEastDoor', link: ['DEV EAST', 'NORTH CORRIDOR'] },
  { at: 38, span: 1.5, door: 'meetADoor', link: ['MEETING A', 'NORTH CORRIDOR'] },
]);

/* ---- 가운데 줄의 앞뒤 칸을 나누는 벽 (코어는 뚫려 있다) ------------------ */
run('z', 0, -46, -14, INNER, MAP.height, [
  { at: -38, span: 1.4, door: 'pantryLounge', link: ['PANTRY', 'LOUNGE'] },
  { at: -22, span: 1.4, door: 'devDesign', link: ['DEV WEST', 'DESIGN'], hinge: -1 },
]);
run('z', 0, 14, 46, INNER, MAP.height, [
  { at: 22, span: 1.4, door: 'devQa', link: ['DEV EAST', 'QA LAB'] },
  { at: 38, span: 1.4, door: 'meetAB', link: ['MEETING A', 'MEETING B'], hinge: -1 },
]);

/* ---- 가운데 줄 ↔ 남 복도 ------------------------------------------------- */
run('z', 13.5, -46, 46, INNER, MAP.height, [
  { at: -38, span: 1.5, door: 'loungeDoor', link: ['LOUNGE', 'SOUTH CORRIDOR'] },
  { at: -22, span: 1.5, door: 'designDoor', link: ['DESIGN', 'SOUTH CORRIDOR'], hinge: -1 },
  { at: 0, span: 5.2, arch: true, link: ['ATRIUM', 'SOUTH CORRIDOR'] },
  { at: 22, span: 1.5, door: 'qaDoor', link: ['QA LAB', 'SOUTH CORRIDOR'] },
  { at: 38, span: 1.5, door: 'meetBDoor', link: ['MEETING B', 'SOUTH CORRIDOR'] },
]);

/* ---- 남 복도 ↔ 남쪽 줄 --------------------------------------------------- */
run('z', 18, -46, 46, INNER, MAP.height, [
  { at: -30, span: 2.4, door: 'lobbyDoor', link: ['RECEPTION', 'SOUTH CORRIDOR'], hinge: -1 },
  { at: 0, span: 6.0, arch: true, link: ['ENTRANCE HALL', 'SOUTH CORRIDOR'] },
  { at: 30, span: 2.4, door: 'showroomDoor', link: ['SHOWROOM', 'SOUTH CORRIDOR'] },
]);

/* ---- 세로 칸막이 --------------------------------------------------------- */
// 북쪽 줄. 임원실과 대회의실 사이에만 직통문이 있다 (실제 사옥의 관행).
for (const x of [-31, -18, 14, 28]) run('x', x, -30, -18, INNER, MAP.height);
run('x', -6, -30, -18, INNER, MAP.height, [
  { at: -24, span: 1.4, door: 'execBoard', link: ['EXEC OFFICE', 'BOARDROOM'] },
]);

// 가운데 줄. 코어의 좌우 벽은 막혀 있다 - 코어에는 복도 쪽 아치로만 들어간다.
run('x', -30, -13.5, 13.5, INNER, MAP.height);
run('x', -14, -13.5, 13.5, INNER, MAP.height);
run('x', 14, -13.5, 13.5, INNER, MAP.height);
run('x', 30, -13.5, 13.5, INNER, MAP.height, [
  { at: -7, span: 1.4, door: 'devMeet', link: ['DEV EAST', 'MEETING A'] },
]);

// 남쪽 줄. 로비는 하나로 이어진 공간이라 유리 칸막이에 넓은 아치만 둔다.
run('x', -14, 18, 30, GLASS, MAP.height, [
  { at: 24, span: 4.4, arch: true, link: ['RECEPTION', 'ENTRANCE HALL'] },
]);
run('x', 14, 18, 30, GLASS, MAP.height, [
  { at: 24, span: 4.4, arch: true, link: ['ENTRANCE HALL', 'SHOWROOM'] },
]);

/* ========================================================================== *
 *  2. 구역
 * ========================================================================== */
const ROOMS = [
  // 첫 칸은 "대표 구역". 코어가 이 맵의 중심이다.
  { name: 'ATRIUM', label: '중앙 코어 · 승강기홀', x: 0, z: 0, w: 27.6, d: 26.6 },
  // 북쪽 줄
  { name: 'SERVER ROOM', label: '서버실', x: -38.5, z: -24, w: 14.6, d: 11.6 },
  { name: 'NETWORK ROOM', label: '통신실', x: -24.5, z: -24, w: 12.6, d: 11.6 },
  { name: 'EXEC OFFICE', label: '임원실', x: -12, z: -24, w: 11.6, d: 11.6 },
  { name: 'BOARDROOM', label: '대회의실', x: 4, z: -24, w: 19.6, d: 11.6 },
  { name: 'ARCHIVE', label: '자료보관실', x: 21, z: -24, w: 13.6, d: 11.6 },
  { name: 'PRINT ROOM', label: '인쇄·비품실', x: 37, z: -24, w: 17.6, d: 11.6 },
  // 가운데 줄
  { name: 'PANTRY', label: '탕비실', x: -38, z: -6.75, w: 15.6, d: 13.1 },
  { name: 'LOUNGE', label: '휴게실', x: -38, z: 6.75, w: 15.6, d: 13.1 },
  { name: 'DEV WEST', label: '개발실 서편', x: -22, z: -6.75, w: 15.6, d: 13.1 },
  { name: 'DESIGN', label: '디자인실', x: -22, z: 6.75, w: 15.6, d: 13.1 },
  { name: 'DEV EAST', label: '개발실 동편', x: 22, z: -6.75, w: 15.6, d: 13.1 },
  { name: 'QA LAB', label: '품질관리실', x: 22, z: 6.75, w: 15.6, d: 13.1 },
  { name: 'MEETING A', label: '소회의실 A', x: 38, z: -6.75, w: 15.6, d: 13.1 },
  { name: 'MEETING B', label: '소회의실 B', x: 38, z: 6.75, w: 15.6, d: 13.1 },
  // 남쪽 줄
  { name: 'RECEPTION', label: '로비·안내', x: -30, z: 24, w: 31.6, d: 11.6 },
  { name: 'ENTRANCE HALL', label: '정문홀', x: 0, z: 24, w: 27.6, d: 11.6 },
  { name: 'SHOWROOM', label: '전시홀', x: 30, z: 24, w: 31.6, d: 11.6 },
];

/** 복도. 92m 가 한 줄로 곧게 뻗어 있어서 여기서 마주치면 피할 데가 없다. */
const CORRIDORS = [
  { name: 'NORTH CORRIDOR', label: '북쪽 복도', x: 0, z: -15.75, w: 91.6, d: 4.1 },
  { name: 'SOUTH CORRIDOR', label: '남쪽 복도', x: 0, z: 15.75, w: 91.6, d: 4.1 },
];

const OUTDOOR_AREAS = [
  { name: 'PLAZA', label: '정문 광장', x: 0, z: 41, w: 111, d: 21.6, outdoor: true },
  { name: 'WEST LOT', label: '서측 주차장', x: -51, z: 0, w: 9.4, d: 111, outdoor: true },
  { name: 'EAST LOT', label: '동측 통로', x: 51, z: 0, w: 9.4, d: 111, outdoor: true },
  { name: 'NORTH YARD', label: '하역장', x: 0, z: -41, w: 111, d: 21.6, outdoor: true },
];

/* ========================================================================== *
 *  3. 가구와 소품
 *
 *  상자로 세우는 것들. 총알과 몸을 막는 물건은 전부 여기 있어야 한다 -
 *  보이는 것과 막히는 것이 어긋나면 "분명히 책상 뒤에 숨었는데 맞았다"가 된다.
 * ========================================================================== */
const FURNITURE = [];
const part = makePart(FURNITURE);

/* 책상 위의 모니터는 상자가 아니라 모형으로 얹는다. 화면이 켜져 있는 모니터
 * 예순 대가 사무실을 사무실로 보이게 하는 거의 전부다. 충돌은 아래 상자가
 * 맡고, 모니터는 그 위에 얹히기만 한다(콜라이더는 얇은 판 하나). */
const DESK_MONITORS = [];

/** 책상 한 자리. 상판 + 다리 + 앞을 막는 칸막이 + 모니터. */
function desk(x, z, ry = 0) {
  part(x, z, 1.6, 0.8, 0.06, 0.72, 'laminate', ry);
  part(x, z, 1.5, 0.06, 0.66, 0.04, 'plastic', ry);
  part(x, z - 0.44, 1.6, 0.05, 0.5, 0.78, 'panel', ry);   // 앞 칸막이
  DESK_MONITORS.push({ model: 'monitor', x, z: z - 0.18, yOff: 0.78, ry, s: 1 });
}

/** 책상 네 자리를 등 맞대고 묶은 섬. 개발실의 기본 단위다. */
function deskIsland(x, z, ry = 0) {
  const c = Math.cos(ry), s = Math.sin(ry);
  const at = (lx, lz) => [x + c * lx + s * lz, z - s * lx + c * lz];
  for (const [lx, lz, r] of [[-0.85, -0.5, 0], [0.85, -0.5, 0], [-0.85, 0.5, Math.PI], [0.85, 0.5, Math.PI]]) {
    const [dx, dz] = at(lx, lz);
    desk(dx, dz, ry + r);
  }
  // 가운데 등 맞댄 칸막이. 허리보다 조금 높아 앉으면 가려지고 서면 보인다.
  part(x, z, 3.5, 0.08, 0.62, 0.74, 'panel', ry);
}

/** 서랍장 / 서류함. */
const cabinet = (x, z, w = 0.9, d = 0.5, h = 1.3, ry = 0) => part(x, z, w, d, h, 0, 'metal', ry);
/** 낮은 수납장. 엄폐물이 된다. */
const credenza = (x, z, w = 2.2, d = 0.5, ry = 0) => part(x, z, w, d, 0.82, 0, 'laminate', ry);
/** 세워 둔 파티션. 사무실의 미로는 벽이 아니라 이것으로 만든다. */
const partition = (x, z, w, ry = 0) => part(x, z, w, 0.09, 1.55, 0, 'panel', ry);
/** 소파. */
function sofa(x, z, ry = 0) {
  part(x, z, 2.1, 0.85, 0.42, 0, 'fabric', ry);
  part(x, z - 0.34, 2.1, 0.2, 0.44, 0.42, 'fabric', ry);
}
/** 안내 데스크 (ㄱ 자). */
function receptionDesk(x, z) {
  part(x, z, 7.0, 0.85, 1.12, 0, 'laminate');
  part(x - 3.4, z + 1.6, 0.85, 2.6, 1.12, 0, 'laminate');
  part(x, z, 7.0, 0.14, 0.06, 1.12, 'brass');
}
/** 사물함 한 줄. */
const lockers = (x, z, w = 3.2, ry = 0) => part(x, z, w, 0.52, 1.9, 0, 'metal', ry);
/** 화분. */
const planter = (x, z) => { part(x, z, 0.72, 0.72, 0.42, 0, 'stone'); part(x, z, 0.62, 0.62, 0.95, 0.42, 'hedge'); };
/** 주차된 차. 광장과 주차장을 채우고 야외 엄폐물이 된다. */
function car(x, z, ry = 0) {
  part(x, z, 4.4, 1.85, 0.72, 0.18, 'metal', ry);
  part(x, z + 0.1, 2.4, 1.7, 0.58, 0.9, 'glass', ry);
}
/** 화단 / 벤치 / 볼라드. */
const hedge = (x, z, w, d) => part(x, z, w, d, 1.1, 0, 'hedge');
const bench = (x, z, ry = 0) => part(x, z, 2.0, 0.55, 0.45, 0, 'stone', ry);
const bollard = (x, z) => part(x, z, 0.24, 0.24, 0.95, 0, 'metal');

/* ---- 서버실 : 랙 줄 사이가 좁은 통로. 정면으로 마주치면 피할 데가 없다 --- */
for (let i = 0; i < 4; i++) {
  part(-43.6 + i * 3.4, -25.6, 1.1, 4.4, 2.0, 0, 'metal');
}
cabinet(-44.8, -19.4, 1.2, 0.6, 1.9);
credenza(-33.4, -19.6, 3.0);

/* ---- 통신실 ---------------------------------------------------------- */
for (let i = 0; i < 3; i++) part(-29.4 + i * 2.6, -26.4, 0.9, 2.6, 2.0, 0, 'metal');
credenza(-24.5, -19.6, 5.0);
cabinet(-19.4, -25.4, 0.9, 0.5, 1.3);

/* ---- 임원실 : 넓은 책상 하나, 소파 한 벌, 서가 -------------------------- */
part(-12, -25.4, 2.6, 1.1, 0.08, 0.74, 'wood');
part(-12, -25.4, 2.2, 0.8, 0.72, 0, 'wood');
sofa(-15.4, -20.6, 0);
part(-15.4, -22.4, 1.2, 0.7, 0.42, 0, 'wood');
cabinet(-7.4, -27.4, 0.9, 0.5, 1.9);
cabinet(-7.4, -25.8, 0.9, 0.5, 1.9);
planter(-16.6, -27.6);

/* ---- 대회의실 : 긴 탁자 하나. 방이 넓고 탁자 말고는 숨을 데가 없다.
   탁자 자체는 아래 PROPS 의 GLB 를 쓴다 - 상자를 겹쳐 놓으면 두 개로 보인다. */
part(4, -29.2, 5.4, 0.12, 1.3, 0.9, 'paint');     // 화이트보드
part(-4.6, -24.2, 0.12, 3.0, 1.2, 0.8, 'glass');  // 유리 칸막이
credenza(12.0, -28.6, 3.2);
planter(12.6, -19.4);

/* ---- 자료보관실 : 서가가 촘촘하다 -------------------------------------- */
for (let i = 0; i < 4; i++) {
  part(15.6 + i * 3.2, -24.4, 0.6, 7.2, 2.1, 0, 'metal');
}
cabinet(26.6, -19.6, 1.0, 0.55, 1.3);

/* ---- 인쇄·비품실 -------------------------------------------------------- */
credenza(30.6, -28.4, 4.0);
lockers(43.4, -24.0, 5.4, Math.PI / 2);
cabinet(33.0, -19.6, 1.0, 0.55, 1.6);
cabinet(34.6, -19.6, 1.0, 0.55, 1.6);
part(40.0, -20.2, 2.4, 1.0, 0.75, 0, 'laminate');   // 작업대

/* ---- 탕비실 ------------------------------------------------------------- */
part(-45.0, -6.75, 0.72, 8.0, 0.92, 0, 'laminate');   // 서쪽 벽 조리대
part(-45.0, -6.75, 0.6, 7.6, 0.7, 1.9, 'laminate');   // 상부장
part(-38.6, -9.4, 1.6, 1.6, 0.74, 0, 'laminate');     // 가운데 탁자
for (const [dx, dz] of [[-1.3, 0], [1.3, 0], [0, 1.3]]) {
  part(-38.6 + dx, -9.4 + dz, 0.45, 0.45, 0.46, 0, 'fabric');
}
cabinet(-32.4, -3.4, 0.9, 0.6, 1.9);

/* ---- 휴게실 : 소파와 낮은 탁자, 자판기 줄 ------------------------------- */
sofa(-41.6, 9.6, 0);
sofa(-34.4, 9.6, Math.PI);
part(-38.0, 9.6, 1.6, 0.9, 0.38, 0, 'wood');
part(-44.8, 4.0, 0.8, 3.2, 1.9, 0, 'plastic');        // 자판기 줄
lockers(-32.6, 10.4, 4.0, Math.PI / 2);
planter(-44.4, 12.2);

/* ---- 개발실 서편 / 디자인실 / 개발실 동편 / 품질관리실 -------------------
   섬 네 자리짜리 책상 묶음 + 세워 둔 파티션. 사무실 교전의 성격을 정하는
   물건들이다: 앉으면 가려지고 서면 보이는 높이로만 세운다. */
for (const [cx, cz] of [[-26.4, -9.6], [-17.6, -9.6], [-26.4, -3.6], [-17.6, -3.6]]) deskIsland(cx, cz);
partition(-22.0, -12.4, 12.0);
for (const [cx, cz] of [[-26.4, 3.8], [-17.6, 3.8], [-26.4, 9.8], [-17.6, 9.8]]) deskIsland(cx, cz);
partition(-22.0, 6.8, 12.0);
cabinet(-29.0, 12.4, 1.0, 0.5, 1.3);

for (const [cx, cz] of [[17.6, -9.6], [26.4, -9.6], [17.6, -3.6], [26.4, -3.6]]) deskIsland(cx, cz);
partition(22.0, -12.4, 12.0);
for (const [cx, cz] of [[17.6, 3.8], [26.4, 3.8], [17.6, 9.8], [26.4, 9.8]]) deskIsland(cx, cz);
partition(22.0, 6.8, 12.0);
credenza(28.6, 12.4, 2.6);

/* ---- 소회의실 A · B (탁자는 PROPS 의 GLB) -------------------------------- */
part(45.0, -8.4, 0.12, 3.2, 1.2, 0.8, 'paint');
credenza(38, -12.6, 3.0);
part(45.0, 7.0, 0.12, 3.2, 1.2, 0.8, 'paint');
planter(31.6, 12.2);

/* ---- 중앙 코어 : 승강기 두 대, 계단실, 가운데 라운지 --------------------
   저쪽 사옥에서 그대로 가져온 자리다. 승강기 문 앞은 비워 두어야 한다 -
   양쪽 복도에서 들어오는 두 아치를 잇는 유일한 대각선이 그 앞을 지난다. */
for (const lx of [-6.2, -2.4]) {
  part(lx, -12.6, 3.2, 0.5, 2.4, 0, 'metal');           // 승강기 문
  part(lx, -12.98, 0.9, 0.12, 0.34, 2.5, 'brass');      // 층수 표시등
}
part(6.6, -11.6, 6.4, 3.4, 2.6, 0, 'paint');            // 계단실 벽체
part(6.6, -9.8, 4.6, 0.25, 1.0, 0, 'metal');            // 계단 난간
for (let i = 0; i < 6; i++) part(6.6, -9.4 + i * 0.42, 4.2, 0.42, 0.18 + i * 0.18, 0, 'stone');
sofa(-3.6, 3.4, 0);
sofa(3.6, 3.4, 0);
part(0, 6.0, 2.2, 1.1, 0.38, 0, 'wood');
planter(-11.2, 11.0); planter(11.2, 11.0);
planter(-11.2, -11.0); planter(11.2, -11.0);
part(0, -4.2, 5.2, 0.2, 1.05, 0, 'glass');              // 아트리움 난간

/* ---- 로비·안내 ---------------------------------------------------------- */
receptionDesk(-30.0, 21.2);
sofa(-41.0, 26.0, Math.PI);
sofa(-41.0, 22.0, 0);
part(-41.0, 24.0, 1.4, 0.9, 0.38, 0, 'wood');
lockers(-44.8, 19.6, 3.6, Math.PI / 2);
planter(-17.4, 20.0); planter(-17.4, 27.8);

/* ---- 정문홀 : 회전문 앞은 비워 둔다 -------------------------------------- */
part(-9.4, 20.4, 1.1, 1.1, 1.05, 0, 'metal');           // 보안 게이트
part(9.4, 20.4, 1.1, 1.1, 1.05, 0, 'metal');
part(0, 28.2, 4.6, 0.3, 1.0, 0, 'glass');               // 풍제실 유리
bench(-5.0, 25.4); bench(5.0, 25.4);
planter(-12.0, 28.4); planter(12.0, 28.4);

/* ---- 전시홀 : 낮은 좌대가 늘어서 있다 ------------------------------------ */
for (const [px, pz] of [[20, 21.4], [27, 21.4], [34, 21.4], [41, 21.4], [23.5, 27.4], [30.5, 27.4], [37.5, 27.4]]) {
  part(px, pz, 1.5, 1.5, 0.95, 0, 'stone');
}
credenza(44.8, 24.0, 6.0, 0.5, Math.PI / 2);
sofa(17.0, 26.6, Math.PI / 2);

/* ---- 광장과 주차장 ------------------------------------------------------- */
for (const x of [-46, -38, -30, 30, 38, 46]) hedge(x, 33.6, 6.4, 1.2);
for (let i = 0; i < 6; i++) bollard(-7.5 + i * 3, 32.2);
bench(-14.0, 35.0); bench(14.0, 35.0);
for (let i = 0; i < 5; i++) car(-46 + i * 6.4, 40.0, 0);
for (let i = 0; i < 5; i++) car(20.0 + i * 6.4, 40.0, 0);
for (let i = 0; i < 4; i++) car(-51.0, -20 + i * 11, Math.PI / 2);
for (let i = 0; i < 4; i++) car(51.0, -20 + i * 11, Math.PI / 2);
// 하역장. 컨테이너와 팔레트가 야외 엄폐물이다.
part(-24.0, -36.0, 6.0, 2.6, 2.6, 0, 'metal');
part(-14.0, -38.0, 6.0, 2.6, 2.6, 0, 'metal');
for (const [px, pz] of [[-34, -34.6], [-31, -36.4], [8, -35.0], [12, -37.2], [16, -34.4]]) {
  part(px, pz, 1.2, 1.2, 0.9, 0, 'wood');
}
part(30.0, -36.0, 10.0, 3.0, 0.9, 0, 'stone');          // 하역 플랫폼
for (let i = 0; i < 3; i++) part(30.0 - 3 + i * 3, -32.6, 2.2, 1.4, 0.3 - i * 0.05, 0, 'stone');

/* ---- 고품질 소품 (GLB) ---------------------------------------------------
   블렌더로 구운 모형들. 상자로는 안 되는 것 - 모니터가 달린 책상, 팬이 도는
   서버랙, 바퀴 달린 의자 - 만 여기 둔다. 나머지는 위의 상자가 맡는다. */
const PROPS = [
  ...DESK_MONITORS,
  { model: 'serverRack', x: -43.6, z: -22.4, ry: 0, s: 1 },
  { model: 'serverRack', x: -40.2, z: -22.4, ry: 0, s: 1 },
  { model: 'serverRack', x: -36.8, z: -22.4, ry: 0, s: 1 },
  { model: 'serverRack', x: -29.4, z: -23.0, ry: 0, s: 1 },
  { model: 'serverRack', x: -26.8, z: -23.0, ry: 0, s: 1 },

  { model: 'confTable', x: 4, z: -24.0, ry: 0, s: 1.6 },
  { model: 'confTable', x: 38, z: -8.0, ry: Math.PI / 2, s: 0.95 },
  { model: 'confTable', x: 38, z: 7.0, ry: Math.PI / 2, s: 0.95 },

  { model: 'copier', x: 31.4, z: -20.4, ry: Math.PI, s: 1 },
  { model: 'copier', x: -28.4, z: -12.2, ry: Math.PI, s: 1 },
  { model: 'copier', x: 28.4, z: -12.2, ry: Math.PI, s: 1 },

  { model: 'waterCooler', x: -31.0, z: -15.4, ry: 0, s: 1 },
  { model: 'waterCooler', x: 31.0, z: 15.4, ry: Math.PI, s: 1 },
  { model: 'waterCooler', x: -35.2, z: 2.2, ry: 0, s: 1 },

  { model: 'vending', x: -41.4, z: 2.2, ry: 0, s: 1 },
  { model: 'vending', x: -39.6, z: 2.2, ry: 0, s: 1 },
  { model: 'vending', x: 9.0, z: 11.4, ry: Math.PI, s: 1 },

  { model: 'officeChair', x: 1.2, z: -22.6, ry: 0.3, s: 1 },
  { model: 'officeChair', x: 6.8, z: -22.6, ry: -0.2, s: 1 },
  { model: 'officeChair', x: 1.2, z: -25.8, ry: Math.PI - 0.2, s: 1 },
  { model: 'officeChair', x: 6.8, z: -25.8, ry: Math.PI + 0.3, s: 1 },
  { model: 'officeChair', x: -12.0, z: -27.0, ry: Math.PI, s: 1 },
  { model: 'officeChair', x: -30.0, z: 19.4, ry: Math.PI, s: 1 },
  { model: 'officeChair', x: -24.6, z: -7.0, ry: 0.5, s: 1 },
  { model: 'officeChair', x: -19.4, z: -2.0, ry: Math.PI, s: 1 },
  { model: 'officeChair', x: 24.6, z: 4.4, ry: -0.4, s: 1 },
  { model: 'officeChair', x: 19.4, z: 11.2, ry: Math.PI + 0.4, s: 1 },
  { model: 'officeChair', x: 36.2, z: -10.4, ry: 0.2, s: 1 },
  { model: 'officeChair', x: 39.8, z: 4.6, ry: Math.PI, s: 1 },

  { model: 'plantTall', x: -13.0, z: 14.6, ry: 0, s: 1 },
  { model: 'plantTall', x: 13.0, z: 14.6, ry: 0, s: 1 },
  { model: 'plantTall', x: -45.0, z: -16.0, ry: 0, s: 1 },
  { model: 'plantTall', x: 45.0, z: -16.0, ry: 0, s: 1 },
  { model: 'plantTall', x: 0, z: 19.4, ry: 0, s: 1.15 },
  { model: 'plantTall', x: 44.6, z: 20.4, ry: 0, s: 1 },
];
for (const p of PROPS) {
  const def = MODELS[p.model];
  const [w, h, d] = def.fit.size ?? [1.0, def.fit.height, 1.0];
  p.col = { w: w * p.s, h: h * p.s, d: d * p.s };
  p.shape = def.placeholder?.type === 'cylinder' ? 'cylinder' : 'box';
}

/* ========================================================================== *
 *  4. 조명
 *
 *  전부 형광등이다. 저택의 샹들리에가 따뜻한 주황이라면 여기는 차갑고 고르게
 *  퍼진 흰빛이고, 그래서 그림자가 짧고 어디에도 숨을 데가 없다 - 불이 켜져
 *  있는 동안에는. 정전되면 비상구 표시등의 초록만 남는다.
 * ========================================================================== */
const troffer = (x, z, intensity = 34, distance = 13, color = 0xe8f2ff) =>
  ({ x, y: 3.35, z, color, intensity, distance, kind: 'chandelier' });

const LIGHTS = [
  // 코어. 천장이 유일하게 뚫려 있어 제일 밝다.
  { x: 0, y: 3.45, z: 0, color: 0xeaf4ff, intensity: 72, distance: 26, kind: 'chandelier' },
  troffer(-7, -7, 40, 15), troffer(7, -7, 40, 15),
  troffer(-7, 7, 40, 15), troffer(7, 7, 40, 15),

  // 방마다 두 줄씩
  ...ROOMS.slice(1).flatMap((r) => (r.w > 18
    ? [troffer(r.x - r.w / 4, r.z, 40, 15), troffer(r.x + r.w / 4, r.z, 40, 15)]
    : [troffer(r.x, r.z - r.d / 5, 34, 13), troffer(r.x, r.z + r.d / 5, 34, 13)])),

  // 복도등. 92m 를 12m 간격으로 - 등 사이가 살짝 어둡고 그 어둠이 유일한 엄폐다.
  ...[-42, -30, -18, -6, 6, 18, 30, 42].flatMap((x) => [
    { x, y: 3.4, z: -15.75, color: 0xdfeaf5, intensity: 26, distance: 11, kind: 'chandelier' },
    { x, y: 3.4, z: 15.75, color: 0xdfeaf5, intensity: 26, distance: 11, kind: 'chandelier' },
  ]),

  // 서버실은 색이 다르다. 냉복도 조명이라 푸르스름하다.
  { x: -38.5, y: 3.3, z: -25.6, color: 0xbcd8ff, intensity: 30, distance: 12, kind: 'chandelier' },

  // 야외등. 별도 배선이라 사옥이 정전돼도 살아 있다.
  { x: -22, y: 5.2, z: 36, color: 0xc6d8ea, intensity: 42, distance: 22, kind: 'lamp' },
  { x: 22, y: 5.2, z: 36, color: 0xc6d8ea, intensity: 42, distance: 22, kind: 'lamp' },
  { x: 0, y: 4.4, z: 33.2, color: 0xffe2b4, intensity: 28, distance: 14, kind: 'lamp' },
  { x: -51, y: 5.2, z: -16, color: 0xc6d8ea, intensity: 32, distance: 19, kind: 'lamp' },
  { x: -51, y: 5.2, z: 16, color: 0xc6d8ea, intensity: 32, distance: 19, kind: 'lamp' },
  { x: 51, y: 5.2, z: -16, color: 0xc6d8ea, intensity: 32, distance: 19, kind: 'lamp' },
  { x: 51, y: 5.2, z: 16, color: 0xc6d8ea, intensity: 32, distance: 19, kind: 'lamp' },
  { x: -20, y: 4.8, z: -36, color: 0xffd9a0, intensity: 30, distance: 17, kind: 'lamp' },
  { x: 24, y: 4.8, z: -36, color: 0xffd9a0, intensity: 30, distance: 17, kind: 'lamp' },
];

/* ========================================================================== *
 *  5. 스폰 / 목표 / 배치
 * ========================================================================== */
/** 팀은 정문 광장 바깥, 차 뒤에서 시작한다. */
const SPAWNS = [
  { x: -2.6, z: 45.4, yaw: 0 }, { x: 2.6, z: 45.4, yaw: 0 },
  { x: -2.6, z: 47.4, yaw: 0 }, { x: 2.6, z: 47.4, yaw: 0 },
];

const EXTRACTION = { x: 0, z: 49.2, radius: 3.4, label: '정문 광장 · 철수' };

/**
 * 폭발물 둘. 사옥의 대각선 양 끝에 둔다 - 하나는 제일 깊은 서버실,
 * 하나는 제일 훤한 전시홀. 한 팀이 둘을 동시에 볼 수 없다.
 */
const BOMB_SITES = [
  { id: 'A', x: -38.5, z: -20.4, label: '서버실 A', room: 'SERVER ROOM' },
  { id: 'B', x: 33.0, z: 24.6, label: '전시홀 B', room: 'SHOWROOM' },
];

const EVIDENCE_SPOTS = [
  { id: 'ledger', x: 21.0, z: -21.6, label: '이중 장부', room: 'ARCHIVE' },
  { id: 'contract', x: -12.6, z: -22.6, label: '이면 계약서', room: 'EXEC OFFICE' },
  { id: 'drive', x: -21.4, z: -20.6, label: '백업 드라이브', room: 'NETWORK ROOM' },
  { id: 'laptop', x: 9.4, z: -21.2, label: '노트북', room: 'BOARDROOM' },
  { id: 'badge', x: -34.3, z: 21.1, label: '출입 카드 묶음', room: 'RECEPTION' },
  { id: 'prototype', x: 27.4, z: 22.8, label: '시제품 상자', room: 'SHOWROOM' },
  { id: 'burner', x: -38.6, z: 11.6, label: '대포폰', room: 'LOUNGE' },
  { id: 'blueprint', x: -19.4, z: 6.1, label: '도면 원본', room: 'DESIGN' },
];

/**
 * 경비 자리. 방마다 두세 곳씩, 문을 정면으로 보지 않는 각도로 둔다.
 * yaw = 0 이 -Z(북쪽)이다.
 */
const POSTS = [
  // 북쪽 줄
  { x: -43.0, z: -20.4, yaw: 2.3, room: 'SERVER ROOM' },
  { x: -34.6, z: -26.3, yaw: 1.6, room: 'SERVER ROOM' },
  { x: -37.2, z: -20.0, yaw: 3.0, room: 'SERVER ROOM' },
  { x: -28.0, z: -20.6, yaw: 2.8, room: 'NETWORK ROOM' },
  { x: -20.4, z: -26.0, yaw: -1.6, room: 'NETWORK ROOM' },
  { x: -14.2, z: -21.8, yaw: 2.6, room: 'EXEC OFFICE' },
  { x: -8.6, z: -27.2, yaw: 3.0, room: 'EXEC OFFICE' },
  { x: -2.4, z: -20.6, yaw: 2.4, room: 'BOARDROOM' },
  { x: 11.0, z: -26.4, yaw: -2.0, room: 'BOARDROOM' },
  { x: 4.0, z: -27.6, yaw: 3.1, room: 'BOARDROOM' },
  { x: 16.8, z: -20.6, yaw: 2.6, room: 'ARCHIVE' },
  { x: 26.4, z: -27.0, yaw: -1.3, room: 'ARCHIVE' },
  { x: 30.4, z: -21.1, yaw: 2.2, room: 'PRINT ROOM' },
  { x: 42.4, z: -26.6, yaw: -1.8, room: 'PRINT ROOM' },
  { x: 37.0, z: -20.4, yaw: 3.0, room: 'PRINT ROOM' },
  // 북 복도
  { x: -33.0, z: -15.6, yaw: 1.5, room: 'NORTH CORRIDOR' },
  { x: 33.0, z: -15.6, yaw: -1.5, room: 'NORTH CORRIDOR' },
  { x: -9.0, z: -15.6, yaw: 1.4, room: 'NORTH CORRIDOR' },
  { x: 9.0, z: -15.6, yaw: -1.4, room: 'NORTH CORRIDOR' },
  // 가운데 줄
  { x: -43.6, z: -3.4, yaw: 1.5, room: 'PANTRY' },
  { x: -34.0, z: -11.4, yaw: 3.0, room: 'PANTRY' },
  { x: -43.0, z: 11.0, yaw: 0.6, room: 'LOUNGE' },
  { x: -33.2, z: 4.4, yaw: -2.4, room: 'LOUNGE' },
  { x: -29.0, z: -6.4, yaw: 1.5, room: 'DEV WEST' },
  { x: -15.4, z: -11.6, yaw: -2.2, room: 'DEV WEST' },
  { x: -22.0, z: -1.6, yaw: 3.1, room: 'DEV WEST' },
  { x: -29.0, z: 7.4, yaw: 1.4, room: 'DESIGN' },
  { x: -15.6, z: 11.8, yaw: -0.8, room: 'DESIGN' },
  { x: 29.0, z: -6.4, yaw: -1.5, room: 'DEV EAST' },
  { x: 15.4, z: -11.6, yaw: 2.2, room: 'DEV EAST' },
  { x: 22.0, z: -1.6, yaw: 3.1, room: 'DEV EAST' },
  { x: 29.0, z: 7.4, yaw: -1.4, room: 'QA LAB' },
  { x: 15.6, z: 11.8, yaw: 0.8, room: 'QA LAB' },
  { x: 33.0, z: -11.0, yaw: 2.6, room: 'MEETING A' },
  { x: 43.4, z: -4.0, yaw: -1.6, room: 'MEETING A' },
  { x: 33.2, z: 11.2, yaw: 0.4, room: 'MEETING B' },
  { x: 43.4, z: 4.2, yaw: -1.6, room: 'MEETING B' },
  // 중앙 코어
  { x: -10.6, z: -8.0, yaw: 1.2, room: 'ATRIUM' },
  { x: 10.6, z: -8.0, yaw: -1.2, room: 'ATRIUM' },
  { x: -10.6, z: 8.6, yaw: 2.0, room: 'ATRIUM' },
  { x: 10.6, z: 8.6, yaw: -2.0, room: 'ATRIUM' },
  { x: 0, z: -8.4, yaw: 3.1, room: 'ATRIUM' },
  // 남 복도
  { x: -26.0, z: 15.6, yaw: 1.6, room: 'SOUTH CORRIDOR' },
  { x: 26.0, z: 15.6, yaw: -1.6, room: 'SOUTH CORRIDOR' },
  { x: 0, z: 15.6, yaw: 3.1, room: 'SOUTH CORRIDOR' },
  // 남쪽 줄
  { x: -43.4, z: 24.8, yaw: 1.4, room: 'RECEPTION' },
  { x: -25.0, z: 27.4, yaw: -0.4, room: 'RECEPTION' },
  { x: -34.0, z: 26.6, yaw: 0.2, room: 'RECEPTION' },
  { x: -6.0, z: 27.0, yaw: 0.3, room: 'ENTRANCE HALL' },
  { x: 6.0, z: 27.0, yaw: -0.3, room: 'ENTRANCE HALL' },
  { x: 17.4, z: 24.4, yaw: -1.5, room: 'SHOWROOM' },
  { x: 32.2, z: 27.6, yaw: 0.2, room: 'SHOWROOM' },
  { x: 43.0, z: 24.2, yaw: 1.5, room: 'SHOWROOM' },
  // 야외
  { x: -14.2, z: 34.1, yaw: 3.0, room: 'PLAZA' },
  { x: 13.8, z: 34.1, yaw: 3.0, room: 'PLAZA' },
  { x: -20.0, z: -35.0, yaw: 0.2, room: 'NORTH YARD' },
  { x: 22.0, z: -33.4, yaw: 0.2, room: 'NORTH YARD' },
  { x: -50.0, z: -6.0, yaw: -1.5, room: 'WEST LOT' },
  { x: 50.0, z: 6.0, yaw: 1.5, room: 'EAST LOT' },
];

/** 야근 중이던 직원들. 책상 앞, 탕비실, 휴게실, 회의실. */
const CIVILIAN_SPOTS = [
  { x: -25.3, z: -7.7, room: 'DEV WEST' },
  { x: -20.0, z: -9.5, room: 'DEV WEST' },
  { x: -25.4, z: 8.2, room: 'DESIGN' },
  { x: -19.9, z: 4.5, room: 'DESIGN' },
  { x: 24.6, z: -7.4, room: 'DEV EAST' },
  { x: 20.1, z: -10.0, room: 'DEV EAST' },
  { x: 24.6, z: 8.2, room: 'QA LAB' },
  { x: 19.9, z: 4.2, room: 'QA LAB' },
  { x: -37.9, z: -7.4, room: 'PANTRY' },
  { x: -41.2, z: 8.0, room: 'LOUNGE' },
  { x: -35.0, z: 11.6, room: 'LOUNGE' },
  { x: 2.2, z: -22.2, room: 'BOARDROOM' },
  { x: 8.0, z: -26.0, room: 'BOARDROOM' },
  { x: -12.8, z: -21.4, room: 'EXEC OFFICE' },
  { x: 36.6, z: -6.4, room: 'MEETING A' },
  { x: 39.4, z: 8.6, room: 'MEETING B' },
  { x: -30.8, z: 20.1, room: 'RECEPTION' },
  { x: -39.6, z: 24.2, room: 'RECEPTION' },
  { x: 0, z: 25.8, room: 'ENTRANCE HALL' },
  { x: 23.0, z: 25.6, room: 'SHOWROOM' },
  { x: -2.0, z: 4.6, room: 'ATRIUM' },
  { x: 4.4, z: 8.2, room: 'ATRIUM' },
  { x: 18.9, z: -20.1, room: 'ARCHIVE' },
  { x: 39.0, z: -22.4, room: 'PRINT ROOM' },
];

/** 주범이 있을 수 있는 방. 문 하나짜리 구석방 위주로 둔다. */
const HVT_ROOMS = [
  'EXEC OFFICE', 'BOARDROOM', 'SERVER ROOM', 'ARCHIVE', 'MEETING A', 'MEETING B',
  'DESIGN', 'QA LAB', 'SHOWROOM', 'PRINT ROOM', 'NETWORK ROOM', 'LOUNGE',
];

/* ========================================================================== *
 *  6. 이 맵만의 사건
 *
 *  저택은 조용하다. 사옥은 조용하지 않다 - 그 차이가 이 맵의 성격이다.
 * ========================================================================== */
/**
 * 주기적으로 소리를 내는 물건.
 *
 *  서버실 냉각팬은 계속 돌고, 복사기는 밤에도 예약 인쇄를 뱉고, 승강기는
 *  아무도 안 탔는데 층을 오간다. NPC 는 이 소리에도 똑같이 반응하므로,
 *  "언제 어디서 소리가 날지" 를 알고 그 틈에 움직이는 것이 이 맵의 요령이다.
 *  level 은 perception.js 의 척도를 따른다 (총성이 1.0).
 *
 *  investigate 가 false 면 NPC 가 고개만 돌리고 자리를 뜨지는 않는다 -
 *  안 그러면 온 사옥이 복사기 앞에 모인다.
 */
const AMBIENT_NOISE = [
  { id: 'fans', x: -38.5, z: -25.6, level: 0.16, type: 'hum', everyMs: 4000, jitterMs: 900, investigate: false, label: '서버실 냉각팬' },
  { id: 'copierN', x: 31.4, z: -20.4, level: 0.3, type: 'copier', everyMs: 21000, jitterMs: 7000, investigate: false, label: '예약 인쇄' },
  { id: 'copierW', x: -28.4, z: -12.2, level: 0.28, type: 'copier', everyMs: 26000, jitterMs: 9000, investigate: false, label: '예약 인쇄' },
  { id: 'lift', x: -4.3, z: -12.6, level: 0.42, type: 'lift', everyMs: 33000, jitterMs: 12000, investigate: true, label: '승강기 도착' },
  { id: 'hvac', x: 0, z: 0, level: 0.12, type: 'hum', everyMs: 9000, jitterMs: 2500, investigate: false, label: '공조기' },
];

/**
 * 화재경보기. 당기면 그 자리에서 8초간 큰 소리가 계속 난다.
 *
 *  사옥 반대편 것을 당겨 두고 들어가면 경비가 그쪽으로 몰린다. 대신 당기는
 *  동안 소리가 나므로 바로 옆에 있는 자에게는 들킨다 - 공짜가 아니다.
 */
const ALARMS = [
  { id: 'alarmN', x: -45.4, z: -15.4, label: '북쪽 화재경보기', room: 'NORTH CORRIDOR' },
  { id: 'alarmS', x: 45.4, z: 15.4, label: '남쪽 화재경보기', room: 'SOUTH CORRIDOR' },
  { id: 'alarmLobby', x: -13.2, z: 21.0, label: '로비 화재경보기', room: 'ENTRANCE HALL' },
  { id: 'alarmCore', x: 9.6, z: -12.0, label: '코어 화재경보기', room: 'ATRIUM' },
];

/* ========================================================================== *
 *  완성
 * ========================================================================== */
export const OFFICE = finishMap({
  id: 'office',
  label: '한빛타워 사옥',
  blurb: '18칸짜리 사무 층. 복도가 길고 곧으며, 소음원과 화재경보기를 쓰는 맵이다.',
  defaultZone: 'PLAZA',
  // 이 맵에서만 쓰는 GLB. 저택만 하는 사람은 받지 않는다.
  models: ['monitor', 'officeChair', 'serverRack', 'copier', 'waterCooler', 'vending', 'plantTall', 'confTable'],
  MAP, BACKUP_GENERATOR,
  WALLS, DOORWAYS, ARCHES,
  ROOMS, CORRIDORS, OUTDOOR_AREAS,
  FURNITURE, PROPS, LIGHTS,
  SPAWNS, EXTRACTION, BOMB_SITES, EVIDENCE_SPOTS,
  POSTS, CIVILIAN_SPOTS, HVT_ROOMS,
  AMBIENT_NOISE, ALARMS,
});
