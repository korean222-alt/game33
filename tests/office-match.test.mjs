/* =============================================================================
 *  office-match.test.mjs  -  사무실 맵으로 실제 한 판을 끝까지 돌린다
 *
 *  좌표가 맞는지는 office.test.mjs 가 본다. 여기서 보는 것은 그 좌표 위에서
 *  서버가 실제로 굴러가는지다 - 봇을 채우고, 브리핑을 지나, 스냅샷이 흐르고,
 *  목표가 진행되고, 소음원과 화재경보기가 동작하는지.
 *
 *  맵을 바꾸는 경로가 특히 중요하다. 서버는 "지금 켜진 맵" 하나를 공유하고
 *  방마다 그걸 갈아 끼우므로, 두 방이 서로 다른 맵으로 동시에 돌아도 서로의
 *  좌표를 침범하지 않는지 확인한다.
 * ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { getMap } from '../public/js/map-data.js';

const OFFICE = getMap('office');
const MANSION = getMap('mansion');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(socket, event, predicate = () => true, timeout = 10000) {
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

async function boot(t, port) {
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
    server.stdout.on('data', (d) => { if (String(d).includes('서버 준비됨')) { clearTimeout(timer); resolve(); } });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
  });
  const connect = async () => {
    const s = io(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
    sockets.push(s);
    await once(s, 'connect');
    return s;
  };
  const request = (s, event, payload) => new Promise((resolve, reject) =>
    s.timeout(6000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res))));
  return { connect, request, stderr };
}

/** 방 하나를 만들어 지정한 맵으로 경기를 시작한다. */
async function startOn(connect, request, mapId, name = '검증') {
  const host = await connect();
  const created = await request(host, 'createRoom', { name, weapon: 'rifle', mapId });
  host.emit('setRoomConfig', { botCount: 6, difficulty: 'easy' });
  await waitFor(host, 'lobby', (l) => l.botCount === 6 && l.mapId === mapId);
  host.emit('setLoadout', { ready: true });
  await waitFor(host, 'lobby', (l) => l.players.every((p) => p.ready));
  const briefingEvent = waitFor(host, 'briefing');
  host.emit('startMatch');
  const briefing = await briefingEvent;
  const started = waitFor(host, 'matchStart');
  host.emit('briefingReady', { id: briefing.id });
  return { host, code: created.lobby.code, match: await started };
}

test('사무실 맵으로 경기가 시작되고 스냅샷이 흐른다', { timeout: 40000 }, async (t) => {
  const { connect, request, stderr } = await boot(t, 3196);
  const { host, match } = await startOn(connect, request, 'office');

  assert.equal(match.mapId, 'office');
  assert.equal(match.doors.length, OFFICE.DOORWAYS.length, '사무실의 문이 전부 실려 온다');
  assert.ok(match.npcs.length >= 7, `봇 6 + 주범 + 인질이 나와야 한다 (실제 ${match.npcs.length})`);
  assert.equal(match.extraction.x, OFFICE.EXTRACTION.x);
  assert.equal(match.extraction.z, OFFICE.EXTRACTION.z);
  assert.equal(match.sites.length, OFFICE.BOMB_SITES.length);

  // 시작 좌표가 사무실 것이다 (저택 스폰은 z 38~40, 사무실은 45~47).
  const me = match.players.find((p) => p.id === host.id);
  assert.ok(OFFICE.SPAWNS.some((s) => Math.abs(s.x - me.x) < 0.01 && Math.abs(s.z - me.z) < 0.01),
    `시작 좌표 (${me.x}, ${me.z}) 가 사무실 스폰이 아니다`);

  // NPC 가 전부 사무실 부지 안에 있다.
  for (const n of match.npcs) {
    assert.ok(Math.abs(n.x) <= OFFICE.MAP.width / 2 && Math.abs(n.z) <= OFFICE.MAP.depth / 2,
      `${n.id} 가 부지 밖 (${n.x}, ${n.z})`);
  }

  /* 스냅샷이 흐르고, NPC 가 실제로 걸어 다닌다.
   *
   *  이게 길찾기 격자가 사무실 크기로 다시 만들어졌는지를 보는 자리다. 저택
   *  격자(88×88)를 그대로 쓰면 사무실 좌표 대부분이 격자 밖으로 잘려 경로가
   *  안 나오고, NPC 는 제자리에서 두리번거리기만 한다.
   *
   *  배치 직후 몇 초는 원래 다들 서서 주위를 살핀다(setupMission 이 시선 변경
   *  시점을 3.5~8.5초로 흩뜨려 놓는다). 12초를 보고 판단한다. */
  const first = await waitFor(host, 'snapshot');
  const later = await waitFor(host, 'snapshot', (s) => s.t - first.t > 12000, 20000);
  const moved = later.npcs.filter((n) => {
    const before = first.npcs.find((m) => m.id === n.id);
    return before && Math.hypot(n.x - before.x, n.z - before.z) > 0.3;
  });
  assert.ok(moved.length > 0,
    `12초 동안 NPC ${later.npcs.length}명이 아무도 안 움직였다 - 길찾기가 막혔을 수 있다`);

  assert.deepEqual(stderr, [], '서버가 오류를 뱉었다');
});

test('사무실의 소음원과 화재경보기가 동작한다', { timeout: 40000 }, async (t) => {
  const { connect, request, stderr } = await boot(t, 3197);
  const { host, match } = await startOn(connect, request, 'office');

  /* ---- 주기적 소음원 ----
     제일 자주 우는 것이 20초 주기라 기다릴 수 없다. 대신 서버가 보내는
     mapSound 를 25초까지 기다리되, 그 안에 하나라도 오면 통과로 본다. */
  const sound = await waitFor(host, 'mapSound', () => true, 26000);
  assert.ok(['copier', 'lift'].includes(sound.type), `모르는 소리 종류: ${sound.type}`);
  assert.ok(Number.isFinite(sound.x) && Number.isFinite(sound.z));

  /* ---- 화재경보기 ----
     경보기 앞으로 순간이동해서 use 를 누른 것과 같은 상태를 만든다. 서버는
     클라이언트 예측 좌표를 신뢰하되 충돌만 보정하므로, 설 수 있는 자리면
     그대로 반영된다. */
  const alarm = OFFICE.ALARMS.find((a) => a.id === 'alarmLobby');
  const me = match.players.find((p) => p.id === host.id);
  let seq = 1;
  const stand = (x, z) => host.emit('input', { seq: seq++, x, y: 0, z, yaw: 0, pitch: 0, use: true });
  // 경보기에서 1.2m 떨어진 자리. 로비 아치 쪽이 트여 있다.
  const started = waitFor(host, 'alarmStarted', (d) => d.id === alarm.id, 12000);
  for (let i = 0; i < 40; i++) { stand(alarm.x + 1.2, alarm.z); await delay(60); }
  const ring = await started;
  assert.equal(ring.by, host.id);
  assert.equal(ring.seconds, 8);
  const stopped = await waitFor(host, 'alarmStopped', (d) => d.id === alarm.id, 14000);
  assert.ok(stopped);

  assert.deepEqual(stderr, [], '서버가 오류를 뱉었다');
});

test('두 방이 서로 다른 맵으로 동시에 돌아도 좌표가 섞이지 않는다', { timeout: 40000 }, async (t) => {
  const { connect, request, stderr } = await boot(t, 3198);
  const a = await startOn(connect, request, 'office', '사무실');
  const b = await startOn(connect, request, 'mansion', '저택');

  assert.equal(a.match.mapId, 'office');
  assert.equal(b.match.mapId, 'mansion');

  const inside = (map, p) =>
    Math.abs(p.x) <= map.MAP.width / 2 + 1 && Math.abs(p.z) <= map.MAP.depth / 2 + 1;

  // 두 방의 스냅샷을 여러 번 받아 보며 서로의 부지를 침범하지 않는지 본다.
  for (let i = 0; i < 3; i++) {
    const [sa, sb] = await Promise.all([waitFor(a.host, 'snapshot'), waitFor(b.host, 'snapshot')]);
    for (const n of sa.npcs) assert.ok(inside(OFFICE, n), `사무실 방의 ${n.id} 가 (${n.x}, ${n.z})`);
    for (const n of sb.npcs) assert.ok(inside(MANSION, n), `저택 방의 ${n.id} 가 (${n.x}, ${n.z})`);
    // 저택은 88×88 이라 사무실 스폰(z 45+)이 있을 수 없다.
    for (const p of sb.players) assert.ok(Math.abs(p.z) < MANSION.MAP.depth / 2, '저택 방의 대원이 부지 밖이다');
  }

  assert.deepEqual(stderr, [], '서버가 오류를 뱉었다');
});
