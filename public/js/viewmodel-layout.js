// Weapons point along local +X. The viewmodel's Y rotation maps that to camera -Z.
export function sightPosition(anchor, scale, eyeDistance) {
  return [-anchor.z * scale, -anchor.y * scale, -eyeDistance + anchor.x * scale];
}
