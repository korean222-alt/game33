import * as THREE from 'three';

// A physical, open red-dot sight. Its anchor is the optical axis used for ADS.
export function createWeaponOptic(model, weapon) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true);
  const size = bounds.getSize(new THREE.Vector3());
  const anchor = new THREE.Vector3(-size.x * .12, bounds.max.y + .045, 0);
  const optic = new THREE.Group();
  optic.position.copy(anchor);
  if (weapon === 'sniper') return { optic, anchor };
  const frame = new THREE.MeshStandardMaterial({ color: 0x1d2023, roughness: .55, metalness: .65 });
  for (const x of [0, .055]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.033, .0045, 8, 32), frame);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = x;
    optic.add(ring);
  }
  const base = new THREE.Mesh(new THREE.BoxGeometry(.09, .025, .07), frame);
  base.position.set(.025, -.045, 0);
  optic.add(base);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(.0015, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff493d, toneMapped: false }));
  dot.position.x = .056;
  optic.add(dot);
  model.add(optic);
  return { optic, anchor };
}

export function disposeOptic(optic) {
  const materials = new Set();
  optic?.traverse(o => { o.geometry?.dispose(); if (o.material) materials.add(o.material); });
  for (const material of materials) material.dispose();
}
