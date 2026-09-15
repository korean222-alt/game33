import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AssetManager } from '../public/js/assets.js';
import { ViewmodelHands } from '../public/js/viewmodel-hands.js';
import { WristRestraints, placeWrist } from '../public/js/restraints.js';
import { World } from '../public/js/world.js';

for (const key of ['rifle','smg','sniper']) test(`${key}: detached magazine moves independently and resets without changing shared assets`, async () => {
  const assets = new AssetManager(), loader = new GLTFLoader();
  loader.register(() => ({name:'no-textures',loadTexture:()=>Promise.resolve(new THREE.Texture())}));
  assets.loader={loadAsync:async url=>{const b=await fs.readFile(new URL('../public'+url,import.meta.url));return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');}};
  await assets.load(key); assert.equal(assets.missing.length,0);
  const weapon=assets.instance(key), shared=assets.instance(key);
  const count=root=>{let n=0;root.traverse(o=>{if(o.isMesh)n+=o.geometry.index?.count||0;});return n;};
  const before=count(shared);
  const hands=new ViewmodelHands(weapon,key);
  assert.ok(hands.magazine.children.length>0,'magazine not detached');
  assert.equal(count(shared),before);
  hands.update(.35);
  assert.ok(hands.magazine.position.y<-.1);
  assert.equal(weapon.position.y,0);
  assert.ok(hands.hands[1].hand.position.distanceTo(new THREE.Vector3(...hands.spec.support))>.1);
  hands.update(0);
  assert.deepEqual(hands.magazine.position.toArray(),[-0,-0,0]);
  assert.equal(hands.magazine.visible,true);
  hands.dispose();
});

test('wrist constraints follow animated hands after avatar rotation, translation, and scale', () => {
  const avatar=new THREE.Group(); avatar.position.set(3,0,4);avatar.rotation.y=.8;
  const upper=new THREE.Bone(),forearm=new THREE.Bone(),hand=new THREE.Bone();
  upper.position.set(.2,1.2,0);forearm.position.y=-.3;hand.position.y=-.3;
  upper.add(forearm);forearm.add(hand);avatar.add(upper);avatar.updateMatrixWorld(true);
  const target=avatar.localToWorld(new THREE.Vector3(.085,.9,-.34));
  placeWrist(upper,forearm,hand,target);
  assert.ok(hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)<.001);
  const other=new THREE.Bone();other.position.set(-.085,.9,-.34);avatar.add(other);
  const cuffs=new WristRestraints(avatar,{bones:{leftHand:hand,rightHand:other,leftForeArm:forearm}});
  cuffs.update(true);assert.equal(cuffs.group.visible,true);
  for(const [i,bone] of [[0,hand],[1,other]]) {
    assert.ok(cuffs.rings[i].getWorldPosition(new THREE.Vector3()).distanceTo(bone.getWorldPosition(new THREE.Vector3()))<.02);
  }
  cuffs.update(false);assert.equal(cuffs.group.visible,false);cuffs.dispose();
});

test('door frame uprights and header meet without overlapping front faces', () => {
  const world=new World(null,null);world._buildDoors();
  for(const {group,pivot} of world.doorMeshes.values()) {
    const [left,right,head]=group.children[0].children;
    assert.equal(left.position.y+left.geometry.parameters.height/2, head.position.y-head.geometry.parameters.height/2);
    assert.equal(right.position.y+right.geometry.parameters.height/2, head.position.y-head.geometry.parameters.height/2);
    assert.ok(pivot.children[0].geometry.parameters.width < head.geometry.parameters.width-.18);
  }
});
