/* 총을 든 자세와 장구류 검증.
 *
 * 플레이어가 "총을 이상하게 들고 있다"고 본 것은 두 가지 때문이었다.
 *   1) 총구 축 하나만 손 방향에 맞추고 굴림(roll)을 두지 않아 총이 옆으로 눕는다.
 *   2) 소총을 들지 않은 동작(달리기/앉기/사망)에서는 두 손이 총을 잡은 모양이
 *      아닌데도 그 방향을 그대로 써서 총구가 엉뚱한 데를 본다.
 * 아래 테스트는 두 경우 모두 총이 바로 서 있고 손에 붙어 있는지 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AssetManager } from '../public/js/assets.js';
import { CharacterRig } from '../public/js/character-animation.js';
import { Entities } from '../public/js/entities.js';

globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({ strokeText() {}, fillText() {} }) }),
};

const assets = new AssetManager();
const loader = new GLTFLoader();
loader.register(() => ({ name: 'test-texture-decoding', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
assets.loader = {
  loadAsync: async (url) => {
    const bytes = await fs.readFile(new URL('../public' + url, import.meta.url));
    return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  },
};
await assets.loadAll();

/** 손 뼈 두 개만 있는 최소 뼈대. 손 위치를 마음대로 놓고 시험한다. */
function fakeRig(rightAt, leftAt) {
  const root = new THREE.Object3D();
  const right = new THREE.Object3D(); right.name = 'mixamorigRightHand';
  const left = new THREE.Object3D(); left.name = 'mixamorigLeftHand';
  right.position.copy(rightAt);
  left.position.copy(leftAt);
  root.add(right, left);
  root.updateMatrixWorld(true);
  const group = new THREE.Group();
  group.add(root);
  group.updateMatrixWorld(true);
  return { rig: new CharacterRig(root, []), group };
}

const axis = (weapon, i) => new THREE.Vector3()
  .setFromMatrixColumn(new THREE.Matrix4().makeRotationFromQuaternion(weapon.quaternion), i);

test('두 손으로 총을 잡은 자세에서 총구는 손 방향, 총 윗면은 위를 향한다', () => {
  // 몸 앞(-Z)으로 총을 겨눈 자세: 오른손이 뒤, 왼손이 총열 앞쪽.
  const { rig, group } = fakeRig(
    new THREE.Vector3(0.12, 1.35, -0.18),
    new THREE.Vector3(0.02, 1.36, -0.52),
  );
  const weapon = new THREE.Object3D();
  group.add(weapon);
  assert.equal(rig.alignWeapon(weapon, group, 0.11), true);

  const muzzle = axis(weapon, 0);
  const expected = new THREE.Vector3(-0.1, 0.01, -0.34).normalize();
  assert.ok(muzzle.dot(expected) > 0.99, `총구가 손 방향과 어긋남: ${muzzle.toArray()}`);
  // 굴림이 잡혀 있어야 한다. 총 윗면(+Y)이 아래를 보면 뒤집힌 것이다.
  assert.ok(axis(weapon, 1).y > 0.9, '총이 옆으로 눕거나 뒤집혔다');
  // 손에서 총구 쪽으로 gripOffset 만큼만 떨어져 있어야 한다.
  assert.ok(weapon.position.distanceTo(new THREE.Vector3(0.12, 1.35, -0.18)) < 0.2);
});

test('총을 잡지 않은 자세에서는 몸 기준으로 총을 내려 든다', () => {
  // 달리기 동작: 두 팔이 몸 양옆으로 크게 벌어져 있다.
  const { rig, group } = fakeRig(
    new THREE.Vector3(0.34, 0.95, 0.22),
    new THREE.Vector3(-0.36, 1.10, -0.30),
  );
  const weapon = new THREE.Object3D();
  group.add(weapon);
  rig.alignWeapon(weapon, group, 0.11);

  const muzzle = axis(weapon, 0);
  assert.ok(muzzle.z < -0.7, `총구가 정면을 보지 않는다: ${muzzle.toArray()}`);
  assert.ok(muzzle.y < 0 && muzzle.y > -0.6, '내린 총이 바닥이나 하늘을 겨눈다');
  assert.ok(axis(weapon, 1).y > 0.8, '총이 뒤집혔다');
  // 손을 벗어나면 안 된다.
  assert.ok(weapon.position.distanceTo(new THREE.Vector3(0.34, 0.95, 0.22)) < 0.25);
});

test('손 뼈가 없는 대체 모델도 총을 가슴 높이로 든다', () => {
  const root = new THREE.Object3D();
  const group = new THREE.Group();
  group.add(root);
  group.updateMatrixWorld(true);
  const rig = new CharacterRig(root, []);
  const weapon = new THREE.Object3D();
  group.add(weapon);
  assert.equal(rig.alignWeapon(weapon, group, 0.11), true);
  assert.ok(weapon.position.y > 0.9 && weapon.position.y < 1.6,
    `총이 발밑이나 머리 위에 있다: ${weapon.position.y}`);
});

test('실제 캐릭터 모델에서 총이 손에 붙고 장구류가 몸에 맞는 크기로 달린다', () => {
  const entities = new Entities(new THREE.Scene(), assets);
  entities.spawnNpcs([{ id: 's1', kind: 'suspect', x: 0, y: 0, z: 0, yaw: 0, hp: 100 }]);
  entities.onSnapshot({ players: [], npcs: [{ id: 's1', x: 0, y: 0, z: 0, yaw: 0, hp: 100, alive: 1 }] });
  entities.update(0.016, new THREE.PerspectiveCamera());

  const avatar = entities.npcs.get('s1');
  avatar.group.updateMatrixWorld(true);

  // 장구류: 방탄조끼 + 탄창 2 + 어깨 표식 2
  assert.ok(avatar.gear.length >= 5, `장구류가 붙지 않았다: ${avatar.gear.length}`);
  for (const piece of avatar.gear) {
    assert.ok(piece.parent?.isBone, '장구류가 뼈에 붙어 있지 않다');
    const size = new THREE.Box3().setFromObject(piece).getSize(new THREE.Vector3());
    // 모델 정규화 배율을 되돌리지 못하면 여기서 수천 배로 커지거나 사라진다.
    assert.ok(size.length() > 0.05 && size.length() < 1.2, `장구류 크기 이상: ${size.toArray()}`);
  }

  const hand = avatar.rig.bones.rightHand;
  assert.ok(hand, '오른손 뼈를 찾지 못했다');
  const handWorld = hand.getWorldPosition(new THREE.Vector3());
  const gunWorld = avatar.weapon.getWorldPosition(new THREE.Vector3());
  assert.ok(gunWorld.distanceTo(handWorld) < 0.45, `총이 손에서 떨어져 있다: ${gunWorld.distanceTo(handWorld)}`);
  assert.ok(gunWorld.y > 0.7, '총이 발밑에 놓였다');

  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(avatar.weapon.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(up.y > 0.5, `총이 옆으로 눕거나 뒤집혔다: ${up.toArray()}`);
  entities.clear();
});


test('체포된 실제 캐릭터의 수갑은 웅크린 손목을 따라간다', () => {
  const entities = new Entities(new THREE.Scene(), assets);
  entities.spawnNpcs([{ id:'cuff-test',kind:'suspect',x:3,y:0,z:4,yaw:1,hp:100 }]);
  const avatar=entities.npcs.get('cuff-test');
  avatar.group.position.set(3,0,4);avatar.group.rotation.y=1;
  for(let i=0;i<60;i++) avatar.rig.update(1/60,{crouch:true,hands:true,cuffed:true});
  avatar.restraints.update(true);
  assert.equal(avatar.restraints.group.visible,true);
  for(const [index,bone] of [[0,avatar.rig.bones.leftHand],[1,avatar.rig.bones.rightHand]]) {
    const wrist=bone.getWorldPosition(new THREE.Vector3());
    const cuff=avatar.restraints.rings[index].getWorldPosition(new THREE.Vector3());
    assert.ok(wrist.distanceTo(cuff)<.03,'수갑이 손목에서 벗어났다');
  }
  const hands=avatar.rig.bones;
  assert.ok(hands.leftHand.getWorldPosition(new THREE.Vector3()).distanceTo(hands.rightHand.getWorldPosition(new THREE.Vector3()))<.45,'수갑 자세에서 두 손을 모으지 않았다');
  entities.clear();
});
