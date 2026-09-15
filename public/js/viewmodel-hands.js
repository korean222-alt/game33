import * as THREE from 'three';

// Bounds in the normalized weapon's metre coordinates. Imported weapons weld
// their magazine into the mesh, so split triangles on this instance only.
const MAGAZINES = {
  rifle: { minX: -.075, maxX: .02, top: -.02, grip: [-.17, -.06, .01], support: [.18, -.01, -.025] },
  smg: { minX: .10, maxX: .195, top: .045, grip: [-.035, .015, .01], support: [.23, .04, -.025] },
  sniper: { minX: -.225, maxX: -.138, top: -.025, grip: [-.28, -.035, .01], support: [.02, -.03, -.025] },
};
const smooth = t => { t = THREE.MathUtils.clamp(t, 0, 1); return t*t*(3-2*t); };

export class ViewmodelHands {
  constructor(weapon, key) {
    this.weapon = weapon;
    this.spec = MAGAZINES[key] || MAGAZINES.rifle;
    this.owned = [];
    this.magazine = new THREE.Group(); this.magazine.name = 'reload-magazine';
    weapon.updateMatrixWorld(true);
    const inverse = weapon.matrixWorld.clone().invert();
    const meshes = []; weapon.traverse(o => { if (o.isMesh && !o.isSkinnedMesh) meshes.push(o); });
    for (const mesh of meshes) {
      const source = mesh.geometry;
      if (!source.index) continue;
      const matrix = inverse.clone().multiply(mesh.matrixWorld);
      const position = source.attributes.position;
      const points = Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
      const moved = [], kept = [], indices = source.index.array;
      for (let i = 0; i < indices.length; i += 3) {
        const triangle = [indices[i], indices[i+1], indices[i+2]];
        const inside = triangle.every(index => {
          const v = points[index];
          return v.x >= this.spec.minX && v.x <= this.spec.maxX && v.y <= this.spec.top;
        });
        (inside ? moved : kept).push(...triangle);
      }
      if (!moved.length) continue;
      mesh.geometry = source.clone(); mesh.geometry.setIndex(kept);
      const detached = source.clone(); detached.setIndex(moved);
      this.owned.push(mesh.geometry, detached);
      const part = new THREE.Mesh(detached, mesh.material);
      matrix.decompose(part.position, part.quaternion, part.scale);
      part.name = 'detached-magazine-part';
      this.magazine.add(part);
    }
    weapon.add(this.magazine);
    this.magazineCenter = new THREE.Vector3((this.spec.minX + this.spec.maxX) / 2, this.spec.top - .04, 0);
    this.material = new THREE.MeshStandardMaterial({ color: 0x252b2b, roughness: .88 });
    this.palmGeometry = new THREE.BoxGeometry(.075, .035, .065);
    this.fingerGeometry = new THREE.CapsuleGeometry(.009, .038, 3, 6);
    this.armGeometry = new THREE.CylinderGeometry(.036, .045, 1, 8);
    this.hands = [0, 1].map(() => {
      const hand = new THREE.Group();
      hand.name = 'viewmodel-hand';
      hand.add(new THREE.Mesh(this.palmGeometry, this.material));
      for (let i=0; i<4; i++) {
        const finger = new THREE.Mesh(this.fingerGeometry, this.material);
        finger.position.set(.012 + (i-1.5)*.016, .02, -.02);
        finger.rotation.x = .65; hand.add(finger);
      }
      const arm = new THREE.Mesh(this.armGeometry, this.material);
      weapon.add(hand, arm); return { hand, arm };
    });
    this.update(0);
  }
  update(t) {
    const active = t > 0 && t < 1;
    const reach = active ? smooth(t/.16) * (1-smooth((t-.80)/.20)) : 0;
    let drop = 0;
    if (active && t >= .16 && t < .52) drop = smooth((t-.16)/.22);
    else if (active && t >= .52 && t < .80) drop = 1-smooth((t-.52)/.28);
    this.magazine.position.set(-.035*drop, -.26*drop, .025*drop);
    this.magazine.visible = !(t > .41 && t < .52);
    this.hands.forEach(({ hand, arm }, i) => {
      hand.position.fromArray(i === 0 ? this.spec.grip : this.spec.support);
      if (i === 1) {
        const target = this.magazineCenter.clone().add(this.magazine.position);
        target.z -= .025;
        hand.position.lerp(target, reach);
        hand.rotation.x = -.5 * reach;
      }
      const elbow = hand.position.clone().add(new THREE.Vector3(-.20, -.15, i === 0 ? .08 : -.08));
      const delta = elbow.clone().sub(hand.position);
      arm.position.copy(hand.position).lerp(elbow, .5);
      arm.scale.y = delta.length();
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), delta.normalize());
    });
  }
  dispose() {
    for (const geometry of this.owned) geometry.dispose();
    this.palmGeometry.dispose(); this.fingerGeometry.dispose(); this.armGeometry.dispose(); this.material.dispose();
  }
}
