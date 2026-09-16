import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AssetManager } from '../public/js/assets.js';
import { ViewmodelHands } from '../public/js/viewmodel-hands.js';
import { WristRestraints, placeWrist } from '../public/js/restraints.js';
import { World } from '../public/js/world.js';
import { DOORWAYS, MAP, setActiveMap } from '../public/js/map-data.js';

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

/* 문틀이 벽과 "같은 평면에서" 끝나지 않는지 본다.
 *
 *  같은 방향을 보는 두 면이 정확히 같은 평면에 있으면 깊이 버퍼가 앞뒤를
 *  정하지 못하고, 화면에서는 문 둘레가 지글거리거나 벽이 얼룩져 보인다
 *  (z-fighting). 눈으로만 잡을 수 있는 종류의 버그라 여기서 치수로 막는다.
 *
 *  검사하는 평면은 셋이다.
 *    1) 기둥 안쪽 면  vs  벽이 끝나는 면 (±span/2)
 *    2) 상인방 아랫면  vs  문 위 벽의 아랫면 (y = doorHeight)
 *    3) 기둥 앞뒤 면  vs  상인방 앞뒤 면 (둘이 겹치는 자리)
 */
for(const mapId of ['mansion','office']) test(`${mapId}: door frames never share a plane with the wall they sit in`, () => {
  setActiveMap(mapId);
  const world=new World(null,null);world._buildDoors();
  const EPS=.004;
  for(const door of DOORWAYS) {
    const {group,leaves}=world.doorMeshes.get(door.id);
    const [left,right,head]=group.children[0].children;
    const headBottom=head.position.y-head.geometry.parameters.height/2;
    const headTop=head.position.y+head.geometry.parameters.height/2;

    // 1) 기둥 안쪽 면은 문 구멍 안으로 나와 있어야 한다.
    for(const post of [left,right]) {
      const inner=Math.abs(post.position.x)-post.geometry.parameters.width/2;
      assert.ok(inner < door.span/2-EPS,
        `${door.id}: 기둥 안쪽 면 ${inner} 이 벽 끝 ${door.span/2} 과 같은 평면이다`);
      // 기둥 윗면은 상인방 속에 묻혀 있어야 한다 (틈도, 겹치는 평면도 없게).
      const top=post.position.y+post.geometry.parameters.height/2;
      assert.ok(top > headBottom+EPS && top < headTop-EPS,
        `${door.id}: 기둥 윗면 ${top} 이 상인방(${headBottom}~${headTop}) 안에 있지 않다`);
    }

    // 2) 상인방은 벽 아랫면을 가로질러 걸친다 - 아래는 벽 밖, 위는 벽 속.
    assert.ok(headBottom < MAP.doorHeight-EPS && headTop > MAP.doorHeight+EPS,
      `${door.id}: 상인방(${headBottom}~${headTop})이 벽 아랫면 ${MAP.doorHeight} 을 가로지르지 않는다`);

    // 3) 겹치는 기둥과 상인방은 두께가 달라야 한다.
    assert.notEqual(left.geometry.parameters.depth, head.geometry.parameters.depth,
      `${door.id}: 기둥과 상인방의 앞뒤 면이 같은 평면이다`);

    // 문짝은 상인방 아래에서 끝나고, 다 합쳐도 문틀 안쪽에 들어간다.
    for(const pivot of leaves) {
      const leaf=pivot.children[0];
      assert.ok(leaf.position.y+leaf.geometry.parameters.height/2 <= headBottom+EPS,
        `${door.id}: 문짝 윗변이 상인방을 뚫는다`);
      assert.equal(pivot.rotation.y,0,'문은 닫힌 채로 지어진다');
    }
    const total=leaves.reduce((sum,pivot)=>sum+pivot.children[0].geometry.parameters.width,0);
    assert.ok(total < head.geometry.parameters.width-.18,
      `문짝 합계 ${total} 가 문틀 ${head.geometry.parameters.width} 보다 넓다`);
  }
  setActiveMap('mansion');   // 다른 검사에 켜 둔 맵을 넘기지 않는다
});
