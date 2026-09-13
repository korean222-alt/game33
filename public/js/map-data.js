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

  // 안쪽 칸막이 - 창고(북쪽 방) 벽.  출입구 2곳:
  //   서편 x -3 ~ -1 (정면 돌입)  /  동편 x 4 ~ 5.5 (측면 우회)
  //   ★ 출입구가 하나뿐이면 봇이 문 앞에 뭉쳐서 미션이 불가능해진다.
  { x: -5.25, z: -2.5, w: 4.5, d: 0.25, h: MAP.height },   // x -7.5 ~ -3.0
  { x: 1.5,   z: -2.5, w: 5.0, d: 0.25, h: MAP.height },   // x -1.0 ~  4.0
  { x: 6.5,   z: -2.5, w: 2.0, d: 0.25, h: MAP.height },   // x  5.5 ~  7.5

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
 *  ry     : Y축 회전(라디안).  ★ ry 가 ±90도면 col 의 w 와 d 를 바꿔서 적어야 한다.
 *  s      : 추가 스케일 (1 = 원본 크기)
 *  col    : 충돌 박스 { w, d, h }. 없으면 충돌하지 않는 장식품.
 *  yOff   : 바닥에서 띄우기 (상자 쌓기용)
 *
 *  ※ col 값은 tools/build-assets.mjs 가 출력한 실제 GLB 크기와 맞춰져 있다.
 *    모델을 교체했는데 몸이 허공에서 막히면 여기 숫자부터 확인할 것.
 *    npm run check:map 으로 겹침/막힘을 자동 검사할 수 있다.
 *
 *  실제 모델 크기 (m):
 *    stallTarp 2.83 x 1.51(h) x 1.58 | stallWood 3.09 x 2.62(h) x 3.06
 *    crate 0.75³ | barrel 0.87 x 0.99(h) | vase 1.02 x 1.53(h)
 *    well 2.14 x 2.35(h) | table 1.60 x 1.18(h) x 3.20 | rack 0.39 x 1.90(h) x 1.78
 * -------------------------------------------------------------------------- */
export const PROPS = [
  /* === 중앙 시장통 - 매대 3개가 세로 통로 4개를 만든다 ==================== *
   *  벽 안쪽 폭 14.7m 를 이렇게 나눈다 (npm run check:map 으로 검증됨):
   *    서벽통로 1.40 | 매대 2.83 | 통로 1.58 | 중앙매대 3.09 |
   *    통로 1.58 | 매대 2.83 | 동벽통로 1.40
   *  1.4m 통로에 진열대(0.39)를 붙여도 1.0m 가 남아서 뛰어다닐 수 있다.      */
  { model: 'stallTarp', x: -4.535, z: 0.15, ry: 0,       s: 1, col: { w: 2.83, d: 1.58, h: 1.51 } },
  { model: 'stallWood', x:  0.000, z: 0.15, ry: 0,       s: 1, col: { w: 3.09, d: 3.06, h: 2.62 } },
  { model: 'stallTarp', x:  4.535, z: 0.15, ry: Math.PI, s: 1, col: { w: 2.83, d: 1.58, h: 1.51 } },

  // --- 매대 위 잡화 (충돌 없음 / 실루엣만 흐트러뜨린다) ---
  { model: 'crate', x: -5.30, z: 0.15, ry: 0.30,  s: 0.50, yOff: 1.51, col: null },
  { model: 'crate', x: -3.85, z: 0.15, ry: -0.20, s: 0.42, yOff: 1.51, col: null },
  { model: 'crate', x:  5.15, z: 0.15, ry: 0.50,  s: 0.46, yOff: 1.51, col: null },
  { model: 'crate', x:  3.90, z: 0.15, ry: -0.35, s: 0.40, yOff: 1.51, col: null },

  /* === 양쪽 벽면 진열대 (벽에 딱 붙인다 - 통로는 1.0m 남는다) ============= */
  { model: 'rack', x: -7.15, z: -1.35, ry: 0, s: 1, col: { w: 0.39, d: 1.78, h: 1.90 } },
  { model: 'rack', x:  7.15, z: -1.35, ry: 0, s: 1, col: { w: 0.39, d: 1.78, h: 1.90 } },

  /* === 통로 엄폐물 =======================================================
   *  ★ 좌우 1.4m 통로에는 절대 큰 물건을 두지 않는다 (길이 막힌다).
   *    엄폐물은 전부 가운데 1.58m 통로와 넓은 방에만 둔다.                  */
  { model: 'crate',  x: -2.33, z: -1.85, ry: 0.35, s: 1, col: { w: 0.75, d: 0.75, h: 0.75 } },
  { model: 'crate',  x: -2.33, z: -1.85, ry: 1.10, s: 0.8, yOff: 0.75, col: null },
  { model: 'crate',  x:  2.33, z: -1.85, ry: -0.2, s: 1, col: { w: 0.75, d: 0.75, h: 0.75 } },
  // ★ 이 두 드럼통은 "입구 홀로 나가는 문 앞" 을 좁히는 역할이다.
  //   매대 바로 뒤(x=±2.33)에 두면 매대와 드럼통 사이가 막혀서
  //   매대 남쪽이 통째로 고립된 주머니가 된다 (check:map 이 잡아준다).
  { model: 'barrel', x: -2.90, z:  2.30, ry: 0,    s: 1, col: { w: 0.87, d: 0.87, h: 0.99 } },
  { model: 'barrel', x:  4.40, z:  2.30, ry: 0,    s: 1, col: { w: 0.87, d: 0.87, h: 0.99 } },

  /* === 북쪽 창고 (목표 A 가 있는 방) ====================================
   *  ★ 우물은 깊이가 2.14m 나 돼서 방 한가운데 두면 지나갈 틈이 안 남는다.
   *    북서 모서리에 벽과 딱 붙여서 끼워 넣으면 죽은 공간 없이 시야만 막는다.  */
  { model: 'well',  x: -6.28, z: -4.28, ry: 0,           s: 1, col: { w: 2.14, d: 2.14, h: 2.35 } },
  // 긴 작업대 - 90도 돌렸으므로 w 와 d 를 바꿔 적는다 (1.60x3.20 -> 3.20x1.60)
  { model: 'table', x:  2.60, z: -4.50, ry: Math.PI / 2, s: 1, col: { w: 3.20, d: 1.60, h: 1.18 } },
  // 서편 출입구 옆 - 문을 막지 않으면서 "문틀 슬라이싱" 을 만들어준다
  { model: 'vase',  x: -3.55, z: -3.40, ry: 0.4,         s: 1, col: { w: 1.02, d: 1.02, h: 1.53 } },
  { model: 'crate', x: -0.30, z: -4.85, ry: 0.15,        s: 1, col: { w: 0.75, d: 0.75, h: 0.75 } },
  { model: 'crate', x: -0.30, z: -4.85, ry: 0.90,        s: 0.85, yOff: 0.75, col: null },
  { model: 'barrel',x:  6.60, z: -3.30, ry: 0,           s: 1, col: { w: 0.87, d: 0.87, h: 0.99 } },

  /* === 남쪽 입구 홀 (스폰 지점) ========================================= */
  { model: 'crate',  x: -6.85, z: 4.85, ry: 0.2,  s: 1, col: { w: 0.75, d: 0.75, h: 0.75 } },
  { model: 'barrel', x:  6.80, z: 4.85, ry: 0,    s: 1, col: { w: 0.87, d: 0.87, h: 0.99 } },
  { model: 'vase',   x: -6.75, z: 3.70, ry: -0.2, s: 1, col: { w: 1.02, d: 1.02, h: 1.53 } },
];

/* -----------------------------------------------------------------------------
 *  천장 전구 (은은한 실내 조명)
 * -------------------------------------------------------------------------- */
export const LIGHTS = [
  /* ★ 순서가 중요하다.
   *  낮은 화질에서는 앞에서 N 개만 켜지므로(QUALITY.pointLights),
   *  "앞쪽 3개만 켜도 세 구역이 다 보이게" 배치 순서를 잡아야 한다.
   *  예전처럼 매대 3개를 앞에 두면 낮은 화질에서 창고가 암흑이 된다.        */

  // --- 1~3번: 구역마다 하나씩 (낮은 화질에서도 이건 켜진다) ---
  { x:  0.000, y: 2.95, z:  0.15, color: 0xffc182, intensity: 17, distance: 10.0 }, // 시장 한가운데
  { x: -0.500, y: 2.80, z: -4.00, color: 0x9fb4d0, intensity: 14, distance: 10.0 }, // 창고
  { x:  0.000, y: 2.80, z:  4.40, color: 0xcfd8e6, intensity: 13, distance:  9.0 }, // 입구 홀

  // --- 4~5번: 양쪽 매대 (보통 화질부터) ---
  { x: -4.535, y: 2.72, z:  0.15, color: 0xffb46b, intensity: 13, distance: 8.0 },
  { x:  4.535, y: 2.72, z:  0.15, color: 0xffb46b, intensity: 13, distance: 8.0 },

  // --- 6~8번: 구석 분위기용 (높은 화질부터) ---
  { x:  4.600, y: 2.80, z: -4.00, color: 0x9fb4d0, intensity: 10, distance: 7.5 },
  { x: -6.650, y: 2.70, z: -0.60, color: 0xff9d52, intensity: 8,  distance: 6.0 },
  { x:  6.650, y: 2.70, z: -0.60, color: 0xff9d52, intensity: 8,  distance: 6.0 },
];

/* -----------------------------------------------------------------------------
 *  스폰 / 목표 / 봇 경로
 * -------------------------------------------------------------------------- */
export const SPAWNS = [
  { x: -1.1, z: 4.55, yaw: 0 },
  { x:  1.1, z: 4.55, yaw: 0 },
  { x: -3.4, z: 4.55, yaw: 0 },
  { x:  3.4, z: 4.55, yaw: 0 },
];

/* 폭발물 해체 지점 - 반경 1.6m 안에 서서 버튼을 누르고 있어야 한다.
 * 두 곳 다 해체하면 승리. 서로 멀리 떨어뜨려서 팀이 갈라지게 만든다. */
export const BOMB_SITES = [
  { id: 'A', x:  6.30, z: -4.35, label: '창고 동편 A' },
  { id: 'B', x: -6.65, z:  0.90, label: '서편 통로 B' },
];

export const BOT_SPAWNS = [
  { x: -2.00, z: -3.10 },
  { x:  0.80, z: -3.15 },
  { x:  6.45, z: -1.35 },
  { x: -6.45, z: -1.35 },
  { x:  6.45, z:  1.60 },
  { x:  0.00, z: -1.95 },
  { x: -0.10, z:  2.40 },
];

// 봇이 순찰하며 돌아다니는 지점 (전부 빈 바닥이어야 한다 - npm run check:map 이 검사)
export const PATROL_NODES = [
  // 좌우 벽 통로 (진열대 때문에 걸을 수 있는 중심선은 x = ±6.45 다)
  { x: -6.45, z: -1.60 }, { x: -6.55, z:  0.40 }, { x: -6.55, z:  1.90 },
  { x:  6.45, z: -1.60 }, { x:  6.55, z:  0.40 }, { x:  6.55, z:  1.90 },
  // 매대 사이 통로
  { x: -2.33, z: -0.70 }, { x: -2.33, z:  1.20 },
  { x:  2.33, z: -0.70 }, { x:  2.33, z:  1.20 },
  // 매대 앞뒤
  { x:  0.00, z: -1.95 }, { x:  0.00, z:  2.40 },
  // 창고
  { x: -1.90, z: -3.00 }, { x:  0.90, z: -3.15 }, { x: -2.20, z: -4.60 },
  { x:  4.80, z: -3.05 }, { x:  5.90, z: -4.60 },
  // 입구 홀
  { x:  0.00, z:  4.20 }, { x: -4.20, z:  4.30 }, { x:  4.20, z:  4.30 },
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

/* -----------------------------------------------------------------------------
 *  3D 판정 - "엄폐" 가 실제로 동작하게 하는 핵심
 *
 *  예전 버전은 전부 2D(평면) 판정이라, 높이 0.99m 짜리 드럼통 뒤에 앉아 있어도
 *  봇이 그냥 보고 쐈다. 눈에는 분명 가려져 있는데 총알이 통과하니 억울하다.
 *  아래 두 함수는 박스를 "바닥 y=0 부터 높이 h 까지" 인 진짜 3D 상자로 보고
 *  광선을 검사한다. 그래서 앉아서 엄폐하면 정말로 안 맞는다.
 * -------------------------------------------------------------------------- */

/**
 * 3D 광선 vs 박스들. 처음 막히는 지점까지의 거리를 돌려준다(없으면 Infinity).
 * 방향 (dx,dy,dz) 는 정규화되어 있어야 한다.
 */
export function raycastBoxes(ox, oy, oz, dx, dy, dz, maxDist, colliders = COLLIDERS) {
  let best = Infinity;

  for (const c of colliders) {
    const bounds = [
      [c.x - c.w / 2, c.x + c.w / 2],
      [0, c.h],
      [c.z - c.d / 2, c.z + c.d / 2],
    ];
    const o = [ox, oy, oz];
    const d = [dx, dy, dz];

    let t0 = 0;
    let t1 = maxDist;
    let ok = true;

    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-8) {
        // 이 축으로는 안 움직인다 -> 시작점이 박스 밖이면 절대 안 맞는다
        if (o[i] < bounds[i][0] || o[i] > bounds[i][1]) { ok = false; break; }
        continue;
      }
      let ta = (bounds[i][0] - o[i]) / d[i];
      let tb = (bounds[i][1] - o[i]) / d[i];
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) { ok = false; break; }
    }

    if (ok && t0 >= 0 && t0 < best) best = t0;
  }

  return best;
}

/**
 * 두 지점(눈높이 포함) 사이가 뚫려 있는가.
 * 봇 시야 판정과 총알 판정에 같은 함수를 쓴다 -> "보이면 맞고, 안 보이면 안 맞는다"
 */
export function hasLineOfSight3D(ax, ay, az, bx, by, bz, colliders = COLLIDERS) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const hit = raycastBoxes(ax, ay, az, dx / len, dy / len, dz / len, len, colliders);
  return hit >= len - 1e-4;
}
