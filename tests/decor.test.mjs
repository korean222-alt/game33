import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP, ROOMS, CORRIDORS, WALLS } from '../public/js/map-data.js';
import {
  wallSolidAt, roomSigns, roomRugs, exteriorWindows, grandHallArt, estatePlaque, WINDOW, ART,
} from '../public/js/decor-layout.js';

/*
 * 저택을 두 배로 넓혔을 때 벽은 옮겨 갔는데 visuals.js 의 장식 좌표는 그대로여서,
 * 유리창 한 장이 북쪽 복도 한가운데 공중에 떠 있었다. 화면에서 "복도에 이상한 게
 * 튀어나와" 보이던 것이 그것이다. 여기서 막는다.
 */

/** 벽 살을 가로지르는 선분이 걸치는 자유 공간(방·복도)의 깊이. */
function intrusion(axis, plane, along, halfDepth) {
  const spaces = [...ROOMS, ...CORRIDORS];
  let worst = 0;
  for (const s of spaces) {
    const other = axis === 'x' ? 'z' : 'x';
    if (Math.abs(along - s[other]) > (other === 'x' ? s.w : s.d) / 2) continue;
    const half = (axis === 'x' ? s.w : s.d) / 2;
    const lo = s[axis] - half, hi = s[axis] + half;
    const overlap = Math.min(plane + halfDepth, hi) - Math.max(plane - halfDepth, lo);
    if (overlap > worst) worst = overlap;
  }
  return worst;
}

test('방 이름표는 모두 진짜 벽면에 붙어 있고, 그 방으로 드나드는 복도 쪽을 본다', () => {
  const signs = roomSigns();
  // 복도에서 열리는 방은 전부 이름표가 있어야 한다. 하나라도 빠지면 예전처럼
  // 허공에 붙어 있다가 조용히 사라진 것이다.
  assert.equal(signs.length, ROOMS.length, signs.map((s) => s.name).join(', '));

  for (const s of signs) {
    const axis = Math.abs(Math.sin(s.ry)) > 0.5 ? 'x' : 'z';
    const plane = axis === 'x' ? s.x : s.z;
    const along = axis === 'x' ? s.z : s.x;
    // 이름표 바로 뒤(벽 두께 안쪽)에 벽 살이 있어야 한다.
    const backs = [-1, 1].some((dir) => wallSolidAt(axis, plane + dir * 0.2, along, s.y - s.width / 8, s.y + s.width / 8));
    assert.ok(backs, `${s.name} 이름표가 허공에 떠 있다 (${s.x}, ${s.y}, ${s.z})`);
    // 문 위, 천장 아래.
    assert.ok(s.y > MAP.doorHeight && s.y + s.width / 8 < MAP.height, s.name);
  }

  const names = new Set(signs.map((s) => s.name));
  for (const r of ROOMS) assert.ok(names.has(r.name), `${r.name} 이름표 없음`);
});

test('외벽 창문은 바깥벽 안에 끼워지고 방이나 복도로 튀어나오지 않는다', () => {
  const windows = exteriorWindows();
  assert.ok(windows.length > 12, String(windows.length));
  const y0 = WINDOW.y - WINDOW.h / 2, y1 = WINDOW.y + WINDOW.h / 2;
  for (const w of windows) {
    for (const edge of [-WINDOW.w / 2, 0, WINDOW.w / 2]) {
      assert.ok(wallSolidAt(w.axis, w.plane, w.along + edge, y0, y1),
        `창문이 벽 없는 자리에 있다 (${w.x}, ${w.z})`);
    }
    // 벽(두께 0.4)보다 4cm 두꺼우니 2cm 만 도드라져야 한다.
    const poke = intrusion(w.axis, w.plane, w.along, WINDOW.depth / 2);
    assert.ok(poke <= 0.03, `창문이 ${poke.toFixed(2)}m 튀어나왔다 (${w.x}, ${w.z})`);
    // 바깥벽에만. 실내 칸막이에 끼면 복도 한가운데 유리가 선다.
    const i = MAP.interior;
    assert.ok([i.minX, i.maxX, i.minZ, i.maxZ].includes(w.plane), String(w.plane));
  }
});

test('액자와 현판은 문 구멍이 아닌 벽 살에 걸린다', () => {
  for (const a of grandHallArt()) {
    assert.ok(wallSolidAt('x', a.x - a.side * 0.18, a.z, a.y - ART.h / 2, a.y + ART.h / 2),
      `액자가 허공에 있다 (${a.x}, ${a.z})`);
  }
  const p = estatePlaque();
  assert.ok(p, '현판이 걸릴 벽을 찾지 못했다');
  assert.ok(wallSolidAt('z', -11, 0, p.y - p.width / 8, p.y + p.width / 8));
});

test('양탄자는 자기 방 안에 들어간다 (예전 현관홀 양탄자는 앞마당까지 나갔다)', () => {
  for (const rug of roomRugs()) {
    const room = ROOMS.find((r) => r.name === rug.name);
    assert.ok(rug.w <= room.w - 1, `${rug.name} 양탄자 폭 ${rug.w} > 방 ${room.w}`);
    assert.ok(rug.d <= room.d - 1, `${rug.name} 양탄자 길이 ${rug.d} > 방 ${room.d}`);
    const i = MAP.interior;
    assert.ok(rug.x - rug.w / 2 > i.minX && rug.x + rug.w / 2 < i.maxX, rug.name);
    assert.ok(rug.z - rug.d / 2 > i.minZ && rug.z + rug.d / 2 < i.maxZ, rug.name);
  }
});

test('wallSolidAt 은 문 구멍을 벽으로 세지 않는다', () => {
  // 북쪽 복도의 CELLAR 문(z = -15, x = -29, 폭 1.8)은 바닥부터 문 높이까지 비어 있다.
  assert.equal(wallSolidAt('z', -15, -29, 1, 1.8), false);
  // 그 문 위 상인방은 차 있다.
  assert.equal(wallSolidAt('z', -15, -29, MAP.doorHeight + 0.3, MAP.doorHeight + 0.9), true);
  // 문 옆의 벽은 바닥부터 차 있다.
  assert.equal(wallSolidAt('z', -15, -26, 1, 1.8), true);
  // 벽이 아예 없는 평면.
  assert.equal(wallSolidAt('z', -4, 0, 1, 2), false);
  assert.ok(WALLS.length > 0);
});
