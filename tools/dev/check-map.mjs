/* =============================================================================
 *  tools/dev/check-map.mjs  -  맵 데이터 자동 검사
 *
 *  map-data.js 를 고친 뒤에 반드시 한 번 돌려볼 것.  ->  npm run check:map
 *
 *  검사 항목
 *    1) 소품 충돌 박스가 벽 속에 박혀 있지 않은가
 *    2) 소품끼리 겹치지 않는가
 *    3) 스폰 / 봇 스폰 / 순찰 지점 / 해체 지점이 물체 안에 있지 않은가
 *    4) 스폰에서 모든 해체 지점까지 "반지름 0.35m 플레이어가" 실제로 걸어갈 수 있는가
 *    5) 해체 지점 주변에 설 자리가 있는가
 *
 *  4번이 핵심이다. 매대를 조금 옮겼더니 통로가 막혀서 미션 클리어가 불가능해지는
 *  사고를 눈으로는 절대 못 잡는다.
 * ========================================================================== */

import {
  MAP, WALLS, PROPS, COLLIDERS, SPAWNS, BOMB_SITES, BOT_SPAWNS, PATROL_NODES,
} from '../../public/js/map-data.js';

const R = 0.35;               // 플레이어 반지름
const CELL = 0.10;            // 격자 해상도
const HALF_W = MAP.width / 2;
const HALF_D = MAP.depth / 2;

let errors = 0, warns = 0;
const err  = (m) => { errors++; console.log(`  ✘ ${m}`); };
const warn = (m) => { warns++;  console.log(`  ⚠ ${m}`); };
const ok   = (m) => console.log(`  ✔ ${m}`);

/* --- 두 AABB 가 겹치는 넓이 --- */
function overlapArea(a, b) {
  const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const oz = Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2);
  return ox > 0 && oz > 0 ? ox * oz : 0;
}

/* --- 점이 어떤 콜라이더 안에 있는가 (여유 margin 포함) --- */
function insideAny(x, z, margin = 0) {
  for (const c of COLLIDERS) {
    if (Math.abs(x - c.x) < c.w / 2 + margin && Math.abs(z - c.z) < c.d / 2 + margin) return c;
  }
  return null;
}

console.log(`\n  ███  맵 검사: ${MAP.name}  (${MAP.width}m x ${MAP.depth}m)  ███\n`);
console.log(`  벽 ${WALLS.length}개 / 소품 ${PROPS.length}개 / 충돌박스 ${COLLIDERS.length}개\n`);

/* ========================================================================== *
 *  1 & 2. 겹침 검사
 * ========================================================================== */
const propBoxes = PROPS
  .map((p, i) => (p.col ? { ...p.col, x: p.x, z: p.z, i, model: p.model } : null))
  .filter(Boolean);

for (const pb of propBoxes) {
  for (const w of WALLS) {
    const a = overlapArea(pb, w);
    // 벽에 살짝 붙이는 건 정상. 0.06㎡(=대략 25cm x 25cm) 넘게 파고들면 문제.
    if (a > 0.06) err(`소품 #${pb.i} ${pb.model} (${pb.x}, ${pb.z}) 가 벽을 ${a.toFixed(2)}㎡ 파고듦`);
  }
  if (pb.x - pb.w / 2 < -HALF_W || pb.x + pb.w / 2 > HALF_W ||
      pb.z - pb.d / 2 < -HALF_D || pb.z + pb.d / 2 > HALF_D) {
    err(`소품 #${pb.i} ${pb.model} 가 맵 밖으로 튀어나감`);
  }
}
for (let i = 0; i < propBoxes.length; i++) {
  for (let j = i + 1; j < propBoxes.length; j++) {
    const a = overlapArea(propBoxes[i], propBoxes[j]);
    if (a > 0.05) {
      err(`소품끼리 겹침: #${propBoxes[i].i} ${propBoxes[i].model} <-> ` +
          `#${propBoxes[j].i} ${propBoxes[j].model}  (${a.toFixed(2)}㎡)`);
    }
  }
}
if (!errors) ok('소품이 벽/서로와 겹치지 않음');

/* ========================================================================== *
 *  3. 주요 지점이 물체 안에 있지 않은가
 * ========================================================================== */
const checkPoints = [
  ...SPAWNS.map((s, i) => ({ ...s, what: `플레이어 스폰 #${i}` })),
  ...BOT_SPAWNS.map((s, i) => ({ ...s, what: `봇 스폰 #${i}` })),
  ...PATROL_NODES.map((s, i) => ({ ...s, what: `순찰 지점 #${i}` })),
  ...BOMB_SITES.map((s) => ({ ...s, what: `해체 지점 ${s.id}` })),
];
let blocked = 0;
for (const p of checkPoints) {
  const c = insideAny(p.x, p.z, R);
  if (c) { err(`${p.what} (${p.x}, ${p.z}) 가 ${c.kind} 안에 끼어 있음`); blocked++; }
}
if (!blocked) ok(`주요 지점 ${checkPoints.length}곳 모두 빈 바닥에 있음`);

/* ========================================================================== *
 *  4. 걸어서 갈 수 있는가 (플러드 필)
 * ========================================================================== */
const NX = Math.ceil(MAP.width / CELL);
const NZ = Math.ceil(MAP.depth / CELL);
const idx = (ix, iz) => iz * NX + ix;
const toX = (ix) => -HALF_W + (ix + 0.5) * CELL;
const toZ = (iz) => -HALF_D + (iz + 0.5) * CELL;

// walkable: 반지름 R 인 원이 들어갈 수 있는 칸
const walk = new Uint8Array(NX * NZ);
for (let iz = 0; iz < NZ; iz++) {
  for (let ix = 0; ix < NX; ix++) {
    const x = toX(ix), z = toZ(iz);
    if (x < -HALF_W + R || x > HALF_W - R || z < -HALF_D + R || z > HALF_D - R) continue;
    // 키(1.8m)보다 낮은 물체도 못 지나간다(넘지 못함) - 전부 막힘으로 본다
    if (insideAny(x, z, R)) continue;
    walk[idx(ix, iz)] = 1;
  }
}

function floodFrom(sx, sz) {
  const seen = new Uint8Array(NX * NZ);
  const six = Math.round((sx + HALF_W) / CELL - 0.5);
  const siz = Math.round((sz + HALF_D) / CELL - 0.5);
  if (six < 0 || six >= NX || siz < 0 || siz >= NZ || !walk[idx(six, siz)]) return null;
  const q = [idx(six, siz)];
  seen[q[0]] = 1;
  while (q.length) {
    const cur = q.pop();
    const cx = cur % NX, cz = (cur - cx) / NX;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= NX || nz < 0 || nz >= NZ) continue;
      const n = idx(nx, nz);
      if (seen[n] || !walk[n]) continue;
      seen[n] = 1; q.push(n);
    }
  }
  return seen;
}

const reach = floodFrom(SPAWNS[0].x, SPAWNS[0].z);
if (!reach) {
  err('1번 스폰 자체가 막혀 있어서 도달 검사를 못 함');
} else {
  const total = walk.reduce((a, v) => a + v, 0);
  const got = reach.reduce((a, v) => a + v, 0);
  const areaAll = total * CELL * CELL;
  const areaGot = got * CELL * CELL;
  ok(`걸을 수 있는 바닥 ${areaAll.toFixed(1)}㎡ 중 ${areaGot.toFixed(1)}㎡ 도달 가능 ` +
     `(${((areaGot / areaAll) * 100).toFixed(0)}%)`);
  if (areaGot < areaAll * 0.92) {
    warn(`바닥의 ${(100 - (areaGot / areaAll) * 100).toFixed(0)}% 가 고립됨 - 못 가는 구석이 있다`);
  }

  // 나머지 스폰 + 해체 지점 + 순찰 지점 전부 도달 가능한지
  const mustReach = [
    ...SPAWNS.map((s, i) => ({ ...s, what: `스폰 #${i}` })),
    ...BOMB_SITES.map((s) => ({ ...s, what: `해체 지점 ${s.id}` })),
    ...BOT_SPAWNS.map((s, i) => ({ ...s, what: `봇 스폰 #${i}` })),
    ...PATROL_NODES.map((s, i) => ({ ...s, what: `순찰 지점 #${i}` })),
  ];
  let bad = 0;
  for (const m of mustReach) {
    const ix = Math.round((m.x + HALF_W) / CELL - 0.5);
    const iz = Math.round((m.z + HALF_D) / CELL - 0.5);
    if (ix < 0 || ix >= NX || iz < 0 || iz >= NZ || !reach[idx(ix, iz)]) {
      err(`${m.what} (${m.x}, ${m.z}) 에 걸어갈 수 없음 (통로가 막혔거나 물체에 끼임)`);
      bad++;
    }
  }
  if (!bad) ok(`스폰에서 해체 지점 ${BOMB_SITES.length}곳 + 순찰 지점 전부 도달 가능`);
}

/* ========================================================================== *
 *  5. 해체 지점 주변에 설 자리가 있는가
 * ========================================================================== */
const DEFUSE_RANGE = 1.6;
for (const site of BOMB_SITES) {
  let spots = 0;
  for (let a = 0; a < 24; a++) {
    for (const rr of [0.7, 1.0, 1.3]) {
      const x = site.x + Math.cos((a / 24) * Math.PI * 2) * rr;
      const z = site.z + Math.sin((a / 24) * Math.PI * 2) * rr;
      if (rr > DEFUSE_RANGE) continue;
      if (!insideAny(x, z, R) &&
          x > -HALF_W + R && x < HALF_W - R && z > -HALF_D + R && z < HALF_D - R) spots++;
    }
  }
  if (spots < 6) err(`해체 지점 ${site.id} 주변에 설 자리가 거의 없음 (${spots}칸)`);
  else ok(`해체 지점 ${site.id} 주변 설 자리 ${spots}칸`);
}

/* ========================================================================== *
 *  통로 폭 리포트 (참고용)
 * ========================================================================== */
console.log('\n  --- 주요 단면의 통로 폭 (z 축 기준으로 X 를 훑음) ---');
for (const z of [-4.2, -3.0, -1.8, 0.15, 1.6, 2.4, 4.2]) {
  const spans = [];
  let run = null;
  for (let ix = 0; ix < NX; ix++) {
    const x = toX(ix);
    const free = !insideAny(x, z, 0) && x > -HALF_W + 0.15 && x < HALF_W - 0.15;
    if (free && !run) run = { from: x };
    else if (!free && run) { run.to = x; spans.push(run); run = null; }
  }
  if (run) { run.to = toX(NX - 1); spans.push(run); }
  const txt = spans
    .filter((s) => s.to - s.from > 0.15)
    .map((s) => `${(s.to - s.from).toFixed(2)}m`)
    .join(', ');
  console.log(`   z=${String(z).padStart(5)} :  ${txt || '(완전히 막힘)'}`);
}

/* ========================================================================== *
 *  ASCII 미니맵
 * ========================================================================== */
console.log('\n  --- 미니맵 (# 벽/소품, · 바닥, S 스폰, B 봇, A/B 해체지점) ---');
const STEP = 3; // 격자 3칸(0.3m)마다 한 글자
const mark = new Map();
for (const s of SPAWNS) mark.set(`${Math.round(s.x / (CELL * STEP))},${Math.round(s.z / (CELL * STEP))}`, 'S');
for (const s of BOT_SPAWNS) mark.set(`${Math.round(s.x / (CELL * STEP))},${Math.round(s.z / (CELL * STEP))}`, 'B');
for (const s of BOMB_SITES) mark.set(`${Math.round(s.x / (CELL * STEP))},${Math.round(s.z / (CELL * STEP))}`, s.id);

for (let iz = 0; iz < NZ; iz += STEP) {
  let line = '   ';
  for (let ix = 0; ix < NX; ix += STEP) {
    const x = toX(ix), z = toZ(iz);
    const key = `${Math.round(x / (CELL * STEP))},${Math.round(z / (CELL * STEP))}`;
    const m = mark.get(key);
    if (m) { line += m; continue; }
    line += insideAny(x, z, 0) ? '#' : (walk[idx(ix, iz)] ? '·' : '˙');
  }
  console.log(line);
}

/* ========================================================================== */
console.log(`\n  결과: 오류 ${errors}개 / 경고 ${warns}개\n`);
process.exit(errors ? 1 : 0);
