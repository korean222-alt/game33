import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { DOORWAYS, SPAWNS } from '../public/js/map-data.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 특정 조건을 만족하는 이벤트를 기다린다 (앞선 이벤트가 섞여도 안전하다). */
function waitFor(socket, event, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeout);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

test('two clients: readiness gate, shot validation, doors, 장비, 단계, room cleanup', { timeout: 30000 }, async (t) => {
  const port = 3187;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  const stderr = [];
  server.stderr.on('data', (d) => stderr.push(String(d)));
  t.after(() => { sockets.forEach((s) => s.disconnect()); server.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 8000);
    server.stdout.on('data', (data) => {
      if (String(data).includes('서버 준비됨')) { clearTimeout(timer); resolve(); }
    });
    server.once('error', reject);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
  });

  const connect = async () => {
    const socket = io(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  };
  const host = await connect(), guest = await connect();
  const request = (s, event, payload) => new Promise((resolve, reject) =>
    s.timeout(4000).emit(event, payload, (error, result) => (error ? reject(error) : resolve(result))));

  const created = await request(host, 'createRoom', { name: '검증1', weapon: 'rifle' });
  const joined = await request(guest, 'joinRoom', { code: created.lobby.code, name: '검증2', weapon: 'smg' });
  assert.equal(joined.ok, true);

  /* ---- 준비 상태가 아니면 브리핑이 시작되지 않는다 ---- */
  let starts = 0;
  host.on('matchStart', () => starts++);
  host.emit('startMatch');
  await delay(150);
  assert.equal(starts, 0);

  host.emit('setRoomConfig', { botCount: 4, difficulty: 'easy' });
  await waitFor(host, 'lobby', (l) => l.botCount === 4 && l.difficulty === 'easy');
  host.emit('setLoadout', { ready: true });
  await waitFor(host, 'lobby', (l) => l.players.find((p) => p.id === host.id)?.ready);
  guest.emit('setLoadout', { ready: true });
  await waitFor(host, 'lobby', (l) => l.players.every((p) => p.ready));

  const briefingEvent = waitFor(host, 'briefing');
  host.emit('startMatch');
  const briefing = await briefingEvent;
  // 브리핑 중에는 사격이 통하지 않는다.
  assert.equal((await request(host, 'shoot', { dx: 0, dy: 0, dz: -1 })).ok, false);
  await delay(120);
  assert.equal(starts, 0);

  host.emit('briefingReady', { id: briefing.id });
  await delay(100);
  assert.equal(starts, 0);
  // 잘못된 브리핑 번호로는 출동할 수 없다.
  guest.emit('briefingReady', { id: briefing.id - 1 });
  await delay(100);
  assert.equal(starts, 0);

  const started = waitFor(host, 'matchStart');
  guest.emit('briefingReady', { id: briefing.id });
  const match = await started;

  /* ---- 매치 구성 ---- */
  assert.ok(match.endsAt - Date.now() > 21 * 60 * 1000);
  assert.equal(match.players.length, 2);
  assert.equal(match.doors.length, DOORWAYS.length);
  assert.ok(match.npcs.some((n) => n.kind === 'hvt'), '주요 용의자가 있다');
  assert.ok(match.npcs.some((n) => n.id === 'hostage'), '인질이 있다');
  assert.equal(match.evidence.length, 3);
  assert.equal(match.objectives.id, 'approach');
  assert.ok(match.objectives.list.length >= 2);
  // 팀은 저택 밖(담장 안 진입로)에서 시작한다.
  for (const p of match.players) {
    assert.ok(p.z > 18, `밖에서 시작해야 한다: ${p.z}`);
    assert.ok(SPAWNS.some((s) => Math.abs(s.x - p.x) < .001 && Math.abs(s.z - p.z) < .001));
  }
  // 조용히 들어갈 수 있는 진입구가 최소 하나 남아 있다.
  const entries = match.doors.filter((d) => DOORWAYS.find((w) => w.id === d.id).kind === 'entry');
  assert.ok(entries.some((d) => d.state === 'closed' || d.state === 'open'));

  /* ---- 사격 검증 ---- */
  host.emit('input', { seq: 1, x: SPAWNS[0].x, y: .5, z: SPAWNS[0].z, yaw: 0, pitch: 0 });
  const shotEvent = waitFor(guest, 'playerShot');
  const shot = await request(host, 'shoot', { shotId: 1, dx: 1, dy: 0, dz: 0 });
  assert.equal(shot.ok, true);
  assert.equal(shot.shotSeq, 1);
  const effect = await shotEvent;
  assert.equal(effect.dz, 0);
  assert.equal(effect.dx, 1);
  assert.equal(effect.y, 2.12);
  assert.equal((await request(host, 'shoot', { dx: null, dy: 0, dz: -1 })).ok, false);
  assert.equal((await request(host, 'shoot', { shotId: 1, dx: 1, dy: 0, dz: 0 })).reason, 'stale');

  host.emit('setLoadout', { weapon: 'sniper', ready: false });
  const snapshot = await waitFor(host, 'snapshot', (s) => s.players.some((p) => p.id === host.id));
  const me = snapshot.players.find((p) => p.id === host.id);
  assert.equal(me.inputSeq, 1);
  assert.equal(me.ammo, 29); // 작전 중 장비 변경으로 탄약이 채워지지 않는다.
  assert.deepEqual(me.grenades, { flash: 2, gas: 2, frag: 1 });
  assert.equal(snapshot.npcs.length, match.npcs.length);

  /* ---- 오래된 입력은 무시된다 ---- */
  host.emit('input', { seq: 2, x: 0, y: 0, z: 24, yaw: 0, pitch: 0 });
  const moved = await waitFor(host, 'snapshot', (s) => s.players.find((p) => p.id === host.id).inputSeq === 2);
  const at24 = moved.players.find((p) => p.id === host.id);
  assert.equal(at24.z, 24);
  host.emit('input', { seq: 1, x: 12, y: 0, z: 12, yaw: 0, pitch: 0 });
  await delay(120);
  const afterStale = await waitFor(host, 'snapshot');
  const unchanged = afterStale.players.find((p) => p.id === host.id);
  assert.equal(unchanged.inputSeq, 2);
  assert.equal(unchanged.z, 24);

  /* ---- 문 ---- */
  const front = DOORWAYS.find((d) => d.id === 'front');
  assert.equal((await request(host, 'door', { id: 'front', action: 'open' })).error, 'far');
  host.emit('input', { seq: 3, x: front.x, y: 0, z: front.z + 1.2, yaw: 0, pitch: 0 });
  await waitFor(host, 'snapshot', (s) => s.players.find((p) => p.id === host.id).inputSeq === 3);
  const peek = await request(host, 'door', { id: 'front', action: 'peek' });
  assert.equal(peek.ok, true);
  assert.ok(['none', 'one', 'several'].includes(peek.contacts));
  assert.equal((await request(host, 'door', { id: 'front', action: 'peek' })).error, 'busy');
  await delay(800);
  const opened = await request(host, 'door', { id: 'front', action: 'kick' });
  assert.equal(opened.ok, true);
  const doorState = await waitFor(host, 'doorState', (d) => d.id === 'front');
  assert.ok(['open', 'destroyed'].includes(doorState.state));
  assert.equal((await request(host, 'door', { id: 'nope', action: 'open' })).error, 'no-door');

  /* ---- 투척 장비 ---- */
  const thrown = await request(host, 'throw', { type: 'flash', dx: 0, dy: .2, dz: -1, power: 1 });
  assert.equal(thrown.ok, true);
  assert.equal(thrown.grenades.flash, 1);
  assert.equal((await request(host, 'throw', { type: 'flash', dx: 0, dy: 0, dz: 0 })).ok, false);
  const explosion = await waitFor(host, 'grenadeExploded', () => true, 4000);
  assert.equal(explosion.type, 'flash');
  // 장비를 다 쓰면 더 던질 수 없다.
  await delay(750);
  assert.equal((await request(host, 'throw', { type: 'flash', dx: 0, dy: .2, dz: -1 })).grenades.flash, 0);
  await delay(750);
  assert.equal((await request(host, 'throw', { type: 'flash', dx: 0, dy: .2, dz: -1 })).ok, false);

  host.emit('shout');   // 예외 없이 처리된다

  /* ---- 방 정리와 브리핑 취소 ---- */
  const second = await request(host, 'createRoom', { name: '검증1', weapon: 'rifle' });
  guest.emit('leaveRoom');
  await delay(150);
  const health = await (await fetch(`http://localhost:${port}/health`)).json();
  assert.equal(health.rooms, 1);
  assert.notEqual(second.lobby.code, created.lobby.code);

  host.emit('setLoadout', { ready: true });
  await waitFor(host, 'lobby', (l) => l.players.every((p) => p.ready));
  const nextBriefing = waitFor(host, 'briefing');
  host.emit('startMatch');
  await nextBriefing;
  const cancelled = waitFor(host, 'lobby', (l) => l.state === 'lobby');
  host.emit('cancelBriefing');
  const cancelledLobby = await cancelled;
  assert.ok(cancelledLobby.players.every((p) => !p.ready));

  assert.deepEqual(stderr, [], '서버가 예외 없이 동작한다');
});
