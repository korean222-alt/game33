/* =============================================================================
 *  map-data.js  -  맵 정의 (서버 / 클라이언트 공용 모듈)
 *
 *  서버는 이 데이터로 충돌 / 시야(LOS) / 봇 경로를 계산하고,
 *  클라이언트는 같은 데이터로 벽과 소품을 그린다. 절대 둘이 달라지면 안 되므로
 *  맵을 고치고 싶으면 "이 파일만" 고치면 된다.
 *
 *  좌표계 (Three.js 기준)
 *    +X = 동쪽(오른쪽), +Z = 남쪽(입구 방향), +Y = 위
 *    yaw = 0 이면 -Z 방향(맵 안쪽)을 바라본다.
 *
 *  콜라이더 박스 형식: { x, z, w, d, h }
 *    x,z = 박스 중심 / w = X축 크기 / d = Z축 크기 / h = 높이(바닥 y=0 기준)
 *    h >= 1.4 인 박스는 "시야를 가리는" 물체로 취급한다(봇 LOS 판정).
 * ========================================================================== */

export const MAP = {
  name: '남부 재래시장 - 실내동',

  // 맵 크기. 실제 10평(33㎡)은 6m x 5.5m 라 4명 + 봇 5명이 들어가면 서로 겹친다.
  // 그래서 "좁은 통로" 느낌은 유지하되 전체는 15m x 11m 로 잡았다.
  // 진짜 10평으로 만들고 싶으면 width: 6, depth: 5.5 로 바꾸고 아래 좌표를 줄이면 된다.
  width: 15,
  depth: 11,
  height: 3.2,

  // 바닥/벽 머티리얼 색 (텍스처 없을 때 쓰는 기본값)
  floorColor: 0x2a2723,
  wallColor: 0x3b3832,
  ceilColor: 0x141310,
};

const HALF_W = MAP.width / 2;   // 7.5
const HALF_D = MAP.depth / 2;   // 5.5

/* -----------------------------------------------------------------------------
 *  벽 (입구 2곳: 남쪽 정문 3m, 동쪽 측면문 2m)
 * -------------------------------------------------------------------------- */
export const WALLS = [
  // 바깥 벽
  { x: 0,     z: -HALF_D, w: MAP.width, d: 0.3,  h: MAP.height }, // 북
  { x: -HALF_W, z: 0,     w: 0.3,  d: MAP.depth, h: MAP.height }, // 서
  { x: HALF_W, z: -3.25,  w: 0.3,  d: 4.5,  h: MAP.height },      // 동(위)
  { x: HALF_W, z: 3.25,   w: 0.3,  d: 4.5,  h: MAP.height },      // 동(아래)  -> z -1~1 측면문
  { x: -4.5,  z: HALF_D,  w: 6,    d: 0.3,  h: MAP.height },      // 남(좌)
  { x: 4.5,   z: HALF_D,  w: 6,    d: 0.3,  h: MAP.height },      // 남(우)    -> x -1.5~1.5 정문

  // 안쪽 칸막이 - 창고(북쪽 방) 벽, x -3 ~ -1 이 출입구
  { x: -5.25, z: -2.5, w: 4.5, d: 0.25, h: MAP.height },
  { x: 3.25,  z: -2.5, w: 8.5, d: 0.25, h: MAP.height },

  // 안쪽 칸막이 - 입구 홀 벽, x -4.5~-2.5 / 3~5 두 곳이 출입구
  { x: -6,    z: 3.0, w: 3,   d: 0.25, h: MAP.height },
  { x: 0.25,  z: 3.0, w: 5.5, d: 0.25, h: MAP.height },
  { x: 6.25,  z: 3.0, w: 2.5, d: 0.25, h: MAP.height },
];

/* -----------------------------------------------------------------------------
 *  소품 (GLB 모델 + 충돌 박스)
 *
 *  model  : assets.js 의 MODELS 키
 *  x, z   : 바닥 위치 (모델은 바닥에 발이 닿도록 이미 정규화되어 있음)
 *  ry     : Y축 회전(라디안)
 *  s      : 추가 스케일 (1 = 원본 크기)
 *  col    : 충돌 박스 { w, d, h }. 없으면 충돌하지 않는 장식품.
 *  shadow : 그림자 드리움 여부 (기본 true)
 * -------------------------------------------------------------------------- */
export const PROPS = [
  // --- 중앙 매대 3개 (통로 2개를 만든다) ---
  { model: 'stallTarp', x: -4.7, z: 0.2,  ry: 0,          s: 1,    col: { w: 2.83, d: 2.23, h: 1.84 } },
  { model: 'stallWood', x: 0.0,  z: 0.2,  ry: 0,          s: 0.72, col: { w: 3.60, d: 2.05, h: 1.95 } },
  { model: 'stallTarp', x: 4.7,  z: 0.2,  ry: Math.PI,    s: 1,    col: { w: 2.83, d: 2.23, h: 1.84 } },

  // --- 서쪽 통로 ---
  { model: 'vase',   x: -6.8, z: 0.2,  ry: 0.4,  s: 1, col: { w: 1.0, d: 1.0, h: 1.53 } },
  { model: 'crate',  x: -6.7, z: -1.7, ry: 0.2,  s: 1, col: { w: 0.8, d: 0.8, h: 0.75 } },
  { model: 'crate',  x: -6.7, z: -1.7, ry: 0.9,  s: 0.8, yOff: 0.75, col: null },
  { model: 'barrel', x: -6.6, z: 2.4,  ry: 0,    s: 1, col: { w: 0.9, d: 0.9, h: 0.99 } },

  // --- 동쪽 통로 ---
  { model: 'vase',   x: 6.8,  z: 0.2,  ry: -0.3, s: 1, col: { w: 1.0, d: 1.0, h: 1.53 } },
  { model: 'barrel', x: 6.6,  z: -1.8, ry: 0,    s: 1, col: { w: 0.9, d: 0.9, h: 0.99 } },
  { model: 'crate',  x: 6.7,  z: 2.3,  ry: -0.4, s: 1, col: { w: 0.8, d: 0.8, h: 0.75 } },

  // --- 매대 사이 통로 엄폐물 ---
  { model: 'crate',  x: -2.5, z: -1.9, ry: 0.5,  s: 1, col: { w: 0.8, d: 0.8, h: 0.75 } },
  { model: 'crate',  x: 2.5,  z: -1.9, ry: -0.2, s: 1, col: { w: 0.8, d: 0.8, h: 0.75 } },
  { model: 'barrel', x: -2.6, z: 2.3,  ry: 0,    s: 1, col: { w: 0.9, d: 0.9, h: 0.99 } },
  { model: 'crate',  x: 2.6,  z: 2.4,  ry: 0.3,  s: 1, col: { w: 0.8, d: 0.8, h: 0.75 } },

  // --- 북쪽 창고 ---
  { model: 'well',   x: -5.6, z: -4.1, ry: 0,    s: 1, col: { w: 2.1, d: 2.1, h: 2.35 } },
  { model: 'crate',  x: -1.9, z: -4.4, ry: 0.1,  s: 1, col: { w: 0.8, d: 0.8, h: 0.75 } },
  { model: 'crate',  x: -1.9, z: -4.4, ry: 0.8,  s: 0.85, yOff: 0.75, col: null },
  { model: 'crate',  x: 4.6,  z: -4.3, ry: -0.3, s: 1, col: { w: 0.8, d: 0.8, h: 0.75 } },
  { model: 'barrel', x: 6.4,  z: -4.2, ry: 0,    s: 1, col: { w: 0.9, d: 0.9, h: 0.99 } },

  // --- 입구 홀 ---
  { model: 'crate',  x: -6.6, z: 4.4,  ry: 0.2,  s: 1, col: { w: 0.8, d: 0.8, h: 0.75 } },
  { model: 'barrel', x: 6.5,  z: 4.4,  ry: 0,    s: 1, col: { w: 0.9, d: 0.9, h: 0.99 } },
];

/* -----------------------------------------------------------------------------
 *  천장 전구 (은은한 실내 조명)
 * -------------------------------------------------------------------------- */
export const LIGHTS = [
  { x: -4.7, y: 2.75, z: 0.2,  color: 0xffb46b, intensity: 14, distance: 8 },
  { x: 0.0,  y: 2.75, z: 0.2,  color: 0xffc182, intensity: 16, distance: 9 },
  { x: 4.7,  y: 2.75, z: 0.2,  color: 0xffb46b, intensity: 14, distance: 8 },
  { x: -1.0, y: 2.75, z: -4.0, color: 0x9fb4d0, intensity: 10, distance: 8 },
  { x: 4.5,  y: 2.75, z: -4.0, color: 0xffa95e, intensity: 10, distance: 7 },
  { x: 0.0,  y: 2.75, z: 4.3,  color: 0xcfd8e6, intensity: 12, distance: 8 },
  { x: -6.8, y: 2.75, z: 1.6,  color: 0xff9d52, intensity: 8,  distance: 6 },
  { x: 6.8,  y: 2.75, z: 1.6,  color: 0xff9d52, intensity: 8,  distance: 6 },
];

/* -----------------------------------------------------------------------------
 *  스폰 / 목표 / 봇 경로
 * -------------------------------------------------------------------------- */
export const SPAWNS = [
  { x: -3.4, z: 4.6, yaw: 0 },
  { x: 3.8,  z: 4.6, yaw: 0 },
  { x: -3.4, z: 3.8, yaw: 0 },
  { x: 3.8,  z: 3.8, yaw: 0 },
];

// 폭발물 해체 지점
export const BOMB_SITES = [
  { id: 'A', x: 2.0,  z: -4.1, label: '창고 A' },
  { id: 'B', x: -6.2, z: 1.55, label: '서편 통로 B' },
];

export const BOT_SPAWNS = [
  { x: 3.4,  z: -4.2 },
  { x: -3.2, z: -4.2 },
  { x: 6.7,  z: -2.1 },
  { x: -6.7, z: -2.6 },
  { x: 6.7,  z: 2.6 },
  { x: 0.0,  z: -1.9 },
];

// 봇이 순찰하며 돌아다니는 지점
export const PATROL_NODES = [
  { x: -6.7, z: -1.2 }, { x: -2.5, z: -1.5 }, { x: 2.5,  z: -1.5 },
  { x: 6.7,  z: -1.2 }, { x: 6.7,  z: 2.3 },  { x: 2.5,  z: 2.5 },
  { x: -2.5, z: 2.5 },  { x: -6.7, z: 2.3 },  { x: -1.9, z: -3.6 },
  { x: 4.5,  z: -3.9 }, { x: -4.0, z: -3.3 }, { x: 0.0,  z: 4.2 },
];

/* -----------------------------------------------------------------------------
 *  파생 데이터: 전체 충돌 박스 목록
 * -------------------------------------------------------------------------- */
export const COLLIDERS = (() => {
  const list = WALLS.map((w) => ({ ...w, kind: 'wall' }));
  for (const p of PROPS) {
    if (!p.col) continue;
    list.push({ x: p.x, z: p.z, w: p.col.w, d: p.col.d, h: p.col.h, kind: 'prop' });
  }
  return list;
})();

/* -----------------------------------------------------------------------------
 *  공용 헬퍼 - 서버/클라 동일한 물리를 쓰기 위해 여기에 둔다
 * -------------------------------------------------------------------------- */

/** 점이 맵 밖인지 */
export function outOfBounds(x, z) {
  return x < -HALF_W + 0.2 || x > HALF_W - 0.2 || z < -HALF_D + 0.2 || z > HALF_D - 0.2;
}

/**
 * 반지름 r 인 원(플레이어/봇)을 박스들 밖으로 밀어낸다.
 * 축별로 최소 침투 방향을 골라 밀어내는 방식 - 벽에 붙어서 걸어도 안 끼인다.
 * @returns {{x:number, z:number}}
 */
export function resolveCircle(x, z, r, colliders = COLLIDERS) {
  for (let pass = 0; pass < 2; pass++) {
    for (const c of colliders) {
      const hw = c.w / 2 + r;
      const hd = c.d / 2 + r;
      const dx = x - c.x;
      const dz = z - c.z;
      if (Math.abs(dx) >= hw || Math.abs(dz) >= hd) continue;

      const overlapX = hw - Math.abs(dx);
      const overlapZ = hd - Math.abs(dz);
      if (overlapX < overlapZ) x += dx >= 0 ? overlapX : -overlapX;
      else z += dz >= 0 ? overlapZ : -overlapZ;
    }
  }
  // 맵 경계
  const lim = 0.2;
  x = Math.max(-HALF_W + lim + r, Math.min(HALF_W - lim - r, x));
  z = Math.max(-HALF_D + lim + r, Math.min(HALF_D - lim - r, z));
  return { x, z };
}

/**
 * 2D 시야 판정. eyeH 보다 낮은 엄폐물은 시야를 가리지 않는다.
 * (총알 궤적 판정에도 같은 함수를 쓴다)
 */
export function hasLineOfSight(ax, az, bx, bz, eyeH = 1.4, colliders = COLLIDERS) {
  const dx = bx - ax;
  const dz = bz - az;
  for (const c of colliders) {
    if (c.h < eyeH) continue;
    if (segmentHitsBox(ax, az, dx, dz, c)) return false;
  }
  return true;
}

/** 선분 (ax,az)+(dx,dz)*t, t in [0,1] 이 AABB 와 겹치는지 (slab test) */
export function segmentHitsBox(ax, az, dx, dz, c) {
  const minX = c.x - c.w / 2, maxX = c.x + c.w / 2;
  const minZ = c.z - c.d / 2, maxZ = c.z + c.d / 2;
  let t0 = 0, t1 = 1;

  for (const [o, d, mn, mx] of [[ax, dx, minX, maxX], [az, dz, minZ, maxZ]]) {
    if (Math.abs(d) < 1e-8) {
      if (o < mn || o > mx) return false;
      continue;
    }
    let ta = (mn - o) / d;
    let tb = (mx - o) / d;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/** 선분이 벽에 막히기 전까지의 거리 (막히지 않으면 Infinity) */
export function rayWallDistance(ox, oz, dirX, dirZ, maxDist, eyeH = 1.4, colliders = COLLIDERS) {
  let best = Infinity;
  for (const c of colliders) {
    if (c.h < eyeH) continue;
    const minX = c.x - c.w / 2, maxX = c.x + c.w / 2;
    const minZ = c.z - c.d / 2, maxZ = c.z + c.d / 2;
    let t0 = 0, t1 = maxDist;
    let ok = true;
    for (const [o, d, mn, mx] of [[ox, dirX, minX, maxX], [oz, dirZ, minZ, maxZ]]) {
      if (Math.abs(d) < 1e-8) { if (o < mn || o > mx) { ok = false; break; } continue; }
      let ta = (mn - o) / d, tb = (mx - o) / d;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) { ok = false; break; }
    }
    if (ok && t0 >= 0 && t0 < best) best = t0;
  }
  return best;
}

/** Distance along a normalized 3D ray: crouching, jumping and low cover all count. */
export function rayObstacleDistance(origin, direction, maxDist, colliders = COLLIDERS) {
  let best = maxDist;
  for (const c of colliders) {
    let near = 0, far = best;
    for (const [o, d, lo, hi] of [
      [origin.x, direction.x, c.x - c.w / 2, c.x + c.w / 2],
      [origin.y, direction.y, 0, c.h],
      [origin.z, direction.z, c.z - c.d / 2, c.z + c.d / 2],
    ]) {
      if (Math.abs(d) < 1e-8) { if (o < lo || o > hi) { far = -1; break; } continue; }
      const a = (lo - o) / d, b = (hi - o) / d;
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
      if (near > far) break;
    }
    if (near <= far && far >= 0) best = Math.min(best, near);
  }
  // Floor and ceiling are also visible shot surfaces.
  if (Math.abs(direction.y) > 1e-8) for (const y of [0, MAP.height]) {
    const t = (y - origin.y) / direction.y;
    if (t >= 0) best = Math.min(best, t);
  }
  return best;
}
