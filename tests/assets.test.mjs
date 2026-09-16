import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { AssetManager } from '../public/js/assets.js';
import { MODELS, SETTINGS_DEFAULT } from '../public/js/config.js';

/* 역할별 캐릭터(선택)는 저장소에 넣지 않는다. 사용자가 받아 넣으면 그때만
 * 쓰이고, 없으면 기본 캐릭터로 내려간다. 필수 모델만 검사한다.
 *
 * lazy(맵 전용 소품)는 브라우저에서 미리 받지 않을 뿐 저장소에는 있다.
 * 중심·바닥·치수 검사는 똑같이 받아야 한다 - 이 검사가 사무실 화분이 3m
 * 짜리로 구워진 것을 잡아 줄 자리다. */
const REQUIRED = Object.entries(MODELS).filter(([, model]) => !model.optional);
import { LocalPlayer } from '../public/js/player.js';
import { Entities } from '../public/js/entities.js';

const assets = new AssetManager();
// These tests validate real geometry/material definitions. Image decoding and
// GPU rendering require a browser and are deliberately not claimed by this shim.
const loader = new GLTFLoader();
loader.register(() => ({ name: 'test-texture-decoding', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
assets.loader = { loadAsync: async url => {
  const bytes = await fs.readFile(new URL('../public' + url, import.meta.url));
  return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
} };
/* 두 번 부른다. 인자 없는 호출이 "선택 모델이 없으면 기본 캐릭터로" 연결을
 * 세워 주고(아래 fallback 검사가 그걸 본다), 두 번째 호출이 맵 전용 소품을
 * 마저 받는다. */
await assets.loadAll();
await assets.loadAll(Object.keys(MODELS).filter((key) => MODELS[key].lazy));

test('every configured model exists and has valid embedded glTF data', async () => {
  assert.equal(assets.missing.length, 0);
  for (const [key, model] of REQUIRED) {
    const bytes = await fs.readFile(new URL('../public' + model.url, import.meta.url));
    const result = await validateBytes(new Uint8Array(bytes), { maxIssues: 100 });
    assert.equal(result.issues.numErrors, 0, key + ': ' + JSON.stringify(result.issues.messages));
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
    assert.ok(json.buffers.every(b => !b.uri), key + ' has an external buffer');
    assert.ok((json.images || []).every(i => !i.uri && Number.isInteger(i.bufferView)), key + ' has an external texture');
  }
});

test('models are centered, grounded and fitted to gameplay dimensions', () => {
  for (const [key, model] of REQUIRED) {
    const box = new THREE.Box3().setFromObject(assets.instance(key), true);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    assert.ok(Math.abs(center.x) < .001 && Math.abs(center.z) < .001, key + ' center');
    assert.ok(Math.abs(model.fit.center ? center.y : box.min.y) < .0001, key + ' ground');
    if (model.fit.height) assert.ok(Math.abs(size.y - model.fit.height) < .0001, key + ' height');
    if (model.fit.length) assert.ok(Math.abs(size.x - model.fit.length) < .0001, key + ' length');
    if (model.fit.size) size.toArray().forEach((v, i) => assert.ok(Math.abs(v - model.fit.size[i]) < .0001, key));
  }
});

test('first-person gun preserves shared depth-tested materials and renders in its own layer', () => {
  const camera = new THREE.PerspectiveCamera(), scene = new THREE.Scene();
  const player = new LocalPlayer(camera, scene, assets, SETTINGS_DEFAULT);
  for (const key of ['rifle', 'smg', 'sniper']) {
    player.setWeapon(key);
    player.viewmodel.traverse(o => { if (o.isMesh) assert.equal(o.layers.mask, 2); });
    assets.instance(key).traverse(o => { if (o.isMesh) {
      assert.equal(o.material.depthTest, true);
      assert.equal(o.layers.mask, 1);
    } });
  }
});

test('avatar restart does not dispose cached geometry or textures', () => {
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ strokeText() {}, fillText() {} }) }) };
  let released = 0;
  assets.cache.get('character').scene.traverse(o => {
    o.geometry?.addEventListener('dispose', () => released++);
    o.material?.map?.addEventListener('dispose', () => released++);
  });
  const entities = new Entities(new THREE.Scene(), assets);
  entities.spawnNpcs([{ id: 'test', kind: 'suspect', x: 1, z: 1 }]);
  entities.onSnapshot({ players: [], npcs: [{ id: 'test', x: 1, y: 0, z: 1, yaw: 0, alive: 1 }] });
  entities.update(.016, new THREE.PerspectiveCamera());
  entities.clear();
  assert.equal(released, 0);
  entities.spawnNpcs([{ id: 'test', kind: 'suspect' }]);
  assert.equal(entities.npcs.size, 1);
  entities.clear();
});

test('partial joystick movement stays slower than full movement and respawn resets ADS', () => {
  const move = amount => {
    const player = new LocalPlayer(new THREE.PerspectiveCamera(), new THREE.Scene(), assets, SETTINGS_DEFAULT);
    player.spawn(-3.4, 4.6, 0);
    player.update(.05, { move: { x: 0, y: amount }, consumeJump: () => false });
    return player;
  };
  const slow = move(.2), fast = move(1);
  assert.ok(Math.abs(slow.vel.z) < Math.abs(fast.vel.z) * .3);
  fast.adsAmount = 1; fast.muzzleUntil = Infinity; fast.spawn(-3.4, 4.6, 0);
  assert.equal(fast.adsAmount, 0); assert.equal(fast.muzzleUntil, 0);
});

test('snapshot recovers a missing NPC and predicted lethal damage does not hide a live shooter', () => {
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ strokeText() {}, fillText() {} }) }) };
  const entities = new Entities(new THREE.Scene(), assets);
  entities.onSnapshot({ players: [], npcs: [{
    id: 'late', kind: 'suspect', x: 1, y: 0, z: 1, yaw: 0, hp: 100, alive: 1,
  }] });
  assert.equal(entities.npcs.size, 1);
  entities.applyShotPredictions([{ prediction: { targetId: 'late', damage: 120 } }]);
  entities.update(.016, new THREE.PerspectiveCamera());
  const avatar = entities.npcs.get('late');
  assert.equal(avatar.group.visible, true);
  assert.notEqual(avatar.rig.dead, true);
  entities.clear();
});

test('역할별 캐릭터 모델은 없으면 기본 캐릭터로 내려간다', () => {
  for (const key of ['characterOfficer', 'characterSuspect', 'characterHostage']) {
    assert.ok(MODELS[key]?.optional, `${key} 는 선택 모델이어야 한다`);
    // 파일을 안 넣었으므로 기본 캐릭터로 연결되고, 동작도 그대로 따라온다.
    assert.equal(assets.resolve(key), 'character');
    assert.equal(assets.hasOwnModel(key), false);
    assert.ok(assets.animations(key).length > 0, '동작은 기본 캐릭터 것을 쓴다');
    assert.ok(assets.instance(key, { skinned: true }), '인스턴스를 만들 수 있다');
  }
  assert.deepEqual(assets.missing, [], '선택 모델이 없다고 경고하지 않는다');
});
