import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAudio } from '../public/js/audio.js';

function context() {
  const nodes = [], starts = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => {
    const n = { gain: param(), frequency: param(), Q: param(), pan: param(), disconnected: false,
      connect() {}, disconnect() { this.disconnected = true; },
      start(time) { starts.push(time); }, stop() { this.stopped = true; } };
    nodes.push(n); return n;
  };
  return { state: 'suspended', currentTime: 10, sampleRate: 100, destination: {},
    createGain: node, createBiquadFilter: node, createStereoPanner: node,
    createOscillator: node, createBufferSource: node,
    createBuffer: () => ({ getChannelData: () => new Float32Array(100) }),
    async resume() { this.state = 'running'; }, async close() { this.state = 'closed'; },
    nodes, starts,
  };
}

test('sounds wait for a gesture; reloads and active voices cancel on mute/dispose', async () => {
  const ctx = context();
  let created = 0;
  const audio = new GameAudio({ contextFactory: () => { created++; return ctx; } });
  audio.shot(); assert.equal(created, 0);
  await audio.unlock(); assert.equal(ctx.state, 'running');
  audio.shot(); assert.equal(audio.sources.size, 3);
  audio.reload(2); assert.equal(audio.reloadSources.size, 4);
  const reload = [...audio.reloadSources];
  audio.cancelReload(); assert.ok(reload.every(source => source.stopped));
  assert.equal(audio.reloadSources.size, 0);
  audio.setEnabled(false); assert.equal(audio.sources.size, 0);
  const count = ctx.starts.length; audio.shot(); assert.equal(ctx.starts.length, count);
  audio.dispose(); assert.equal(ctx.state, 'closed');
  assert.ok(ctx.nodes.filter(n => n.gain).some(n => n.disconnected));
});

test('remote gunfire pans relative to the listener and walls muffle it', async () => {
  const ctx = context(), audio = new GameAudio({ contextFactory: () => ctx });
  await audio.unlock();
  audio.setListener({ x: 0, y: 1.6, z: 0 }, 0);
  const right = audio._bus({ x: 5, y: 1.6, z: 0 });
  const left = audio._bus({ x: -5, y: 1.6, z: 0 }, true);
  assert.equal(right.nodes[2].pan.value, 1);
  assert.equal(left.nodes[2].pan.value, -1);
  assert.ok(left.gain.gain.value < right.gain.gain.value);
  assert.equal(left.nodes[1].frequency.value, 700);
  audio.setListener({ x: 0, y: 1.6, z: 0 }, Math.PI);
  assert.ok(audio._bus({ x: 5, y: 1.6, z: 0 }).nodes[2].pan.value < -0.99);
  audio.dispose();
});

test('unsupported audio never prevents a game from starting', async () => {
  const audio = new GameAudio({ contextFactory: () => null });
  await audio.unlock(); audio.shot(); audio.reload(); audio.door({ x: 1, z: 1 }); audio.dispose();
});
