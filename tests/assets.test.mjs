import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateBytes } from 'gltf-validator';
import { AssetManager } from '../public/js/assets.js';
import { MODELS, SETTINGS_DEFAULT } from '../public/js/config.js';
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
await assets.loadAll();

test('all ten configured models exist and have valid embedded glTF data', async () => {
  assert.equal(assets.missing.length, 0);
  for (const [key, model] of Object.entries(MODELS)) {
    const bytes = await fs.readFile(new URL('../public' + model.url, import.meta.url));
    const result = await validateBytes(new Uint8Array(bytes), { maxIssues: 100 });
    assert.equal(result.issues.numErrors, 0, key + ': ' + JSON.stringify(result.issues.messages));
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
    assert.ok(json.buffers.every(b => !b.uri), key + ' has an external buffer');
    assert.ok((json.images || []).every(i => !i.uri && Number.isInteger(i.bufferView)), key + ' has an external texture');
  }
});

test('models are centered, grounded and fitted to gameplay dimensions', () => {
  for (const [key, model] of Object.entries(MODELS)) {
    const box = new THREE.Box3().setFromObject(assets.instance(key), true);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    assert.ok(Math.abs(center.x) < .0001 && Math.abs(center.z) < .0001, key + ' center');
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
  entities.spawnBots([{ id: 'test', x: 1, z: 1 }]);
  entities.onSnapshot({ players: [], bots: [{ id: 'test', x: 1, z: 1, yaw: 0, alive: 1 }] });
  entities.update(.016, new THREE.PerspectiveCamera());
  entities.clear();
  assert.equal(released, 0);
  entities.spawnBots([{ id: 'test' }]);
  assert.equal(entities.bots.size, 1);
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
