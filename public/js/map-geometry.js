/* =============================================================================
 *  map-geometry.js  -  맵이 무엇이든 똑같이 도는 기하 연산
 *
 *  충돌 · 시야 · 길찾기. 여기에는 저택도 사무실도 없다. 전부 콜라이더 배열과
 *  경계 상자를 인자로 받고, 인자를 생략하면 지금 켜져 있는 맵의 것을 쓴다.
 *
 *  맵을 고르는 일은 map-data.js 가 한다. 이 파일은 "무엇을 계산하는가" 만
 *  알고 "어느 건물인가" 는 모른다 - 그 경계가 두 번째 맵을 넣을 수 있게 한
 *  전부다.
 * ========================================================================== */

/* 지금 켜져 있는 맵의 콜라이더와 경계. map-data.js 의 setActiveMap 이 넣는다.
 * 인자를 생략한 호출(대부분의 클라이언트 코드)이 이걸 본다. */
let active = {
  colliders: [], halfW: 44, halfD: 44, height: 7,
  // 천장이 있는 곳인가. 총알이 천장에 막히는지 판단하는 데만 쓴다.
  isIndoors: () => false,
};

export function useGeometry(map) {
  active = {
    colliders: map.COLLIDERS,
    halfW: map.MAP.width / 2,
    halfD: map.MAP.depth / 2,
    height: map.MAP.height,
    isIndoors: map.isIndoors,
  };
}

const defaults = () => active.colliders;

/** 맵 경계 밖인가 (담장/부지 끝). */
export function outOfBounds(x, z, bounds = active) {
  return Math.abs(x) > bounds.halfW - .2 || Math.abs(z) > bounds.halfD - .2;
}

/* ========================================================================== *
 *  콜라이더 브로드페이즈
 * ========================================================================== */
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
export function nearbyColliders(x, z, r, list = defaults()) {
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
 *  충돌 / 시야 판정
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

// 원 vs 회전 사각형. 모서리는 둥글게 처리한다(보이지 않는 큰 상자가 생기지 않게).
export function resolveCircle(x, z, r, colliders = defaults(), feet = 0, height = 1.8) {
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
    x: Math.max(-active.halfW + .2 + r, Math.min(active.halfW - .2 - r, x)),
    z: Math.max(-active.halfD + .2 + r, Math.min(active.halfD - .2 - r, z)),
  };
}

export function moveBody(pos, velocity, dt, opts = {}, colliders = defaults()) {
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
      let headLimit = active.height;
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
      let headLimit = active.height;
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
export function groundHeight(x, z, radius = .38, colliders = defaults(), from = 0, step = .45) {
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

export function hasLineOfSight(ax, az, bx, bz, eyeH = 1.4, colliders = defaults()) {
  const dx = bx - ax, dz = bz - az;
  return !segmentCandidates(ax, az, dx, dz, Math.hypot(dx, dz), colliders)
    .some((c) => boxRay(ax, eyeH, az, dx, 0, dz, 1, c) <= 1);
}

export function rayWallDistance(ox, oz, dx, dz, maxDist, eyeH = 1.4, colliders = defaults()) {
  let best = Infinity;
  for (const c of segmentCandidates(ox, oz, dx, dz, maxDist, colliders)) {
    best = Math.min(best, boxRay(ox, eyeH, oz, dx, 0, dz, maxDist, c));
  }
  return best;
}

export function rayObstacleDistance(o, d, maxDist, colliders = defaults()) {
  let best = maxDist;
  for (const c of segmentCandidates(o.x, o.z, d.x, d.z, maxDist, colliders)) {
    best = Math.min(best, boxRay(o.x, o.y, o.z, d.x, d.y, d.z, best, c));
  }
  if (Math.abs(d.y) > 1e-8) {
    // 바닥과 (실내라면) 천장
    for (const y of [0, active.height]) {
      const t = (y - o.y) / d.y;
      if (t >= 0 && t < best && (y === 0 || active.isIndoors(o.x + d.x * t, o.z + d.z * t))) best = t;
    }
  }
  return best;
}

/** 두 점 사이를 가로막는 고체의 개수 (소리 감쇠용). */
export function obstaclesBetween(a, b, eyeH = 1.3, colliders = defaults()) {
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
 *  길찾기
 *
 *  0.5m 격자를 맵마다 한 번씩 만들어 두고 매번 너비 우선 탐색만 한다. 문은
 *  봇이 열 수 있으므로 통행 가능한 것으로 본다(대신 실제로 열 때 소리가 난다).
 *
 *  격자는 맵의 크기에 맞춰 잡아야 해서 - 저택 88×88 과 사무실은 칸 수가 다르다 -
 *  모듈 최상위 상수가 아니라 맵마다 하나씩 만드는 객체로 두었다. 처음 길을
 *  물을 때까지 만들지 않으므로, 안 고른 맵의 격자를 짓느라 시작이 느려지지
 *  않는다.
 * ========================================================================== */
const NAV_STEP = .5, NAV_RADIUS = .4;

export function createNav(map) {
  const NAV_W = Math.round(map.MAP.width / NAV_STEP), NAV_D = Math.round(map.MAP.depth / NAV_STEP);
  const NAV_LEFT = -map.MAP.width / 2 + NAV_STEP / 2, NAV_TOP = -map.MAP.depth / 2 + NAV_STEP / 2;
  let navFree = null, navEdges = null, prevBuffer = null, queueBuffer = null, NAV_MOVES = null;

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
    prevBuffer = new Int32Array(NAV_W * NAV_D);
    queueBuffer = new Int32Array(NAV_W * NAV_D);
    // [격자 인덱스 증감, navEdges 비트] - 아래 dirs 순서와 같아야 한다.
    NAV_MOVES = [[1, 1], [-1, 2], [NAV_W, 4], [-NAV_W, 8]];
    // 0.42m 이하의 단·계단·테라스는 걸어 올라갈 수 있으므로 장애물이 아니다.
    const solid = map.COLLIDERS.filter((c) => (c.y || 0) < 1.5 && top(c) > .42);
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

  /** start 에서 goal 까지의 경유점 목록. 길이 0 이면 경로가 없다. */
  function findRoute(start, goal) {
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

  return {
    findRoute,
    /** 격자 위에서 서로 닿을 수 있는지 (경로 존재 여부만 빠르게 확인). */
    isReachable: (from, to) => findRoute(from, to).length > 0,
  };
}

/* ========================================================================== *
 *  엄폐 지점
 *
 *  허리 높이 장애물의 네 변 바깥쪽을 후보로 삼는다. AI 가 "벽 뒤에 숨는" 판단을
 *  할 때 쓴다.
 * ========================================================================== */
export function buildCoverPoints(colliders, halfW, halfD, zoneOf) {
  const points = [];
  for (const c of colliders) {
    const height = top(c);
    if ((c.y || 0) > .35 || height < .5 || height > 2.0) continue;
    const co = Math.cos(c.ry || 0), si = Math.sin(c.ry || 0);
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const lx = sx * (c.w / 2 + .55), lz = sz * (c.d / 2 + .55);
      const x = c.x + co * lx + si * lz, z = c.z - si * lx + co * lz;
      if (Math.abs(x) > halfW - 1 || Math.abs(z) > halfD - 1) continue;
      const fixed = resolveCircle(x, z, .4, colliders);
      if (Math.hypot(fixed.x - x, fixed.z - z) > .01) continue;
      points.push({ x, z, height, cx: c.x, cz: c.z, room: zoneOf(x, z) });
    }
  }
  return points;
}
