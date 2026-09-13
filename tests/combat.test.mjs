import test from 'node:test';
import assert from 'node:assert/strict';
import { rayObstacleDistance, SPAWNS, BOMB_SITES, resolveCircle, COLLIDERS } from '../public/js/map-data.js';

test('3D bullet trace hits low cover while an elevated horizontal shot passes above it', () => {
  const cover = [{ x: 0, z: -2, w: 1, d: 1, h: .75 }];
  assert.equal(rayObstacleDistance({ x: 0, y: .5, z: 0 }, { x: 0, y: 0, z: -1 }, 20, cover), 1.5);
  assert.equal(rayObstacleDistance({ x: 0, y: 1.62, z: 0 }, { x: 0, y: 0, z: -1 }, 20, cover), 20);
});
test('vertical and diagonal rays stop on floor or wall', () => {
  assert.equal(rayObstacleDistance({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, 20, []), 2);
  const wall = [{ x: 3, z: 0, w: 1, d: 2, h: 3.2 }];
  assert.equal(rayObstacleDistance({ x: 0, y: 1.5, z: 0 }, { x: 1, y: 0, z: 0 }, 20, wall), 2.5);
});
test('spawns are clear and objectives are not buried in props', () => {
  for (const p of SPAWNS) assert.deepEqual(resolveCircle(p.x, p.z, .35), { x: p.x, z: p.z });
  for (const site of BOMB_SITES) assert.ok(!COLLIDERS.some(c => Math.abs(c.x - site.x) < c.w / 2 && Math.abs(c.z - site.z) < c.d / 2), site.id);
});
