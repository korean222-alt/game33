/* Each vertical interval owns its visible wall surface; no coplanar overlays.
 *
 * 띠는 맵마다 다르다. 저택은 허리 높이 징두리 + 놋쇠 몰딩 + 벽돌이고, 사무실은
 * 걸레받이 + 도장면 + 천장 몰딩이다. 저택의 띠를 3.6m 사무실 벽에 쓰면 벽돌이
 * 천장까지 올라온다. 기본값은 저택 것을 그대로 둔다 - 부르는 쪽을 안 고친다. */
const BANDS = [
  [0, 1.2, 'plaster'],
  [1.2, 1.255, 'brass'],
  [1.255, 6.35, 'wall'],
  [6.35, 6.68, 'plaster'],
  [6.68, 6.72, 'brass'],
  [6.72, Infinity, 'wall'],
];

/** 사무실. 낮은 층고(3.6m)에 맞춘 도장 벽. */
export const OFFICE_BANDS = [
  [0, 0.11, 'brass'],        // 걸레받이 (알루미늄 몰딩)
  [0.11, 2.62, 'plaster'],   // 도장면
  [2.62, 2.68, 'brass'],     // 천장 몰딩
  [2.68, Infinity, 'plaster'],
];

export function wallSections(height, bands = BANDS) {
  return bands.flatMap(([bottom, top, material]) => {
    top = Math.min(top, height);
    return top > bottom ? [{ bottom, top, material }] : [];
  });
}
