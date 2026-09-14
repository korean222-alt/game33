// Each vertical interval owns its visible wall surface; no coplanar overlays.
const BANDS = [
  [0, 1.2, 'plaster'],
  [1.2, 1.255, 'brass'],
  [1.255, 6.35, 'wall'],
  [6.35, 6.68, 'plaster'],
  [6.68, 6.72, 'brass'],
  [6.72, Infinity, 'wall'],
];

export function wallSections(height) {
  return BANDS.flatMap(([bottom, top, material]) => {
    top = Math.min(top, height);
    return top > bottom ? [{ bottom, top, material }] : [];
  });
}
