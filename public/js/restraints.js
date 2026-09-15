import * as THREE from 'three';

// Visible restraints are placed from animated wrists, in avatar space. They never
// inherit the imported skeleton's scale or use a fixed torso-height attachment.
export class WristRestraints {
  constructor(parent, rig) {
    this.parent = parent;
    this.rig = rig;
    this.group = new THREE.Group();
    this.group.name = 'wrist-restraints';
    this.group.visible = false;
    parent.add(this.group);
    this.material = new THREE.MeshStandardMaterial({ color: 0xb7bec5, metalness: .85, roughness: .28 });
    this.ringGeometry = new THREE.TorusGeometry(.065, .012, 8, 20);
    this.rings = [0, 1].map(() => {
      const mesh = new THREE.Mesh(this.ringGeometry, this.material);
      this.group.add(mesh); return mesh;
    });
    this.linkGeometry = new THREE.TorusGeometry(.018, .005, 6, 10);
    this.links = Array.from({ length: 7 }, () => {
      const mesh = new THREE.Mesh(this.linkGeometry, this.material);
      this.group.add(mesh); return mesh;
    });
  }
  update(cuffed) {
    const { leftHand, rightHand, leftForeArm, rightForeArm } = this.rig.bones;
    this.group.visible = !!cuffed && !!leftHand && !!rightHand;
    if (!this.group.visible) return;
    this.parent.updateWorldMatrix(true, false);
    [[leftHand, leftForeArm], [rightHand, rightForeArm]].forEach(([hand, arm], i) => {
      const wrist = hand.getWorldPosition(new THREE.Vector3());
      const direction = arm ? wrist.clone().sub(arm.getWorldPosition(new THREE.Vector3())).normalize() : new THREE.Vector3(0, 1, 0);
      wrist.addScaledVector(direction, -.015);
      this.rings[i].position.copy(this.parent.worldToLocal(wrist));
      direction.transformDirection(this.parent.matrixWorld.clone().invert());
      this.rings[i].quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    });
    const a = this.rings[0].position, b = this.rings[1].position;
    this.links.forEach((link, i) => {
      // Hide the chain while the hands are still moving into the cuffed pose.
      link.visible = a.distanceTo(b) < .4;
      link.position.copy(a).lerp(b, (i + 1) / (this.links.length + 1));
      link.rotation.set(i % 2 ? Math.PI / 2 : 0, 0, 0);
    });
  }
  dispose() {
    this.group.removeFromParent();
    this.ringGeometry.dispose(); this.linkGeometry.dispose(); this.material.dispose();
  }
}

// Two-bone IK for the cuffed pose. Input targets use the avatar's metre scale.
export function placeWrist(upper, forearm, hand, target, amount = 1) {
  if (!upper || !forearm || !hand) return;
  const a = upper.getWorldPosition(new THREE.Vector3());
  const b = forearm.getWorldPosition(new THREE.Vector3());
  const c = hand.getWorldPosition(new THREE.Vector3());
  const goal = c.clone().lerp(target, amount);
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  if (l1 < 1e-6 || l2 < 1e-6) return;
  const direction = goal.clone().sub(a).normalize();
  const distance = THREE.MathUtils.clamp(a.distanceTo(goal), Math.abs(l1 - l2) + .0001, l1 + l2 - .0001);
  const along = (l1*l1 + distance*distance - l2*l2) / (2*distance);
  const pole = new THREE.Vector3(0, -1, 0).addScaledVector(direction, direction.y);
  if (pole.lengthSq() < 1e-6) pole.set(0, 0, 1).addScaledVector(direction, -direction.z);
  pole.normalize();
  const elbow = a.clone().addScaledVector(direction, along).addScaledVector(pole, Math.sqrt(Math.max(0, l1*l1 - along*along)));
  const point = (joint, child, at) => {
    const origin = joint.getWorldPosition(new THREE.Vector3());
    const from = child.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
    const to = at.clone().sub(origin).normalize();
    const world = new THREE.Quaternion().setFromUnitVectors(from, to).multiply(joint.getWorldQuaternion(new THREE.Quaternion()));
    joint.quaternion.copy(joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
    joint.updateMatrixWorld(true);
  };
  point(upper, forearm, elbow);
  point(forearm, hand, a.clone().addScaledVector(direction, distance));
}
