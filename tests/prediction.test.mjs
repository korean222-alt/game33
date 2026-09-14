import test from 'node:test';
import assert from 'node:assert/strict';
import { PredictionHistory } from '../public/js/prediction-history.js';

test('delayed acknowledgements preserve movement beyond the old 15-packet window', () => {
  const history = new PredictionHistory();
  const first = history.record({ x: 0, y: 0, z: 0 });
  for (let i = 1; i <= 40; i++) history.record({ x: i * .3, y: 0, z: 0 });
  assert.deepEqual(history.acknowledge(first.seq, first), { x: 0, y: 0, z: 0 });
});
test('collision correction uses the acknowledged input, not the latest position', () => {
  const history = new PredictionHistory();
  const first = history.record({ x: 2, y: 1, z: 3 });
  const second = history.record({ x: 3, y: 1.5, z: 4 });
  assert.deepEqual(history.acknowledge(first.seq, { x: 1, y: .5, z: 3 }),
    { x: -1, y: -.5, z: 0 });
  assert.deepEqual(history.acknowledge(second.seq, { x: 2, y: 1, z: 4 }),
    { x: 0, y: 0, z: 0 });
});
test('duplicate, out-of-order, invalid and future acknowledgements do not move the player', () => {
  const history = new PredictionHistory();
  const first = history.record({ x: 1, y: 0, z: 2 });
  const second = history.record({ x: 2, y: 0, z: 2 });
  assert.equal(history.acknowledge(99, first), null);
  assert.equal(history.acknowledge(second.seq, { x: NaN, y: 0, z: 2 }), null);
  assert.deepEqual(history.acknowledge(second.seq, second), { x: 0, y: 0, z: 0 });
  assert.equal(history.acknowledge(second.seq, first), null);
  assert.equal(history.acknowledge(first.seq, first), null);
  assert.equal(history.acknowledge(undefined, first), null);
});
test('history expiration and missing acknowledgements never cause a snap', () => {
  const history = new PredictionHistory(2);
  const first = history.record({ x: 0, y: 0, z: 0 });
  history.record({ x: 1, y: 0, z: 0 });
  const latest = history.record({ x: 2, y: 0, z: 0 });
  assert.equal(history.pending.length, 2);
  assert.equal(history.acknowledge(first.seq, { x: -20, y: 0, z: 0 }), null);
  assert.deepEqual(history.acknowledge(latest.seq, latest), { x: 0, y: 0, z: 0 });
});
test('recorded coordinates match transmitted precision and respawn clears acknowledgements', () => {
  const history = new PredictionHistory();
  const first = history.record({ x: 1.23456, y: .5001, z: -3.9999 });
  assert.deepEqual(first, { seq: 1, x: 1.235, y: .5, z: -4 });
  assert.deepEqual(history.acknowledge(first.seq, { x: 1.236, y: .5, z: -4 }),
    { x: 0, y: 0, z: 0 });
  history.reset();
  assert.equal(history.lastAck, 0);
  assert.equal(history.pending.length, 0);
  assert.equal(history.record({ x: 0, y: 0, z: 0 }).seq, 1);
});
