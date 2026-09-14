import test from 'node:test';
import assert from 'node:assert/strict';
import { WALLS } from '../public/js/map-data.js';
import { wallSections } from '../public/js/wall-sections.js';

test('every wall height is covered exactly once, without overlapping decorative surfaces', () => {
  for (const height of [...WALLS.map(w => w.h), .5, 1.22, 6.5, 9]) {
    const sections = wallSections(height);
    assert.equal(sections[0].bottom, 0);
    assert.equal(sections.at(-1).top, height);
    for (let i = 0; i < sections.length; i++) {
      assert.ok(sections[i].top > sections[i].bottom);
      if (i) assert.equal(sections[i - 1].top, sections[i].bottom);
    }
  }
});
test('lower plaster, brass trim and upper brick own separate visible intervals', () => {
  const sections = wallSections(7);
  const materialAt = y => sections.filter(s => s.bottom <= y && y < s.top).map(s => s.material);
  assert.deepEqual(materialAt(.6), ['plaster']);
  assert.deepEqual(materialAt(1.22), ['brass']);
  assert.deepEqual(materialAt(3), ['wall']);
  assert.deepEqual(materialAt(6.5), ['plaster']);
  assert.deepEqual(materialAt(6.7), ['brass']);
  assert.deepEqual(wallSections(0), []);
});
