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
  // 내 총: 총구음 + 저역 충격 + 금속음 + 잔향 + 탄피 2 = 6겹
  audio.shot(); assert.equal(audio.sources.size, 6);
  audio.stop();
  // 남의 총: 탄피는 그 자리에서만 들린다 -> 4겹
  audio.shot('rifle', { x: 6, y: 1.6, z: 0 }); assert.equal(audio.sources.size, 4);
  audio.stop();
  audio.reload(2); assert.equal(audio.reloadSources.size, 5);
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
  await audio.unlock();
  for (const play of [
    () => audio.shot(), () => audio.reload(), () => audio.door({ x: 1, z: 1 }, 'kick'),
    () => audio.dryFire(), () => audio.impact({ x: 1, y: 1, z: 1 }), () => audio.hurt(),
    () => audio.contact({ x: 2, y: 1, z: 2 }), () => audio.blast('flash', { x: 1, y: 0, z: 1 }),
    () => audio.bounce(), () => audio.footstep({ crouch: true }),
  ]) play();
  audio.dispose();
});

test('문 동작마다 다른 소리가 나고, 강제 개방이 가장 크다', async () => {
  const ctx = context(), audio = new GameAudio({ contextFactory: () => ctx });
  await audio.unlock();
  const layers = (action) => { audio.stop(); audio.door({ x: 0, z: 0 }, action); return audio.sources.size; };
  assert.equal(layers('peek'), 1);          // 문틈 확인은 거의 소리가 없다
  assert.equal(layers('open'), 3);
  assert.equal(layers('close'), 4);         // 닫을 때는 마지막에 닫히는 소리가 더 붙는다
  assert.equal(layers('kick'), 3);
  assert.equal(layers('unlock'), 4);        // 해정은 걸쇠를 네 번 건드린다
  audio.dispose();
});

test('내가 맞은 소리와 발각 경고는 위치에 따라 좌우가 갈린다', async () => {
  const ctx = context(), audio = new GameAudio({ contextFactory: () => ctx });
  await audio.unlock();
  audio.setListener({ x: 0, y: 1.6, z: 0 }, 0);
  audio.hurt();
  assert.ok(audio.sources.size > 0);
  audio.stop();
  const bus = audio._bus({ x: -4, y: 1.6, z: 0 });
  assert.ok(bus.nodes[2].pan.value < -0.99, '왼쪽에서 난 소리가 왼쪽에서 들려야 한다');
  audio.dispose();
});
