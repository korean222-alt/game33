import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { PLAYER, NET } from '../public/js/config.js';
import { rayObstacleDistance } from '../public/js/map-data.js';
import { ShotState } from '../public/js/shot-state.js';
import { traceShot, TargetHistory } from '../public/js/shot-trace.js';
import { sightPosition } from '../public/js/viewmodel-layout.js';

// Exercise the actual browser method without importing DOM-only input initialization.
const source = readFileSync(new URL('../public/js/game.js', import.meta.url), 'utf8');
const method = source.slice(source.indexOf('  _tryShoot(now) {'), source.indexOf('\n  _tryReload()'));
const tryShoot = new Function('THREE', 'PLAYER', 'NET', 'traceShot', 'rayObstacleDistance',
  'return ({' + method + '})._tryShoot;')(THREE, PLAYER, NET, traceShot, rayObstacleDistance);

test('shot effects and ammo respond before any acknowledgement; responses do not replay effects', () => {
  const callbacks = [], effects = [];
  const game = Object.create({ _tryShoot: tryShoot });
  Object.assign(game, {
    weapons: { rifle: { rpm: 600, range: 40, damage: 26, headMul: 2, mag: 30 } },
    player: { weapon: 'rifle', pos: { x: 0, y: 0, z: 0 }, crouching: false,
      aimDirection: () => new THREE.Vector3(0, 0, -1), muzzlePosition: () => ({ x: .1, y: 1.5, z: -.5 }),
      kick() {}, addShotSpread() {}, netState: () => ({ seq: 1, x: 0, y: 0, z: 0 }) },
    matchActive: true, alive: true, _lastShotAt: -Infinity, _matchVersion: 1,
    doors: { colliders: () => [] },
    ammo: 30, reserve: 150, reloading: false, weaponName: 'rifle', shots: new ShotState(),
    hud: { setAmmo() {}, flashHit() {}, banner() {} },
    entities: { shotTargets: () => [], applyShotPredictions() {}, confirmBotHealth() {},
      effects: { shot: (...args) => effects.push(args) } },
    socket: { connected: true, timeout() { return this; }, emit(event, data, callback) { callbacks.push({ data, callback }); } },
  });
  game.shots.serverAmmo = 30;
  game._tryShoot(0);
  assert.equal(effects.length, 1);
  assert.equal(game.ammo, 29);
  assert.equal(callbacks.length, 1);
  game._tryShoot(100);
  assert.equal(effects.length, 2);
  callbacks[0].callback(null, { ok: true, shotSeq: 1, ammo: 29, hit: false });
  assert.equal(game.ammo, 28);
  assert.equal(effects.length, 2);
  callbacks[1].callback(null, { ok: false, shotSeq: 2, ammo: 29 });
  assert.equal(game.ammo, 29);
  assert.equal(game.shots.pending.length, 0);
  assert.equal(effects.length, 2);
  game.socket.connected = false;
  game._tryShoot(1000);
  assert.equal(effects.length, 2);
});

test('old shot acknowledgements cannot restore ammunition or retain rejected predictions', () => {
  const shots = new ShotState();
  shots.serverAmmo = 5;
  shots.fire({ targetId: 'bot', damage: 95 }); shots.fire();
  assert.equal(shots.ammo, 3);
  assert.equal(shots.acknowledge(1, 4), true);
  assert.equal(shots.ammo, 3);
  assert.equal(shots.acknowledge(2, 4), true);
  assert.equal(shots.pending.length, 0);
  assert.equal(shots.acknowledge(1, 5), false);
  assert.equal(shots.ammo, 4);
});

test('client and server trace choose the nearest target, headshot and cover consistently', () => {
  const targets = [{ id: 'near', x: 0, z: -4, alive: true }, { id: 'far', x: 0, z: -8, alive: true }];
  const eye = { x: 0, y: 1.63, z: 0 }, dir = { x: 0, y: 0, z: -1 };
  const clear = (_o, _d, range) => range;
  const hit = traceShot(eye, dir, 40, targets, clear);
  assert.equal(hit.targetId, 'near'); assert.equal(hit.part, 'head');
  assert.equal(traceShot(eye, dir, 40, targets, () => 2).hit, false);
  assert.equal(traceShot(eye, dir, 40, targets.map(t => ({ ...t, alive: false })), clear).hit, false);
});

test('lag compensation interpolates historical targets, clamps age and never revives dead targets', () => {
  const history = new TargetHistory(1500);
  history.record(1000, [{ id: 'bot', x: 0, z: -4, alive: true }]);
  history.record(1100, [{ id: 'bot', x: 2, z: -4, alive: true }]);
  const current = [{ id: 'bot', x: 4, z: -4, alive: true }];
  assert.equal(history.sample(1050, 1100, current)[0].x, 1);
  assert.equal(history.sample(9999, 1100, current)[0].x, 2);
  assert.equal(history.sample(0, 1100, current)[0].x, 0);
  assert.equal(history.sample(1050, 1100, [{ ...current[0], alive: false }])[0].alive, false);
});

test('ADS places the optical axis at screen center with safe rear clearance for every weapon', () => {
  for (const [length, height, scale, distance] of [[.9, .121, .9, .38], [.65, .1606, 1, .3], [1.2, .1137, .9, .48]]) {
    const anchor = { x: -length * .12, y: height + .045, z: 0 };
    const [x, y, z] = sightPosition(anchor, scale, distance);
    assert.ok(Math.abs(x + anchor.z * scale) < 1e-10);
    assert.ok(Math.abs(y + anchor.y * scale) < 1e-10);
    assert.ok(Math.abs(z - anchor.x * scale + distance) < 1e-10);
    assert.ok(z + length * scale / 2 < -.05);
  }
});
