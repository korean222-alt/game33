/* =============================================================================
 *  reconnect.test.mjs  -  경기 중 끊긴 대원이 돌아올 수 있는가
 *
 *  실측으로 확인한 버그: 소켓이 1초만 끊겨도 disconnect 핸들러가 곧바로
 *  removePlayer 를 불러 플레이어를 지웠고, joinRoom 은 state === 'active' 이면
 *  무조건 거부했다. 22분짜리 작전에서 와이파이 순단 한 번이 영구 퇴장이었다.
 *
 *  여기서 검증하는 것:
 *    1) 끊겨도 즉시 지워지지 않는다 (인원이 그대로고, 팀에게 알림이 간다)
 *    2) 유예 시간 안에 같은 이름으로 들어오면 그 자리에 이어 붙고,
 *       진행 중인 판(문/전력/목표/내 HP·탄약)을 통째로 다시 받는다
 *    3) 유예 시간이 지나면 그제서야 지워지고 방 정리가 정상적으로 돈다
 *
 *  서버는 RECONNECT_GRACE_MS 로 유예를 줄일 수 있다. 90초를 실제로 기다리는
 *  테스트는 쓸 수 없으므로 2.5초로 낮춰서 같은 경로를 탄다.
 * ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { io } from 'socket.io-client';

const GRACE_MS = 2500;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(socket, event, predicate = () => true, timeout = 8000) {
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

/** 서버를 띄우고, 두 대원이 경기에 들어간 상태까지 만든다. */
async function startMatchWithTwo(t, port) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), RECONNECT_GRACE_MS: String(GRACE_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.disconnect()); server.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 8000);
    server.stdout.on('data', (data) => {
      if (String(data).includes('서버 준비됨')) { clearTimeout(timer); resolve(); }
    });
    server.once('error', reject);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
  });

  // reconnection: false. 자동 재연결이 붙으면 "끊긴 상태" 를 만들 수가 없다.
  const connect = async () => {
    const socket = io(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  };
  const request = (s, event, payload) => new Promise((resolve, reject) =>
    s.timeout(4000).emit(event, payload, (error, result) => (error ? reject(error) : resolve(result))));

  const host = await connect(), guest = await connect();
  const created = await request(host, 'createRoom', { name: '호스트', weapon: 'rifle' });
  const code = created.lobby.code;
  await request(guest, 'joinRoom', { code, name: '게스트', weapon: 'smg' });

  host.emit('setRoomConfig', { botCount: 3, difficulty: 'easy' });
  await waitFor(host, 'lobby', (l) => l.botCount === 3);
  host.emit('setLoadout', { ready: true });
  guest.emit('setLoadout', { ready: true });
  await waitFor(host, 'lobby', (l) => l.players.length === 2 && l.players.every((p) => p.ready));

  const briefingEvent = waitFor(host, 'briefing');
  host.emit('startMatch');
  const briefing = await briefingEvent;
  const started = waitFor(host, 'matchStart');
  host.emit('briefingReady', { id: briefing.id });
  guest.emit('briefingReady', { id: briefing.id });
  const match = await started;

  return { host, guest, code, match, connect, request };
}

test('경기 중 끊긴 대원은 유예 시간 안에 같은 이름으로 돌아와 이어서 뛴다', { timeout: 40000 }, async (t) => {
  const { host, guest, code, connect, request } = await startMatchWithTwo(t, 3191);

  const guestId = guest.id;
  const before = await waitFor(host, 'snapshot', (s) => s.players.length === 2);
  assert.equal(before.players.length, 2, '끊기기 전에는 두 명이다');

  /* ---- 1. 끊겨도 즉시 지워지지 않는다 ----
     알림은 끊긴 즉시 한 번에 나간다(playerHeld · radio · lobby). 끊고 나서
     듣기 시작하면 이미 지나간 뒤라, 귀부터 열고 끊는다. */
  const heldEvent = waitFor(host, 'playerHeld', (d) => d.id === guestId);
  const lobbyDuringEvent = waitFor(host, 'lobby', (l) => l.players.some((p) => !p.connected));
  guest.disconnect();
  const held = await heldEvent;
  assert.equal(held.name, '게스트');
  assert.equal(held.seconds, Math.round(GRACE_MS / 1000));

  const lobbyDuring = await lobbyDuringEvent;
  const heldRow = lobbyDuring.players.find((p) => p.id === guestId);
  assert.equal(heldRow.connected, false);
  assert.ok(heldRow.holdMs > 0 && heldRow.holdMs <= GRACE_MS, '남은 유예 시간을 같이 보낸다');

  const during = await waitFor(host, 'snapshot', () => true);
  assert.equal(during.players.length, 2, '유예 중에는 스냅샷에 그대로 남아 있다');
  const frozen = during.players.find((p) => p.id === guestId);
  assert.ok(frozen, '끊긴 대원도 스냅샷에 실린다');
  assert.equal(frozen.moving, 0, '조작이 없으니 달리는 자세로 얼어붙지 않는다');

  // 그 사이 좌표가 멈춰 있는지 (마지막 자리에 고정)
  const later = await waitFor(host, 'snapshot', (s) => s.seq > during.seq + 4);
  const stillFrozen = later.players.find((p) => p.id === guestId);
  assert.equal(stillFrozen.x, frozen.x, '끊긴 대원은 마지막 좌표에 머문다');
  assert.equal(stillFrozen.z, frozen.z);

  /* ---- 2. 같은 이름으로 다시 들어오면 그 자리에 이어 붙는다 ---- */
  const back = await connect();
  const resumeEvent = waitFor(back, 'matchStart', (d) => d.resumed === true);
  const lobbyAfterEvent = waitFor(back, 'lobby', (l) => l.players.every((p) => p.connected));
  const rejoined = await request(back, 'joinRoom', { code, name: '게스트', weapon: 'smg' });
  assert.equal(rejoined.ok, true, '진행 중이어도 자리를 비워 둔 본인은 들어올 수 있다');
  assert.equal(rejoined.resumed, true);
  assert.equal(rejoined.you, guestId, '게임상 신원(id)은 소켓이 바뀌어도 그대로다');

  const resume = await resumeEvent;
  assert.ok(Array.isArray(resume.doors) && resume.doors.length > 0, '문 상태 전체를 다시 받는다');
  assert.ok(Array.isArray(resume.npcs) && resume.npcs.length > 0, 'NPC 현황을 다시 받는다');
  assert.ok(resume.objectives, '현재 단계의 목표표를 다시 받는다');
  assert.equal(typeof resume.power, 'boolean', '전력 상태를 다시 받는다');
  assert.equal(resume.self.id, guestId);
  assert.equal(resume.self.hp, 100);
  assert.equal(resume.self.weapon, 'smg', '장비가 보존된다');
  assert.equal(resume.players.length, 2);

  // 돌아온 대원이 실제로 다시 움직인다.
  back.emit('input', {
    seq: 1, x: resume.self.x, y: 0, z: resume.self.z,
    yaw: resume.self.yaw, pitch: 0, moving: 1,
  });
  const moving = await waitFor(host, 'snapshot', (s) => s.players.find((p) => p.id === guestId)?.moving === 1);
  assert.ok(moving, '이어 붙은 소켓의 입력이 원래 슬롯에 반영된다');

  const lobbyAfter = await lobbyAfterEvent;
  assert.equal(lobbyAfter.players.length, 2);
  host.disconnect();
});

test('유예 시간이 지나면 대원이 제거되고, 아무도 없으면 방까지 정리된다', { timeout: 40000 }, async (t) => {
  const { host, guest, code, connect, request } = await startMatchWithTwo(t, 3192);

  const guestId = guest.id;
  const leftEvent = waitFor(host, 'playerLeft', (d) => d.id === guestId, 12000);
  guest.disconnect();

  // 유예가 끝나기 전에는 아직 안 지워진다.
  await delay(GRACE_MS / 2);
  const mid = await waitFor(host, 'snapshot', () => true);
  assert.equal(mid.players.length, 2, '유예 중에는 그대로다');

  await leftEvent;
  const after = await waitFor(host, 'snapshot', (s) => s.players.length === 1, 8000);
  assert.equal(after.players.length, 1, '유예가 끝나면 진짜로 빠진다');

  // 이제는 같은 이름으로도 못 들어온다. 자리가 없어졌기 때문이다.
  const late = await connect();
  const refused = await request(late, 'joinRoom', { code, name: '게스트', weapon: 'smg' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, '이미 작전이 진행 중이에요.');

  // 남은 한 명까지 나가면 방이 사라진다.
  host.disconnect();
  await delay(GRACE_MS + 6000);
  const gone = await request(late, 'joinRoom', { code, name: '아무개', weapon: 'rifle' });
  assert.equal(gone.ok, false);
  assert.equal(gone.error, '그런 방 코드가 없어요.', '유예까지 끝난 빈 방은 정리된다');
});

test('이름이 다르면 진행 중인 방에 끼어들 수 없다', { timeout: 40000 }, async (t) => {
  const { guest, code, connect, request } = await startMatchWithTwo(t, 3193);

  guest.disconnect();
  await delay(200);

  const stranger = await connect();
  const refused = await request(stranger, 'joinRoom', { code, name: '모르는사람', weapon: 'rifle' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, '이미 작전이 진행 중이에요.');
});
