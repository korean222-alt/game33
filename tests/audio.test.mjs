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

test('사람 소리: 비명 · 수갑 · 작업 · 이명이 모두 난다', async () => {
  const ctx = context(), audio = new GameAudio({ contextFactory: () => ctx });
  await audio.unlock();
  const layers = (play) => { audio.stop(); play(); return audio.sources.size; };

  // 비명은 목소리 한 겹 + 숨소리 한 겹
  assert.equal(layers(() => audio.scream(null, 'pain')), 2);
  assert.equal(layers(() => audio.scream({ x: 4, y: 1, z: 0 }, 'death')), 2);
  // 수갑은 래칫 일곱 번 + 잠김 두 겹
  assert.equal(layers(() => audio.cuff({ x: 1, y: 0, z: 1 })), 9);
  assert.equal(layers(() => audio.work(null, 'defuse')), 3);
  assert.equal(layers(() => audio.work(null, 'evidence')), 2);
  assert.equal(layers(() => audio.pickup()), 3);
  assert.equal(layers(() => audio.pin()), 3);
  assert.equal(layers(() => audio.tinnitus(3)), 2);
  assert.equal(layers(() => audio.beep()), 2);
  assert.equal(layers(() => audio.cough()), 2);
  audio.dispose();
});

test('남의 장전 소리는 내 장전을 취소하지 않는다', async () => {
  const ctx = context(), audio = new GameAudio({ contextFactory: () => ctx });
  await audio.unlock();
  audio.reload(2);                                   // 내 장전
  assert.equal(audio.reloadSources.size, 5);
  audio.reload(2, { x: 6, y: 1, z: 0 });             // 옆 대원의 장전
  assert.equal(audio.reloadSources.size, 5, '내 장전 소리는 그대로 남는다');
  audio.cancelReload();
  assert.equal(audio.reloadSources.size, 0);
  audio.dispose();
});

test('음성 합성이 없는 브라우저에서도 조용히 넘어간다', async () => {
  const ctx = context(), audio = new GameAudio({ contextFactory: () => ctx });
  await audio.unlock();
  assert.equal(audio.speak('Drop the weapon!'), false);   // globalThis.speechSynthesis 없음

  const spoken = [];
  globalThis.speechSynthesis = { speak: (u) => spoken.push(u), cancel: () => spoken.push('cancel') };
  globalThis.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; };
  try {
    assert.equal(audio.speak('Drop the weapon!'), true);
    assert.equal(spoken[0].text, 'Drop the weapon!');
    assert.equal(spoken[0].lang, 'en-US');
    audio.setEnabled(false);
    assert.equal(audio.speak('Hands up!'), false, '소리를 끄면 말도 하지 않는다');
  } finally {
    delete globalThis.speechSynthesis;
    delete globalThis.SpeechSynthesisUtterance;
  }
  audio.dispose();
});

test('컨텍스트가 멈춰 있으면 다음 소리를 위해 다시 깨운다', async () => {
  const ctx = context();
  const audio = new GameAudio({ contextFactory: () => ctx });
  await audio.unlock();
  assert.equal(audio.running, true);
  ctx.state = 'suspended';                 // 탭 전환 등으로 멈췄다
  audio.shot();                            // 이 소리는 나지 않지만
  await Promise.resolve();
  assert.equal(ctx.state, 'running', '다시 깨워 둔다');
  audio.dispose();
});
