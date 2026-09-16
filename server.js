/* =============================================================================
 *  server.js  -  Express + Socket.io 진입점 (권위 서버)
 *
 *  역할
 *    1) public/ 정적 서빙 + node_modules/three 를 /vendor/three 로 서빙
 *    2) 소켓 이벤트 등록 - 방 만들기/들어가기, 준비, 브리핑, 입력, 사격, 문, 장비
 *    3) 경기 시작과 상태 재동기화 페이로드
 *
 *  시뮬레이션 자체는 server/ 아래로 나눠져 있다. 이 파일은 그 함수들을 소켓
 *  이벤트에 연결하기만 한다 - 예전에 61KB 한 덩어리이던 동안 업로드 과정에서
 *  파일이 통째로 잘려 커밋된 사고가 일곱 번 있었다.
 *
 *  실행: npm install && npm start   ->  http://localhost:3000
 * ========================================================================== */

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import { GAME_PROTOCOL } from './public/js/protocol.js';
import { MAP, COLLIDERS, SPAWNS, EXTRACTION, ROOMS, resolveCircle } from './public/js/map-data.js';
import { DOOR_ACTIONS, DOOR_REACH, doorDistance } from './public/js/doors.js';
import { NOISE } from './public/js/perception.js';
import { GRENADES, GRENADE_ORDER, startingGrenades } from './public/js/grenades.js';
import { PHASES, MISSION } from './public/js/mission-story.js';
import { objectiveReport } from './public/js/objectives.js';

import {
  TICK_MS, WEAPONS, DIFFICULTY, PLAYER_RADIUS, PLAYER_MAX_HP, PLAYER_EYE,
  MISSION_TIME_MS, DEFUSE_SECONDS,
} from './server/constants.js';
import { now, clamp, at3, makeRoomCode, emitNoise, npcPublic } from './server/util.js';
import { rooms, Room, closeRoom } from './server/room.js';
import { setupMission, checkMissionEnd, announceHold, dropExpiredHolds } from './server/mission.js';
import { queueDoorAction } from './server/door-actions.js';
import { resolveShot, throwGrenade } from './server/combat.js';
import { shout, updateInteractions } from './server/interactions.js';
import { tickRoom } from './server/tick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();

/* ========================================================================== *
 *  입력
 * ========================================================================== */

function applyPlayerInput(room, me, d) {
  if (!d || !['x', 'y', 'z', 'yaw', 'pitch'].every((k) => Number.isFinite(d[k]))) return;
  if (d.seq !== undefined && (!Number.isSafeInteger(d.seq) || d.seq <= me.inputSeq)) return;
  // 위치는 클라 예측을 신뢰하되 서버에서 한 번 더 충돌 보정 (벽/문 뚫기 방지)
  const height = d.crouch ? 1.3 : 1.8;
  me.y = clamp(d.y, 0, MAP.height - height);
  const fixed = resolveCircle(d.x, d.z, PLAYER_RADIUS, room.doors.colliders(), me.y, height);
  me.x = fixed.x;
  me.z = fixed.z;
  me.yaw = +d.yaw || 0;
  me.pitch = clamp(+d.pitch || 0, -1.5, 1.5);
  me.moving = d.moving ? 1 : 0;
  me.sprint = d.sprint ? 1 : 0;
  me.crouch = d.crouch ? 1 : 0;
  me.holdingUse = !!d.use;
  me.light = !!d.light;
  if (d.seq !== undefined) me.inputSeq = d.seq;
}


/* ========================================================================== *
 *  브리핑 / 시작
 * ========================================================================== */

function beginBriefing(room, io) {
  room.state = 'briefing';
  room.briefingId++;
  for (const p of room.players.values()) p.briefingReady = false;
  io.to(room.code).emit('briefing', { id: room.briefingId });
  io.to(room.code).emit('lobby', room.lobbyState());
}

function cancelBriefing(room, io) {
  if (room.state !== 'briefing') return;
  room.state = 'lobby';
  for (const p of room.players.values()) { p.ready = false; p.briefingReady = false; }
  io.to(room.code).emit('briefingCancelled');
}



/**
 * 지금 경기 상태를 통째로 담은 한 덩어리.
 *
 *  시작할 때 한 번 쓰고, 중간에 돌아온 대원에게 한 번 더 쓴다. 두 자리가
 *  같은 함수를 쓰는 것이 요점이다 — 따로 두면 새 필드가 늘 한쪽에만 붙고,
 *  돌아온 사람 화면에서만 문이나 증거가 빠진 채로 나온다.
 *
 * @param {object|null} self  돌아온 대원. 주면 그 사람 몫의 현재 상태를 같이 싣는다.
 */
function matchStatePayload(room, self = null) {
  return {
    protocol: GAME_PROTOCOL,
    endsAt: room.endsAt,
    // defused 는 이어 들어온 화면이 이미 해체된 지점을 꺼진 채로 그리는 데 쓴다.
    sites: room.sites.map((s) => ({ id: s.id, x: s.x, z: s.z, label: s.label, defused: !!s.defused })),
    evidence: room.evidence.map((e) => ({ id: e.id, x: e.x, z: e.z, label: e.label, taken: !!e.taken })),
    defuseSeconds: DEFUSE_SECONDS,
    extraction: EXTRACTION,
    doors: room.doors.snapshot(),
    npcs: room.npcs.map(npcPublic),
    objectives: objectiveReport(room),
    phase: room.phase,
    generatorStarted: room.generatorStarted,
    power: room.power,          // 재접속 시에도 정전/복구 상태를 전달한다
    grenades: GRENADES,
    grenadeOrder: GRENADE_ORDER,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, slot: p.slot, weapon: p.weapon,
      x: p.x, z: p.z, yaw: p.yaw, connected: p.connected,
    })),
    weapons: WEAPONS,
    shotProtocol: 2,
    ...(self ? {
      resumed: true,
      self: {
        id: self.id, hp: self.hp, alive: self.alive, downed: self.downed,
        weapon: self.weapon, ammo: self.ammo, reserve: self.reserve,
        grenades: self.grenades, sel: self.selectedGrenade,
        x: self.x, y: self.y, z: self.z, yaw: self.yaw, pitch: self.pitch,
        kills: self.kills, arrests: self.arrests, rescues: self.rescues,
      },
    } : null),
  };
}

function startMatch(room, io) {
  room.resetMission();
  setupMission(room);
  room.state = 'active';
  room.endsAt = now() + MISSION_TIME_MS;

  let i = 0;
  for (const p of room.players.values()) {
    const spawn = SPAWNS[i % SPAWNS.length];
    p.x = spawn.x; p.z = spawn.z; p.y = 0; p.yaw = spawn.yaw; p.pitch = 0;
    p.hp = PLAYER_MAX_HP; p.alive = true; p.downed = false; p.dead = false;
    p.kills = 0; p.arrests = 0; p.rescues = 0;
    p.ammo = WEAPONS[p.weapon].mag;
    p.reserve = WEAPONS[p.weapon].reserve;
    p.reloadUntil = 0; p.defusing = null; p.interacting = null; p.interactProgress = 0;
    p.grenades = startingGrenades();
    p.selectedGrenade = 'flash';
    p.blindUntil = 0; p.gas = 0; p.lastShout = 0;
    p.lastShot = 0; p.moving = p.sprint = p.crouch = 0;
    p.inputSeq = p.shotSeq = 0;
    p.shotCredit = 1; p.creditTime = now();
    i++;
  }

  io.to(room.code).emit('matchStart', matchStatePayload(room));
  io.to(room.code).emit('radio', { text: MISSION.entry });

  if (room.timer) clearInterval(room.timer);
  room.lastTick = now();
  room.timer = setInterval(() => tickRoom(room, io), TICK_MS);
}


/* ========================================================================== *
 *  HTTP + Socket.io
 * ========================================================================== */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, file) {
    if (/\.(?:html|js)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
// three.js 를 CDN 없이 로컬에서 서빙 (오프라인/기내에서도 동작)
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three')));

/*
 * 상태 확인.
 *
 * 예전에 화면(Vercel)과 게임 서버(Render)가 서로 다른 커밋으로 떠 있어서
 * 시작 위치와 문 이벤트가 어긋난 적이 있다. 그때 무엇이 떠 있는지 알 방법이
 * /health 에 없었다. Render 가 넣어 주는 커밋/브랜치를 같이 돌려준다.
 */
app.get('/health', (_req, res) => res.json({
  ok: true,
  rooms: rooms.size,
  protocol: GAME_PROTOCOL,
  commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'local',
  branch: process.env.RENDER_GIT_BRANCH || 'local',
  startedAt: new Date(STARTED_AT).toISOString(),
}));

io.on('connection', (socket) => {
  socket.on('protocol', (_payload, cb) => cb?.({ protocol: GAME_PROTOCOL }));
  let room = null;
  let me = null;

  /** 완전히 나간다. 스스로 나가기를 눌렀거나, 경기 중이 아닐 때 끊긴 경우. */
  const leave = () => {
    if (!room || !me) { room = null; me = null; return; }
    const id = me.id;
    cancelBriefing(room, io);
    room.removePlayer(id);
    socket.leave(room.code);
    io.to(room.code).emit('lobby', room.lobbyState());
    io.to(room.code).emit('playerLeft', { id });
    if (room.players.size === 0) {
      closeRoom(room);
    } else {
      checkMissionEnd(room, io);
    }
    room = null; me = null;
  };

  /**
   * 경기 중에 끊겼다. 자리를 비워 두고 기다린다.
   *
   *  여기서 removePlayer 를 부르지 않는 것이 이 기능의 전부다. 예전에는
   *  disconnect 가 곧바로 leave 였고, 그래서 1초 순단이 영구 퇴장이었다.
   */
  const holdOrLeave = () => {
    if (!room || !me) { room = null; me = null; return; }
    if (room.state !== 'active') { leave(); return; }
    const held = me;
    room.holdPlayer(held);
    socket.leave(room.code);
    announceHold(room, held, io);
    room = null; me = null;
  };

  /* ---- 방 만들기 / 들어가기 -------------------------------------------- */
  socket.on('createRoom', ({ name, weapon } = {}, cb) => {
    leave();
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();
    room = new Room(code);
    rooms.set(code, room);
    me = room.addPlayer(socket, name, weapon);
    socket.join(code);
    cb?.({ ok: true, you: me.id, lobby: room.lobbyState() });
    io.to(code).emit('lobby', room.lobbyState());
  });

  socket.on('joinRoom', ({ code, name, weapon } = {}, cb) => {
    const key = String(code || '').toUpperCase().trim();
    const r = rooms.get(key);
    if (!r) return cb?.({ ok: false, error: '그런 방 코드가 없어요.' });
    if (room === r && me?.connected) return cb?.({ ok: true, you: me.id, lobby: room.lobbyState() });

    /* 같은 이름이 자리를 비워 두고 있으면 새 소켓을 그 자리에 이어 붙인다.
     * 인원 수·진행 중 검사보다 먼저 본다 — 돌아오는 사람은 새로 들어오는
     * 사람이 아니라 원래 있던 사람이고, 방이 꽉 찼다는 말은 그의 자리까지
     * 세어서 나온 말이기 때문이다. */
    const held = r.findHeldByName(name);
    if (held) {
      leave();
      room = r;
      me = held;
      me.socketId = socket.id;
      me.connected = true;
      me.disconnectedAt = 0;
      if (!room.hostId) room.hostId = me.id;
      socket.join(room.code);
      cb?.({ ok: true, you: me.id, resumed: true, lobby: room.lobbyState() });
      io.to(room.code).emit('lobby', room.lobbyState());
      io.to(room.code).emit('playerRejoined', { id: me.id, name: me.name });
      if (room.state === 'active') {
        // 진행 중인 판을 통째로 다시 실어 준다. 시작 때와 같은 페이로드다.
        socket.emit('matchStart', matchStatePayload(room, me));
        io.to(room.code).emit('radio', { text: `무전: ${me.name} 복귀. 대열에 합류했다.` });
      }
      return;
    }

    if (r.players.size >= 4) return cb?.({ ok: false, error: '방이 꽉 찼어요 (최대 4명).' });
    if (r.state === 'active' || r.state === 'briefing') return cb?.({ ok: false, error: '이미 작전이 진행 중이에요.' });
    leave();
    room = r;
    me = room.addPlayer(socket, name, weapon);
    socket.join(room.code);
    cb?.({ ok: true, you: me.id, lobby: room.lobbyState() });
    io.to(room.code).emit('lobby', room.lobbyState());
  });

  socket.on('setLoadout', ({ weapon, ready } = {}) => {
    if (!me || !room || room.state === 'active' || room.state === 'briefing') return;
    if (weapon && WEAPONS[weapon]) {
      me.weapon = weapon;
      me.ammo = WEAPONS[weapon].mag;
      me.reserve = WEAPONS[weapon].reserve;
    }
    if (typeof ready === 'boolean') me.ready = ready;
    io.to(room.code).emit('lobby', room.lobbyState());
  });

  socket.on('setRoomConfig', ({ botCount, difficulty } = {}) => {
    if (!room || !me || room.hostId !== me.id || room.state === 'active' || room.state === 'briefing') return;
    if (botCount) room.botCount = clamp(botCount | 0, 3, 14);
    if (difficulty && DIFFICULTY[difficulty]) room.difficulty = difficulty;
    io.to(room.code).emit('lobby', room.lobbyState());
  });

  socket.on('startMatch', () => {
    if (!room || !me || room.hostId !== me.id) return;
    if (room.state === 'active' || room.state === 'briefing') return;
    if (!room.connectedPlayers.every((p) => p.ready)) return;
    beginBriefing(room, io);
  });

  socket.on('briefingReady', ({ id } = {}) => {
    if (!room || !me || room.state !== 'briefing' || id !== room.briefingId) return;
    me.briefingReady = true;
    io.to(room.code).emit('lobby', room.lobbyState());
    if (room.connectedPlayers.every((p) => p.briefingReady)) startMatch(room, io);
  });

  socket.on('cancelBriefing', () => {
    if (!room || !me || room.hostId !== me.id || room.state !== 'briefing') return;
    cancelBriefing(room, io);
    io.to(room.code).emit('lobby', room.lobbyState());
  });

  /* ---- 인게임 ---------------------------------------------------------- */
  socket.on('input', (d) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return;
    applyPlayerInput(room, me, d);
  });

  socket.on('shoot', (d, cb) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return cb?.({ ok: false });
    const reply = (result) => cb?.({ ammo: me.ammo, shotSeq: me.shotSeq, ...result });
    if (d?.shotId !== undefined) {
      if (!Number.isSafeInteger(d.shotId) || d.shotId <= me.shotSeq) return reply({ ok: false, reason: 'stale' });
      me.shotSeq = d.shotId;
    }
    if (!d || !['dx', 'dy', 'dz'].every((k) => Number.isFinite(d[k]))) return reply({ ok: false });
    const length = Math.hypot(d.dx, d.dy, d.dz);
    if (length < 0.00001) return reply({ ok: false });
    const w = WEAPONS[me.weapon], t = now();
    if (me.reloadUntil > 0) return reply({ ok: false, reason: 'reloading' });
    if (me.ammo <= 0) return reply({ ok: false, reason: 'empty' });
    // 작은 크레딧 통을 두어 몰려온 패킷을 허용하되 지속 연사 속도는 올리지 않는다.
    me.shotCredit = Math.min(3, (me.shotCredit ?? 1) + (t - (me.creditTime ?? t)) / (60000 / w.rpm));
    me.creditTime = t;
    if (me.shotCredit < 1) return reply({ ok: false, reason: 'rate' });
    me.shotCredit--;
    if (d.input) applyPlayerInput(room, me, d.input);
    me.lastShot = t;
    me.ammo--;
    const origin = { x: me.x, y: me.y + PLAYER_EYE - (me.crouch ? 0.45 : 0), z: me.z };
    const dir = { x: d.dx / length, y: d.dy / length, z: d.dz / length };
    const res = resolveShot(room, me, origin, dir, io, d.viewTime);
    io.to(room.code).emit('playerShot', {
      id: me.id, weapon: me.weapon, x: origin.x, y: origin.y, z: origin.z,
      dx: dir.x, dy: dir.y, dz: dir.z, dist: res.dist, hit: res.hit,
    });
    emitNoise(room, me.x, me.z, NOISE.shot, 'shot', me.id);
    reply({ ok: true, ...res });
  });

  socket.on('reload', () => {
    if (!me || !room || room.state !== 'active' || !me.alive) return;
    const w = WEAPONS[me.weapon];
    if (me.reloadUntil > 0 || me.ammo >= w.mag || me.reserve <= 0) return;
    me.reloadUntil = now() + w.reload * 1000;
    emitNoise(room, me.x, me.z, NOISE.reload, 'reload', me.id);
    io.to(room.code).emit('playerReload', { id: me.id, duration: w.reload, ...at3(me) });
  });

  socket.on('defuse', ({ siteId, active } = {}) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return;
    me.defusing = active ? siteId : null;
  });

  /* ---- 문 -------------------------------------------------------------- */
  socket.on('door', ({ id, action } = {}, cb) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return cb?.({ ok: false });
    const door = room.doors.get(id);
    if (!door) return cb?.({ ok: false, error: 'no-door' });
    // 화면의 안내와 같은 자(doorDistance)로 잰다. 여유 0.6m 는 입력이 서버에
    // 닿는 사이에 움직인 만큼을 봐 주는 값이다.
    if (doorDistance(door, me.x, me.z) > DOOR_REACH + 0.6) return cb?.({ ok: false, error: 'far' });
    const spec = DOOR_ACTIONS[action];
    const next = room.doors.resultOf(door, action);
    if (!spec || !next) return cb?.({ ok: false, error: 'not-allowed' });
    if (now() < (me.doorBusyUntil || 0)) return cb?.({ ok: false, error: 'busy' });
    me.doorBusyUntil = now() + spec.seconds * 1000;

    if (action === 'peek') {
      // 문틈 확인: 반대편에 사람이 있는지만 알려 준다. 몇 명인지, 어디인지는 모른다.
      emitNoise(room, door.x, door.z, spec.noise, 'peek', me.id);
      const behind = room.npcs.filter((n) => n.alive
        && Math.hypot(n.x - door.x, n.z - door.z) < 7
        && ((door.axis === 'x') ? (n.x - door.x) * (door.x - me.x) > 0 : (n.z - door.z) * (door.z - me.z) > 0));
      return cb?.({
        ok: true, action,
        contacts: behind.length === 0 ? 'none' : behind.length === 1 ? 'one' : 'several',
        armed: behind.some((n) => n.kind !== 'civilian' && n.state !== 'surrender'),
        state: door.state,
      });
    }

    queueDoorAction(room, door, action, spec, next, me.id, io);
    return cb?.({ ok: true, action, state: next, seconds: spec.seconds });
  });

  /* ---- 투척 장비 ------------------------------------------------------- */
  socket.on('selectGrenade', ({ type } = {}) => {
    if (!me || !GRENADES[type]) return;
    me.selectedGrenade = type;
  });

  socket.on('throw', ({ type, dx, dy, dz, power } = {}, cb) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return cb?.({ ok: false });
    if (now() < me.blindUntil) return cb?.({ ok: false, error: 'blind' });
    if (![dx, dy, dz].every(Number.isFinite)) return cb?.({ ok: false });
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.00001) return cb?.({ ok: false });
    if (now() < (me.throwBusyUntil || 0)) return cb?.({ ok: false, error: 'busy' });
    const kind = GRENADES[type] ? type : me.selectedGrenade;
    const ok = throwGrenade(room, me, kind,
      { x: dx / length, y: dy / length, z: dz / length }, clamp(+power || 1, 0.3, 1), io);
    if (ok) me.throwBusyUntil = now() + 700;
    cb?.({ ok, grenades: me.grenades });
  });

  socket.on('shout', (payload) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return;
    const line = Number(payload?.line);
    shout(room, me, io, Number.isInteger(line) && line >= 0 && line < 16 ? line : 0);
  });

  socket.on('ping:rtt', (t0, cb) => cb?.(t0));

  socket.on('leaveRoom', leave);
  socket.on('disconnect', holdOrLeave);
});

/* 테스트가 서버를 띄우지 않고 부품만 꺼내 쓸 수 있게 다시 내보낸다. */
export { Room, rooms } from './server/room.js';
export { tickRoom } from './server/tick.js';
export { updateInteractions } from './server/interactions.js';
export { dropExpiredHolds } from './server/mission.js';
export { RECONNECT_GRACE_MS } from './server/constants.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) server.listen(PORT, () => {
  console.log('');
  console.log('  ███  RAVENWOOD : 긴 밤  ███');
  console.log(`  구역: ${MAP.name}  (${MAP.width}m x ${MAP.depth}m, 충돌박스 ${COLLIDERS.length}개, 방 ${ROOMS.length}개)`);
  console.log(`  단계 ${PHASES.length}개 · 제한 시간 ${MISSION_TIME_MS / 60000}분`);
  console.log(`  서버 준비됨 ->  http://localhost:${PORT}`);
  console.log('  같은 와이파이의 폰에서는 PC의 내부 IP로 접속하세요 (예: http://192.168.0.10:' + PORT + ')');
  console.log('');
});
