/* =============================================================================
 *  decor-layout.js  -  장식을 어디에 걸지 정한다 (three 없이 좌표만 계산한다)
 *
 *  예전에는 창문·이름표·액자 좌표를 visuals.js 에 손으로 적어 두었다. 저택을
 *  두 배로 넓히면서 벽이 전부 옮겨 갔는데 그 좌표는 그대로여서, 유리창 한 장이
 *  북쪽 복도 한가운데 공중에 떠 있고(화면에 "이상한 게 튀어나와" 보이던 것이
 *  이것이다) 방 이름표는 대홀 허공에 붙어 있었다.
 *
 *  그래서 좌표를 적어 두지 않는다. map-data 의 벽에서 "그 자리에 진짜 벽 살이
 *  있는가"를 물어보고, 있는 자리에만 건다. 벽이 옮겨 가면 장식도 따라간다.
 *  three 를 부르지 않으므로 node 에서 그대로 검사할 수 있다.
 * ========================================================================== */

import { MAP, ROOMS, CORRIDORS, WALLS, DOORWAYS, ARCHES } from './map-data.js';

/**
 * (axis, plane) 평면 위 along 좌표에서, y0~y1 구간이 벽 살로 꽉 차 있는가.
 * 문 구멍과 복도 출입구는 벽 살이 없으므로 false 가 된다.
 */
export function wallSolidAt(axis, plane, along, y0, y1) {
  for (const w of WALLS) {
    const wallPlane = axis === 'x' ? w.x : w.z;
    const thickness = axis === 'x' ? w.w : w.d;
    if (Math.abs(wallPlane - plane) > thickness / 2 + 0.01) continue;
    const half = (axis === 'x' ? w.d : w.w) / 2;
    const center = axis === 'x' ? w.z : w.x;
    if (Math.abs(along - center) > half) continue;
    const bottom = w.y || 0;
    if (y0 >= bottom - 0.01 && y1 <= bottom + w.h + 0.01) return true;
  }
  return false;
}

/** 벽면에 붙이는 장식의 좌표와 yaw. side 가 +1 이면 평면의 큰 쪽을 본다. */
export function onWall(axis, plane, along, side, offset) {
  return axis === 'x'
    ? { x: plane + side * offset, z: along, ry: side > 0 ? Math.PI / 2 : -Math.PI / 2 }
    : { x: along, z: plane + side * offset, ry: side > 0 ? 0 : Math.PI };
}

/* ---- 양탄자 ---------------------------------------------------------------
 * 방 안에 들어가는 크기로만 깐다. 예전에는 대홀 계열(x = 0)에 7 x 26 을 깔았는데,
 * 저택이 넓어지며 계단홀·현관홀도 x = 0 이 되어 26m 짜리 양탄자가 벽을 뚫고
 * 앞마당까지 삐져나갔다.
 * -------------------------------------------------------------------------- */
export function roomRugs() {
  return ROOMS.map((r) => ({
    name: r.name, x: r.x, z: r.z,
    w: Math.max(2, r.w - 4), d: Math.max(2, r.d - 4),
    grand: r.name === 'GRAND HALL',
  }));
}

/* ---- 방 이름표 -------------------------------------------------------------
 * 복도에서 그 방으로 들어가는 문(또는 아치) 위에, 복도 쪽을 보게 건다.
 * 문 앞에 서면 어느 방인지 읽히고, 방 안에서는 보이지 않는다.
 * -------------------------------------------------------------------------- */
export const SIGN_HEIGHT = MAP.doorHeight + 0.52;

export function roomSigns() {
  const corridorNames = new Set(CORRIDORS.map((c) => c.name));
  const byRoom = new Map();
  for (const opening of [...DOORWAYS, ...ARCHES]) {
    const [a, b] = opening.link || [];
    if (!a || !b) continue;
    const corridor = corridorNames.has(a) ? a : corridorNames.has(b) ? b : null;
    const room = corridor === a ? b : corridor === b ? a : null;
    if (!room || !corridor || byRoom.has(room)) continue;
    byRoom.set(room, { opening, corridor });
  }

  const out = [];
  for (const r of ROOMS) {
    const hit = byRoom.get(r.name);
    if (!hit) continue;
    const { opening, corridor } = hit;
    const c = CORRIDORS.find((x) => x.name === corridor);
    const plane = opening.axis === 'x' ? opening.x : opening.z;
    const along = opening.axis === 'x' ? opening.z : opening.x;
    const side = Math.sign((opening.axis === 'x' ? c.x : c.z) - plane) || 1;
    const width = Math.min(opening.span - 0.1, 2.6);
    const half = width / 8;                       // 이름표 높이는 폭의 1/4
    if (!wallSolidAt(opening.axis, plane, along, SIGN_HEIGHT - half, SIGN_HEIGHT + half)) continue;
    const at = onWall(opening.axis, plane, along, side, opening.thickness / 2 + 0.04);
    out.push({ ...at, y: SIGN_HEIGHT, width, name: r.name, label: r.label });
  }
  return out;
}

/* ---- 외벽 창문 -------------------------------------------------------------
 * 바깥벽 "안에" 끼워 넣는다. 벽보다 4cm 두꺼워서 안팎으로 2cm 씩 도드라지지만
 * 지나다니는 길로는 나오지 않는다. 벽 살이 없는 자리에는 아예 걸지 않는다.
 * -------------------------------------------------------------------------- */
export const WINDOW = { w: 1.9, h: 2.8, y: 3.6, depth: 0.44 };

export function exteriorWindows() {
  const i = MAP.interior;
  const walls = [
    { axis: 'x', plane: i.minX, from: i.minZ, to: i.maxZ },
    { axis: 'x', plane: i.maxX, from: i.minZ, to: i.maxZ },
    { axis: 'z', plane: i.minZ, from: i.minX, to: i.maxX },
    { axis: 'z', plane: i.maxZ, from: i.minX, to: i.maxX },
  ];
  const out = [];
  const y0 = WINDOW.y - WINDOW.h / 2, y1 = WINDOW.y + WINDOW.h / 2;
  for (const wall of walls) {
    for (let along = wall.from + 4.5; along <= wall.to - 4.5; along += 6) {
      const edges = [along - WINDOW.w / 2, along, along + WINDOW.w / 2];
      if (!edges.every((e) => wallSolidAt(wall.axis, wall.plane, e, y0, y1))) continue;
      out.push({
        axis: wall.axis, plane: wall.plane, along,
        x: wall.axis === 'x' ? wall.plane : along,
        z: wall.axis === 'x' ? along : wall.plane,
        y: WINDOW.y,
      });
    }
  }
  return out;
}

/* ---- 대홀 액자 -------------------------------------------------------------
 * 대홀을 둘러싼 벽(x = ±11)의, 문 사이 빈 벽에만 건다.
 * -------------------------------------------------------------------------- */
export const ART = { w: 2.4, h: 1.7, y: 3.7 };

export function grandHallArt() {
  const out = [];
  for (const plane of [-11, 11]) {
    const side = plane < 0 ? 1 : -1;              // 대홀 안쪽을 향한다
    for (const z of [-9, 0, 9]) {
      if (!wallSolidAt('x', plane, z, ART.y - ART.h / 2, ART.y + ART.h / 2)) continue;
      out.push({ ...onWall('x', plane, z, side, 0.18), y: ART.y, side, tone: z < 0 ? 0x263e42 : 0x523b31 });
    }
  }
  return out;
}

/** 저택 현판. 대홀 북쪽 벽(z = -11)에 걸어 대홀 안쪽을 본다. */
export function estatePlaque() {
  const width = 5.4, y = 4.4, half = width / 8;
  const edges = [-width / 2, 0, width / 2];
  if (!edges.every((x) => wallSolidAt('z', -11, x, y - half, y + half))) return null;
  return { ...onWall('z', -11, 0, 1, 0.18), y, width };
}
