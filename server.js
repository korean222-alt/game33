/* =============================================================================
 *  server.js  -  Express + Socket.io 게임 서버 (권위 서버)
 *
 *  역할
 *    1) public/ 정적 서빙 + node_modules/three 를 /vendor/three 로 서빙
 *    2) 방(room) 관리 - 방 코드로 2~4인 입장
 *    3) 저택 구역 시뮬레이션: 문, 용의자, 민간인, 투척 장비, 5단계 목표
 *    4) 사격 판정 / 피해 / 교전 규칙 위반 / 등급 평가
 *
 *  클라이언트는 자기 이동만 예측하고 나머지는 전부 여기서 결정한다.
 *
 *  실행: npm install && npm start   ->  http://localhost:3000
 * ========================================================================== */

import express from 'express';
import { resetPower, powerCutDue, restorePower } from './public/js/power-state.js';
import { GAME_PROTOCOL } from './public/js/protocol.js';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import {
  MAP, BACKUP_GENERATOR, COLLIDERS, SPAWNS, BOMB_SITES, POSTS, CIVILIAN_SPOTS, EVIDENCE_SPOTS,
  HVT_ROOMS, EXTRACTION, LIGHTS, COVER_POINTS, ROOMS,
  resolveCircle, rayObstacleDistance, findRoute, isIndoors, zoneAt,
} from './public/js/map-data.js';
import {
  DOOR, DoorSet, rollDoorStates, ensureQuietEntry, DOOR_ACTIONS, DOOR_REACH, isBlocking,
  doorDistance,
} from './public/js/doors.js';
import { NOISE, brightnessAt, hasClearShot, inFieldOfView } from './public/js/perception.js';
import {
  createSuspect, createCivilian, updateSuspect, updateCivilian, deliverNoise,
  planOccupancy, warnSuspect, WARNING, SUSPECT_EYE, SUSPECT_RADIUS,
} from './public/js/suspect-ai.js';
import {
  GRENADES, GRENADE_ORDER, createGrenade, stepGrenade, flashStrength, flashSeconds, fragDamage,
  gasIntensity, startingGrenades,
} from './public/js/grenades.js';
import { traceShot, TargetHistory } from './public/js/shot-trace.js';
import { PHASES, MISSION } from './public/js/mission-story.js';
import { objectiveReport, phaseComplete, missedObjectives } from './public/js/objectives.js';
import { scoreMission, gradeAdvice } from './public/js/scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();

/* ========================================================================== *
 *  튜닝 상수
 * ========================================================================== */
const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;

const PLAYER_RADIUS = 0.32;
const PLAYER_MAX_HP = 100;
const PLAYER_EYE = 1.62;

const SUSPECT_MAX_HP = 100;
const SUSPECT_DAMAGE = 13;

const MISSION_TIME_MS = 22 * 60 * 1000;
const DEFUSE_SECONDS = 8;
const DEFUSE_RANGE = 1.8;
const INTERACT_RANGE = 2.0;
const ARREST_SECONDS = 2.2;
const SECURE_SECONDS = 1.6;
const REVIVE_SECONDS = 4.0;
const EVIDENCE_SECONDS = 1.4;
const BLEED_OUT_MS = 75000;
const SHOUT_COOLDOWN = 1600;
const REINFORCE_DELAY_MS = 14000;
const REINFORCE_COUNT = 3;

const WEAPONS = {
  rifle: { name: 'M416', mag: 30, reserve: 150, rpm: 700, damage: 26, headMul: 2.2, range: 60, reload: 2.3 },
  smg: { name: 'UMP9', mag: 25, reserve: 150, rpm: 600, damage: 21, headMul: 2.0, range: 40, reload: 2.0 },
  sniper: { name: 'AWM', mag: 5, reserve: 30, rpm: 45, damage: 95, headMul: 1.5, range: 80, reload: 3.2 },
};

const DIFFICULTY = {
  easy: { hpMul: 0.75, dmgMul: 0.7, skill: 0.78, reactMul: 1.45, moraleMul: 1.25 },
  normal: { hpMul: 1.0, dmgMul: 1.0, skill: 1.0, reactMul: 1.0, moraleMul: 1.0 },
  hard: { hpMul: 1.25, dmgMul: 1.25, skill: 1.22, reactMul: 0.78, moraleMul: 0.8 },
};

const OUTDOOR_ZONES = ['COURTYARD', 'WEST YARD', 'EAST YARD', 'GARDEN'];
/* 담장 밖 배선으로 도는 야외등. 저택이 정전돼도 이것만은 남는다. */
const OUTDOOR_LIGHTS = LIGHTS.filter((L) => L.kind === 'lamp');

/* ========================================================================== *
 *  유틸
 * ========================================================================== */
const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** 소리를 낼 위치. 클라이언트가 그 자리에서 들리게 하려면 좌표가 필요하다. */
const at3 = (o) => ({ x: +o.x.toFixed(2), y: +(o.y || 0).toFixed(2), z: +o.z.toFixed(2) });
const pick = (list, random = Math.random) => list[Math.floor(random() * list.length)];

/**
 * 정해진 자리에서 조금 흩어 놓는다.
 *
 * 자리 목록이 고정이면 두 번째 판부터는 "저 방 저 구석" 을 외워서 문을 열자마자
 * 그쪽을 쏘게 된다. 벽에 끼지 않는 선에서 흔들어 매 판 다르게 만든다.
 */
function jitter(spot, random, spread = 1.1, radius = 0.42) {
  const angle = random() * Math.PI * 2;
  const reach = Math.sqrt(random()) * spread;
  const x = spot.x + Math.cos(angle) * reach;
  const z = spot.z + Math.sin(angle) * reach;
  const fixed = resolveCircle(x, z, radius, COLLIDERS, 0, 1.7);
  // 벽에 밀려났으면 원래 자리가 안전하다.
  if (Math.hypot(fixed.x - x, fixed.z - z) > 0.02) return { ...spot };
  if (zoneAt(fixed.x, fixed.z) !== (spot.room || zoneAt(spot.x, spot.z))) return { ...spot };
  return { ...spot, x: +fixed.x.toFixed(2), z: +fixed.z.toFixed(2) };
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(I,O,0,1) 제외
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ========================================================================== *
 *  방 (Room)
 * ========================================================================== */
/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // socketId -> player
    this.state = 'lobby';       // lobby | briefing | active | won | lost
    this.briefingId = 0;
    this.hostId = null;
    /* 방이 17칸이라 6명이면 너무 헐겁다. 기본을 8명으로 둔다
     * (대기실에서 3~14명으로 바꿀 수 있다). */
    this.botCount = 8;
    this.difficulty = 'normal';
    this.timer = null;
    this.lastTick = now();
    this.seq = 0;
    this.resetMission();
  }

  resetMission() {
    this.doors = new DoorSet(rollDoorStates());
    /* 문 상태를 다음 스냅샷에 실을지 여부.
     *
     *  문 36개를 매 틱 보내면 스냅샷의 3분의 1이 문으로 찬다(1,387 / 4,248 바이트).
     *  최초 상태는 matchStart 가, 변경은 doorState 이벤트가 이미 나르므로 매 틱
     *  실리는 배열은 그 둘과 겹친다. 그래도 아주 없애지는 않고, 바뀐 직후 한 번은
     *  전량을 실어 doorState 를 놓친 클라이언트가 스스로 맞춰지게 둔다.
     *  클라이언트는 snap.doors 가 없는 경우를 이미 처리한다(game.js 의 if).
     *
     *  문 묶음을 통째로 갈아 끼우는 자리에서는 반드시 같이 세워야 한다. */
    this.doorsDirty = true;
    this.npcs = [];
    this.grenades = [];
    this.clouds = [];
    this.sites = [];
    this.evidence = [];
    this.phase = 0;
    resetPower(this);
    this.objectiveDone = new Set();
    this.flags = { breached: false, reinforced: false, hvtSeen: false };
    this.stats = {
      phasesCleared: 0, civiliansRescued: 0, civiliansLost: 0, suspectsArrested: 0,
      suspectsNeutralised: 0, evidenceCollected: 0, devicesDefused: 0,
      hostageSaved: false, hostageLost: false, teamLost: 0, roeViolations: 0,
      objectivesMissed: 0, completed: false,
    };
    this.targetHistory = new TargetHistory();
    this.objectiveSignature = '';
    this.endsAt = 0;
    this.nextGrenadeId = 1;
    this.phaseEnteredAt = 0;
    this.doorQueue = [];
  }

  get alivePlayers() { return [...this.players.values()].filter((p) => p.alive); }
  get standingPlayers() { return [...this.players.values()].filter((p) => p.alive && !p.downed); }
  get suspects() { return this.npcs.filter((n) => n.kind !== 'civilian'); }
  get civilians() { return this.npcs.filter((n) => n.kind === 'civilian'); }

  addPlayer(socket, name, weapon) {
    const idx = this.players.size;
    const spawn = SPAWNS[idx % SPAWNS.length];
    const wk = WEAPONS[weapon] ? weapon : 'rifle';
    const p = {
      id: socket.id,
      name: (name || '대원').slice(0, 12),
      slot: idx,
      x: spawn.x, y: 0, z: spawn.z,
      yaw: spawn.yaw, pitch: 0,
      hp: PLAYER_MAX_HP,
      alive: true, downed: false, downedAt: 0,
      ready: false,
      weapon: wk,
      ammo: WEAPONS[wk].mag,
      reserve: WEAPONS[wk].reserve,
      reloadUntil: 0,
      lastShot: 0,
      moving: 0, sprint: 0, crouch: 0,
      inputSeq: 0, shotSeq: 0, briefingReady: false,
      defusing: null, interacting: null, interactProgress: 0,
      grenades: startingGrenades(), selectedGrenade: 'flash',
      blindUntil: 0, gas: 0, lastShout: 0,
      doorAction: null,
      kills: 0, arrests: 0, rescues: 0,
      ping: 0,
    };
    this.players.set(socket.id, p);
    if (!this.hostId) this.hostId = socket.id;
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.hostId === id) this.hostId = this.players.keys().next().value || null;
  }

  lobbyState() {
    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      botCount: this.botCount,
      difficulty: this.difficulty,
      briefingId: this.briefingId,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, slot: p.slot, ready: p.ready,
        weapon: p.weapon, briefingReady: p.briefingReady,
      })),
    };
  }
}

/* ========================================================================== *
 *  임무 구성 (매번 조금씩 달라진다)
 * ========================================================================== */
function setupMission(room) {
  const random = Math.random;
  const diff = DIFFICULTY[room.difficulty] || DIFFICULTY.normal;

  // 문 상태를 새로 뽑되, 조용히 들어갈 수 있는 진입구는 최소 하나 남긴다.
  room.doors = new DoorSet(ensureQuietEntry(rollDoorStates(random), random));
  room.doorsDirty = true;

  // --- 용의자 배치: 방마다 있을 수도, 없을 수도 ---
  //
  // 시작하자마자 총을 맞으면 플레이어가 배울 것이 없다. 집결 지점을 이미
  // 정면으로 보고 있는 자리는 배치에서 뺀다. 소리를 내거나 시야에 들어가면
  // 그때부터 발견되는 것은 그대로다.
  room.npcs = [];
  const colliders = room.doors.colliders();
  const watchesSpawn = (post) => SPAWNS.some((spawn) =>
    dist2D(post, spawn) < 18
    && inFieldOfView({ x: post.x, z: post.z, yaw: post.yaw ?? 0 }, spawn, Math.PI * 0.78)
    && hasClearShot({ x: post.x, y: SUSPECT_EYE, z: post.z }, { x: spawn.x, y: 0, z: spawn.z }, 1.3, colliders));
  const usablePosts = POSTS.filter((post) => !watchesSpawn(post));
  const plan = planOccupancy(usablePosts, room.botCount, random);
  plan.forEach((entry, i) => {
    const post = jitter(entry.post, random, 1.3, SUSPECT_RADIUS);
    post.yaw = (entry.post.yaw ?? 0) + (random() - 0.5) * 1.2;
    const suspect = createSuspect(`sus_${i}`, {
      post,
      personality: entry.personality,
      hp: Math.round(SUSPECT_MAX_HP * diff.hpMul),
    });
    suspect.origin = OUTDOOR_ZONES.includes(entry.post.room) ? 'outdoor' : 'indoor';
    suspect.morale = clamp(1 * diff.moraleMul, 0.4, 1.2);
    // 시작 직후 전원이 동시에 두리번거리지 않도록 시선 변경 시점을 흩뜨린다.
    suspect.stateUntil = now() + 3500 + random() * 5000;
    room.npcs.push(suspect);
  });

  // --- 주요 용의자와 인질 ---
  // 방도, 그 방 안의 자리도 매 판 다시 뽑는다. 인질이 어디에 있는지는
  // 문을 열어 보기 전에는 알 수 없어야 한다.
  const hvtRoom = pick(HVT_ROOMS, random);
  const hvtPosts = POSTS.filter((p) => p.room === hvtRoom);
  const basePost = hvtPosts.length ? pick(hvtPosts, random) : POSTS[0];
  const hvtPost = jitter(basePost, random, 1.4, SUSPECT_RADIUS);
  hvtPost.yaw = (basePost.yaw ?? 0) + (random() - 0.5) * 1.6;
  const hvt = createSuspect('hvt', {
    post: hvtPost, personality: 'leader', kind: 'hvt',
    hp: Math.round(140 * diff.hpMul),
  });
  hvt.origin = 'indoor';
  hvt.hostage = 'hostage';
  room.npcs.push(hvt);
  room.hvtRoom = hvtRoom;

  // 인질은 주범과 같은 방의 다른 자리. 그 방에 정해진 자리가 없으면 주범 옆.
  const roomSpots = CIVILIAN_SPOTS.filter((s) => s.room === hvtRoom);
  const hostageBase = roomSpots.length
    ? pick(roomSpots, random)
    : { room: hvtRoom, x: hvtPost.x + (random() - 0.5) * 2, z: hvtPost.z + (random() - 0.5) * 2 };
  const hostageSpot = jitter(hostageBase, random, 0.9);
  const hostage = createCivilian('hostage', hostageSpot);
  hostage.hostage = true;
  hostage.state = 'comply';
  hostage.hands = 1;
  hostage.panic = 0.9;
  room.npcs.push(hostage);

  // --- 나머지 민간인 ---
  // 주범의 방은 비워 둔다. 인질 옆에 다른 민간인이 서 있으면 누구를 구해야
  // 하는지 헷갈린다.
  const spots = CIVILIAN_SPOTS
    .filter((s) => s !== hostageBase && s.room !== hvtRoom)
    .sort(() => random() - 0.5);
  const civilianCount = 2 + Math.floor(random() * 3);
  const usedRooms = new Set();
  for (const spot of spots) {
    if (room.npcs.filter((n) => n.kind === 'civilian' && n.id !== 'hostage').length >= civilianCount) break;
    if (usedRooms.has(spot.room)) continue;    // 한 방에 한 명씩 흩어 놓는다
    usedRooms.add(spot.room);
    room.npcs.push(createCivilian(`civ_${usedRooms.size - 1}`, jitter(spot, random, 1.0)));
  }

  // --- 장치와 증거 ---
  room.sites = BOMB_SITES.map((s) => ({ ...s, progress: 0, defused: false, activeBy: [] }));
  room.evidence = [...EVIDENCE_SPOTS].sort(() => random() - 0.5).slice(0, 3)
    .map((e) => ({ ...jitter(e, random, 0.7, 0.3), taken: false }));

  room.phase = 0;
  room.phaseEnteredAt = now();
  room.objectiveDone = new Set();
  room.targetHistory = new TargetHistory();
  room.targetHistory.record(now(), room.npcs);
}

/* ========================================================================== *
 *  소리
 * ========================================================================== */
function emitNoise(room, x, z, level, type, byId = null) {
  const event = { x, z, level, type, by: byId, t: now() };
  const colliders = room.doors.colliders();
  for (const npc of room.npcs) {
    if (!npc.alive) continue;
    deliverNoise(npc, event, colliders);
  }
  return event;
}

/* ========================================================================== *
 *  NPC 구동에 필요한 world 인터페이스
 * ========================================================================== */
function makeWorld(room, dt, io) {
  const colliders = room.doors.colliders();
  const diff = DIFFICULTY[room.difficulty] || DIFFICULTY.normal;
  const t = now();
  const players = room.standingPlayers.map((p) => ({
    id: p.id, x: p.x, y: p.y, z: p.z, alive: true,
    crouch: !!p.crouch, moving: !!p.moving, sprint: !!p.sprint, hp: p.hp,
    // 손전등을 켜고 있으면 어둠 속에서도 훨씬 먼저 발견된다.
    light: !!p.light,
  }));
  const downCount = room.suspects.filter((s) => !s.alive || s.arrested || s.state === 'surrender').length;

  return {
    now: t, dt, colliders, doors: room.doors, players,
    skillScale: diff.skill,
    alliesDown: downCount,
    alliesNear: 0,
    random: Math.random,
    /* 저택 전기가 끊기면 실내등은 계산에서 빠진다. 그래서 정전 뒤에는
     * 실내에서 서로가 잘 안 보인다 - 적도, 나도. */
    brightness: (x, z) => brightnessAt(x, z, room.power ? LIGHTS : OUTDOOR_LIGHTS),
    playerById: (id) => players.find((p) => p.id === id) || null,
    nearestPlayer: (npc) => {
      let best = null, bestD = Infinity;
      for (const p of players) {
        const d = dist2D(npc, p);
        if (d < bestD) { best = p; bestD = d; }
      }
      return best;
    },
    route: (from, to) => findRoute(from, to),
    /** 소리가 내 방 문 근처에서 났는가 (매복 판단). */
    doorNear: (point, roomName) => room.doors.doors.some((door) =>
      door.link.includes(roomName) && Math.hypot(door.x - point.x, door.z - point.z) < 3.2),
    roamPoint: (roomName, npc) => {
      const candidates = POSTS.filter((p) => p.room === roomName && dist2D(p, npc) > 1.5);
      if (!candidates.length) return null;
      return candidates[Math.floor(Math.random() * candidates.length)];
    },
    hideSpot: (npc) => {
      const inRoom = COVER_POINTS.filter((c) => c.room === npc.room);
      const pool = inRoom.length ? inRoom : COVER_POINTS;
      let best = null, bestScore = -Infinity;
      for (const c of pool) {
        const score = -dist2D(npc, c) + Math.random() * 3;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      return best;
    },
    fallbackPoint: (npc) => {
      const away = POSTS.filter((p) => p.room !== npc.room && !OUTDOOR_ZONES.includes(p.room));
      if (!away.length) return null;
      const threat = npc.lastSeen || npc;
      return away.sort((a, b) => dist2D(b, threat) - dist2D(a, threat))[Math.floor(Math.random() * 3) % away.length];
    },
    openDoor: (npc, door) => {
      if (!isBlocking(door.state)) return;
      const next = door.state === DOOR.CLOSED ? DOOR.OPEN
        : door.state === DOOR.LOCKED ? DOOR.OPEN : null;
      if (!next) { npc.routeUntil = 0; npc.route = null; return; }
      setDoorState(room, door.id, next, io);
      emitNoise(room, door.x, door.z, NOISE.doorOpen, 'door', npc.id);
    },
    noise: (x, z, level, type, by) => emitNoise(room, x, z, level, type, by),
    fire: (npc, target, hit) => {
      const player = room.players.get(target.id);
      io.to(room.code).emit('npcShot', {
        id: npc.id, x: npc.x, y: npc.y + SUSPECT_EYE, z: npc.z,
        tx: target.x, ty: (target.y || 0) + (target.crouch ? 1.05 : PLAYER_EYE - 0.2), tz: target.z, hit,
      });
      if (!player || !hit) {
        if (player) player.suppressedAt = t;
        return;
      }
      const dmg = Math.round(SUSPECT_DAMAGE * diff.dmgMul * (0.85 + Math.random() * 0.35));
      damagePlayer(room, player, dmg, npc.id, io, npc);
    },
    onStateChange: (npc) => { npc.dirty = true; },
    onContact: (npc, target) => {
      // 발견을 외치면 주변 동료도 경계에 들어간다.
      for (const other of room.suspects) {
        if (other === npc || !other.alive) continue;
        if (dist2D(other, npc) > 16) continue;
        other.lastHeard = { x: npc.lastSeen?.x ?? npc.x, z: npc.lastSeen?.z ?? npc.z, t, level: 0.5, type: 'contact' };
      }
      // 발각된 대원에게는 어느 쪽에서 발각됐는지 알린다. 밤이라 사람이 먼저
      // 보이지 않는 경우가 많아서, 이 신호가 없으면 총알이 어디서 오는지
      // 알 방법이 없다.
      if (target?.id) {
        io.to(target.id).emit('spotted', {
          id: npc.id, kind: npc.kind,
          x: +npc.x.toFixed(2), z: +npc.z.toFixed(2),
        });
      }
    },
    onSurrender: (npc) => {
      io.to(room.code).emit('npcSurrender', { id: npc.id, ...at3(npc) });
      io.to(room.code).emit('radio', { text: '무전: 한 명이 무기를 버렸다. 체포해라.' });
    },
    // 경고를 듣고도 덤비는 자. 화면과 소리로 바로 알려 줘야 대응할 수 있다.
    onDefy: (npc) => {
      // holdingHostage: 인질을 붙잡고 버티는 자 (인질 본인이 아니다)
      io.to(room.code).emit('npcDefy', {
        id: npc.id, holdingHostage: npc.kind !== 'civilian' && !!npc.hostage, ...at3(npc),
      });
    },
  };
}

/* ========================================================================== *
 *  문
 * ========================================================================== */
function setDoorState(room, id, state, io) {
  if (!room.doors.setState(id, state)) return false;
  room.doorsDirty = true;
  io.to(room.code).emit('doorState', { id, state });
  return true;
}

/** 문 동작은 시간이 걸린다. 소리는 즉시 나고 상태는 나중에 바뀐다. */
function queueDoorAction(room, door, action, spec, state, byId, io) {
  emitNoise(room, door.x, door.z, spec.noise, `door-${action}`, byId);
  io.to(room.code).emit('doorAction', { id: door.id, action, by: byId, seconds: spec.seconds });
  room.doorQueue.push({ id: door.id, state, at: now() + spec.seconds * 1000 });
}

function updateDoorQueue(room, io) {
  const t = now();
  for (let i = room.doorQueue.length - 1; i >= 0; i--) {
    if (t < room.doorQueue[i].at) continue;
    const entry = room.doorQueue.splice(i, 1)[0];
    setDoorState(room, entry.id, entry.state, io);
  }
}

/* ========================================================================== *
 *  피해 / 사망
 * ========================================================================== */
function damagePlayer(room, player, dmg, byId, io, from = null) {
  if (!player.alive) return;
  player.hp = Math.max(0, player.hp - dmg);
  io.to(room.code).emit('playerHit', {
    id: player.id, hp: player.hp, dmg, by: byId,
    // 맞은 방향. 어두운 실내에서 사수를 못 봤을 때 유일한 단서다.
    ...(from ? { fx: +from.x.toFixed(2), fz: +from.z.toFixed(2) } : {}),
  });

  if (player.hp === 0) {
    player.alive = false;
    player.downed = true;
    player.downedAt = now();
    player.defusing = null;
    player.interacting = null;
    emitNoise(room, player.x, player.z, NOISE.bodyFall, 'fall', player.id);
    io.to(room.code).emit('playerDown', { id: player.id, by: byId, revivable: true, ...at3(player) });
    checkMissionEnd(room, io);
  }
}

function killPlayer(room, player, io) {
  player.downed = false;
  player.alive = false;
  player.dead = true;
  io.to(room.code).emit('playerDead', { id: player.id, ...at3(player) });
  checkMissionEnd(room, io);
}

/** 교전 규칙 위반 기록. */
function roeViolation(room, byId, reason, io) {
  room.stats.roeViolations++;
  io.to(room.code).emit('roeViolation', { by: byId, reason });
  io.to(room.code).emit('radio', { text: `지휘부: 교전 규칙 위반 기록됨 — ${reason}` });
}

function damageNpc(room, npc, dmg, byId, io, part = 'body') {
  if (!npc || !npc.alive) return;
  const shooter = room.players.get(byId);

  if (npc.kind === 'civilian') {
    // 민간인 사격은 그 자체로 규칙 위반이다.
    npc.hp = Math.max(0, npc.hp - dmg);
    io.to(room.code).emit('npcHit', {
      id: npc.id, hp: npc.hp, dmg, by: byId, kind: 'civilian', ...at3(npc),
    });
    roeViolation(room, byId, '민간인 사격', io);
    if (npc.hp === 0) {
      npc.alive = false;
      if (npc.hostage) { room.stats.hostageLost = true; room.stats.hostageSaved = false; }
      else room.stats.civiliansLost++;
      io.to(room.code).emit('npcDown', { id: npc.id, by: byId, civilian: true, ...at3(npc) });
    } else {
      npc.panic = 1;
    }
    return;
  }

  const wasYielding = npc.state === 'surrender' || npc.arrested;
  if (wasYielding) roeViolation(room, byId, '항복한 대상 사격', io);

  npc.hp = Math.max(0, npc.hp - dmg);
  npc.suppression = Math.min(1, npc.suppression + 0.5);
  io.to(room.code).emit('npcHit', {
    id: npc.id, hp: npc.hp, dmg, by: byId, part, kind: npc.kind, ...at3(npc),
  });

  if (npc.hp === 0) {
    npc.alive = false;
    npc.state = 'dead';
    npc.moving = 0;
    if (!wasYielding) room.stats.suspectsNeutralised++;
    if (shooter) shooter.kills++;
    emitNoise(room, npc.x, npc.z, NOISE.bodyFall, 'fall', npc.id);
    io.to(room.code).emit('npcDown', { id: npc.id, by: byId, kind: npc.kind, ...at3(npc) });
    if (npc.hostage) {
      const hostage = room.npcs.find((n) => n.id === 'hostage');
      if (hostage) { hostage.hostage = false; hostage.state = 'comply'; hostage.hands = 1; }
    }
    // 동료가 쓰러지는 것을 본 적은 사기가 꺾인다.
    for (const other of room.suspects) {
      if (other === npc || !other.alive) continue;
      if (dist2D(other, npc) < 14) other.morale = Math.max(0, other.morale - 0.2);
    }
  } else if (shooter) {
    // 맞으면 즉시 반응하지만, 어디서 맞았는지는 "소리"로만 안다.
    npc.lastHeard = { x: shooter.x, z: shooter.z, t: now(), level: 1, type: 'shot', by: byId };
    npc.morale = Math.max(0, npc.morale - dmg / npc.maxHp * 0.5);
    if (npc.state === 'guard' || npc.state === 'patrol' || npc.state === 'suspicious') {
      npc.state = 'search';
      npc.stateSince = now();
      npc.stateUntil = now() + 6000;
      npc.lastSeen = { x: shooter.x, z: shooter.z, t: now() };
    }
  }
}

/* ========================================================================== *
 *  사격 판정 (서버 권위)
 * ========================================================================== */
function shotTargets(room) {
  return room.npcs.filter((n) => n.alive).map((n) => ({
    id: n.id, x: n.x, y: n.y, z: n.z, alive: true,
  }));
}

function resolveShot(room, shooter, origin, dir, io, viewTime) {
  const w = WEAPONS[shooter.weapon];
  const colliders = room.doors.colliders();
  const targets = room.targetHistory.sample(viewTime, now(), shotTargets(room));
  const hit = traceShot(origin, dir, w.range, targets,
    (o, d, max) => rayObstacleDistance(o, d, max, colliders));
  if (hit.hit) {
    const npc = room.npcs.find((n) => n.id === hit.targetId);
    const damage = Math.round(w.damage * (hit.part === 'head' ? w.headMul : 1));
    damageNpc(room, npc, damage, shooter.id, io, hit.part);
    hit.targetHp = npc ? Math.max(0, npc.hp) : 0;
  }
  return hit;
}

/* ========================================================================== *
 *  투척 장비
 * ========================================================================== */
function throwGrenade(room, player, type, dir, power, io) {
  const spec = GRENADES[type];
  if (!spec || (player.grenades[type] || 0) <= 0) return false;
  player.grenades[type]--;
  const origin = {
    x: player.x + dir.x * 0.45,
    y: player.y + PLAYER_EYE - (player.crouch ? 0.45 : 0) - 0.1,
    z: player.z + dir.z * 0.45,
  };
  const grenade = createGrenade(`g${room.nextGrenadeId++}`, type, origin, dir,
    { by: player.id, power, now: now() });
  room.grenades.push(grenade);
  io.to(room.code).emit('grenadeThrown', {
    id: grenade.id, type, by: player.id,
    x: grenade.x, y: grenade.y, z: grenade.z, explodeAt: grenade.explodeAt,
  });
  return true;
}

function explode(room, grenade, io) {
  const colliders = room.doors.colliders();
  const spec = GRENADES[grenade.type];
  const at = { x: grenade.x, y: grenade.y, z: grenade.z };
  io.to(room.code).emit('grenadeExploded', { id: grenade.id, type: grenade.type, ...at });
  emitNoise(room, at.x, at.z, spec.noise, grenade.type, grenade.by);

  if (grenade.type === 'flash') {
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      const seconds = flashSeconds(flashStrength(at, p, colliders, p.yaw));
      if (seconds <= 0) continue;
      p.blindUntil = Math.max(p.blindUntil, now() + seconds * 1000);
      io.to(p.id).emit('flashed', { seconds });
    }
    for (const npc of room.npcs) {
      if (!npc.alive) continue;
      // 적도 똑같이 최소 3초는 못 쏜다. 섬광탄을 던지고 들어갈 시간이 나온다.
      const strength = flashStrength(at, npc, colliders, npc.yaw);
      const seconds = flashSeconds(strength);
      if (seconds <= 0) continue;
      npc.blindUntil = Math.max(npc.blindUntil || 0, now() + seconds * 1000);
      npc.suppression = Math.min(1, (npc.suppression || 0) + strength * 0.8);
      npc.morale = Math.max(0, (npc.morale ?? 1) - strength * 0.35);
      if (npc.kind === 'civilian') npc.panic = Math.min(1, npc.panic + strength);
    }
  } else if (grenade.type === 'frag') {
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      const dmg = fragDamage(at, p, colliders);
      if (dmg > 0) damagePlayer(room, p, dmg, grenade.by, io, at);
    }
    for (const npc of room.npcs) {
      if (!npc.alive) continue;
      const dmg = fragDamage(at, npc, colliders);
      if (dmg > 0) damageNpc(room, npc, dmg, grenade.by, io);
    }
  } else if (grenade.type === 'gas') {
    room.clouds.push({
      id: grenade.id, x: at.x, y: at.y, z: at.z,
      until: now() + spec.cloudSeconds * 1000,
    });
    io.to(room.code).emit('gasCloud', { id: grenade.id, x: at.x, y: at.y, z: at.z, seconds: spec.cloudSeconds });
  }
}

function updateGrenades(room, dt, io) {
  const colliders = room.doors.colliders();
  for (let i = room.grenades.length - 1; i >= 0; i--) {
    const grenade = room.grenades[i];
    if (stepGrenade(grenade, dt, colliders, now())) {
      room.grenades.splice(i, 1);
      explode(room, grenade, io);
    }
  }
  for (let i = room.clouds.length - 1; i >= 0; i--) {
    if (now() >= room.clouds[i].until) {
      io.to(room.code).emit('gasCleared', { id: room.clouds[i].id });
      room.clouds.splice(i, 1);
    }
  }
  // 가스 영향
  for (const cloud of room.clouds) {
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      const intensity = gasIntensity(cloud, p, colliders);
      if (intensity > 0.05) p.gas = Math.min(1, p.gas + intensity * dt * 1.6);
    }
    for (const npc of room.npcs) {
      if (!npc.alive) continue;
      const intensity = gasIntensity(cloud, npc, colliders);
      if (intensity > 0.05) {
        npc.gas = Math.min(1, (npc.gas || 0) + intensity * dt * 1.6);
        if (npc.kind === 'civilian') npc.panic = Math.min(1, npc.panic + intensity * dt);
      }
    }
  }
  for (const p of room.players.values()) p.gas = Math.max(0, p.gas - dt * 0.22);
}

/* ========================================================================== *
 *  상호작용 (해체 / 체포 / 확보 / 증거 / 소생)
 * ========================================================================== */
function interactionTarget(room, player) {
  let best = null, bestD = INTERACT_RANGE;
  const consider = (kind, id, point, seconds, label) => {
    const d = dist2D(player, point);
    if (d >= bestD) return;
    if (!hasClearShot({ x: player.x, y: player.y + PLAYER_EYE, z: player.z }, point, 1.1, room.doors.colliders())) return;
    best = { kind, id, seconds, label }; bestD = d;
  };

  if (!room.power && room.powerCutDone && !room.generatorStarted) {
    consider('generator', BACKUP_GENERATOR.id,
      { x: BACKUP_GENERATOR.x, z: BACKUP_GENERATOR.z + BACKUP_GENERATOR.d / 2 + 0.05 },
      BACKUP_GENERATOR.seconds, '예비 발전기 · 차단기 올리기');
  }
  for (const npc of room.npcs) {
    if (!npc.alive) continue;
    if (npc.kind === 'civilian') {
      // 아직 붙잡혀 있는 인질은 용의자를 먼저 처리해야 데려올 수 있다.
      if (npc.secured || npc.hostage) continue;
      if (npc.state === 'comply') consider('secure', npc.id, npc, SECURE_SECONDS, '민간인 확보');
    } else if (npc.state === 'surrender' && !npc.arrested) {
      consider('arrest', npc.id, npc, ARREST_SECONDS, '체포');
    }
  }
  for (const e of room.evidence) {
    if (!e.taken) consider('evidence', e.id, e, EVIDENCE_SECONDS, `${e.label} 회수`);
  }
  for (const other of room.players.values()) {
    if (other === player || !other.downed) continue;
    consider('revive', other.id, other, REVIVE_SECONDS, `${other.name} 소생`);
  }
  return best;
}

function updateInteractions(room, dt, io) {
  for (const player of room.players.values()) {
    if (!player.alive || player.downed) {
      player.interacting = null; player.interactProgress = 0; player.interactLabel = '';
      continue;
    }
    const target = interactionTarget(room, player);
    player.interactLabel = target ? target.label : '';
    const key = target ? `${target.kind}:${target.id}` : null;
    if (!player.holdingUse || !key) { player.interacting = null; player.interactProgress = 0; continue; }
    if (player.interacting !== key) { player.interacting = key; player.interactProgress = 0; }
    player.interactProgress += dt / target.seconds;
    if (player.interactProgress < 1) continue;
    player.interactProgress = 0;
    player.interacting = null;
    completeInteraction(room, player, target, io);
  }
}

function completeInteraction(room, player, target, io) {
  if (target.kind === 'generator') {
    if (target.id !== BACKUP_GENERATOR.id || !restorePower(room)) return;
    io.to(room.code).emit('power', { on: true, generatorStarted: true });
    io.to(room.code).emit('radio', { text: MISSION.powerRestored });
  } else if (target.kind === 'arrest') {
    const npc = room.npcs.find((n) => n.id === target.id);
    if (!npc || npc.arrested) return;
    npc.arrested = true;
    npc.state = 'surrender';
    room.stats.suspectsArrested++;
    player.arrests++;
    io.to(room.code).emit('npcArrested', { id: npc.id, by: player.id, ...at3(npc) });
  } else if (target.kind === 'secure') {
    const npc = room.npcs.find((n) => n.id === target.id);
    if (!npc || npc.secured) return;
    npc.secured = true;
    npc.hostage = false;
    if (npc.id === 'hostage') room.stats.hostageSaved = true;
    else room.stats.civiliansRescued++;
    player.rescues++;
    io.to(room.code).emit('civilianSecured', {
      id: npc.id, by: player.id, hostage: npc.id === 'hostage', ...at3(npc),
    });
    io.to(room.code).emit('radio', { text: MISSION.civilianRescued });
  } else if (target.kind === 'evidence') {
    const item = room.evidence.find((e) => e.id === target.id);
    if (!item || item.taken) return;
    item.taken = true;
    room.stats.evidenceCollected++;
    io.to(room.code).emit('evidenceTaken', {
      id: item.id, by: player.id, label: item.label, x: item.x, z: item.z,
    });
  } else if (target.kind === 'revive') {
    const mate = room.players.get(target.id);
    if (!mate || !mate.downed) return;
    mate.downed = false;
    mate.alive = true;
    mate.hp = 45;
    io.to(room.code).emit('playerRevived', { id: mate.id, by: player.id, hp: mate.hp, ...at3(mate) });
  }
}

/* ========================================================================== *
 *  구두 경고 (비살상 압박)
 * ========================================================================== */
/**
 * @param line  외친 대사의 번호. 대사 문구 자체는 클라이언트가 갖고 있다 - 글을
 *              그대로 받아 넘기면 남의 화면에 아무 글이나 띄울 수 있다.
 */
function shout(room, player, io, line = 0) {
  const t = now();
  if (t - player.lastShout < SHOUT_COOLDOWN) return;
  player.lastShout = t;
  emitNoise(room, player.x, player.z, NOISE.shout, 'shout', player.id);
  io.to(room.code).emit('playerShout', { id: player.id, line, ...at3(player) });

  const world = makeWorld(room, 0, io);
  const colliders = room.doors.colliders();
  const eye = { x: player.x, y: player.y + PLAYER_EYE, z: player.z };
  const observer = { x: player.x, z: player.z, yaw: player.yaw };
  const alliesDown = room.suspects.filter(
    (s) => !s.alive || s.arrested || s.state === 'surrender').length;
  const tally = { heard: 0, aimed: 0, surrender: 0, defy: 0, shaken: 0, civilians: 0 };

  for (const npc of room.npcs) {
    if (!npc.alive || npc.secured || npc.arrested) continue;
    const d = dist2D(player, npc);
    if (d > WARNING.range) continue;
    if (!hasClearShot(eye, npc, 1.3, colliders)) continue;
    // 목소리는 넓게 들리지만, "총구를 겨눈" 것은 조준선 안에 들어왔을 때뿐이다.
    if (!inFieldOfView(observer, npc, Math.PI * 1.1)) continue;
    tally.heard++;
    const aimed = inFieldOfView(observer, npc, WARNING.aimAngle * 2, 0.8);
    if (aimed) tally.aimed++;

    if (npc.kind === 'civilian') {
      npc.commandedAt = t;
      tally.civilians++;
      continue;
    }
    const outcome = warnSuspect(npc, world, { aimed, distance: d, alliesDown, from: player });
    if (tally[outcome] !== undefined) tally[outcome]++;
  }
  // 무엇이 일어났는지 외친 본인에게만 알려 준다. 아무 반응이 없어도
  // "아무도 못 들었다"는 것 자체가 정보다.
  io.to(player.id).emit('shoutResult', tally);
}

/* ========================================================================== *
 *  목표와 단계
 * ========================================================================== */
function updateObjectives(room, dt, io) {
  // 실내 진입 기록
  if (!room.flags.breached && room.standingPlayers.some((p) => isIndoors(p.x, p.z))) {
    room.flags.breached = true;
  }

  // 폭발물 해체
  for (const site of room.sites) {
    if (site.defused) continue;
    const workers = room.standingPlayers.filter(
      (p) => p.defusing === site.id && dist2D(p, site) <= DEFUSE_RANGE && now() > p.blindUntil,
    );
    const before = site.progress;
    if (workers.length > 0) {
      const rate = (1 / DEFUSE_SECONDS) * (1 + (workers.length - 1) * 0.6);
      site.progress = clamp(site.progress + rate * dt, 0, 1);
    } else if (site.progress > 0) {
      site.progress = clamp(site.progress - 0.3 * dt, 0, 1);
    }
    site.activeBy = workers.map((p) => p.id);

    if (site.progress >= 1) {
      site.defused = true;
      room.stats.devicesDefused++;
      io.to(room.code).emit('siteDefused', { id: site.id, by: site.activeBy });
      io.to(room.code).emit('radio', { text: site.id === 'A' ? MISSION.siteA : MISSION.siteB });
      emitNoise(room, site.x, site.z, NOISE.defuse, 'defuse', null);
    }
    if (Math.abs(site.progress - before) > 0.001) {
      io.to(room.code).emit('siteProgress', { id: site.id, progress: site.progress, by: site.activeBy });
    }
  }

  const hvt = room.npcs.find((n) => n.kind === 'hvt');
  // 주요 용의자를 처음 본 순간 무전
  if (!room.flags.hvtSeen && hvt?.alive) {
    const colliders = room.doors.colliders();
    if (room.standingPlayers.some((p) =>
      dist2D(p, hvt) < 14 && hasClearShot({ x: p.x, y: p.y + PLAYER_EYE, z: p.z }, hvt, 1.3, colliders))) {
      room.flags.hvtSeen = true;
      io.to(room.code).emit('radio', { text: MISSION.hvtFound });
    }
  }
  // 주요 용의자가 제압되면 인질이 풀려난다 (사살·체포·항복 모두)
  if (hvt && (!hvt.alive || hvt.arrested || hvt.state === 'surrender')) {
    const hostage = room.npcs.find((n) => n.id === 'hostage');
    if (hostage?.hostage) {
      hostage.hostage = false;
      hostage.state = 'comply';
      hostage.hands = 1;
      io.to(room.code).emit('radio', { text: MISSION.hvtDown });
    }
  }

  // 단계 진행
  if (phaseComplete(room)) {
    room.stats.phasesCleared = room.phase + 1;
    if (room.phase === PHASES.length - 1) {
      room.stats.completed = true;
      finishMatch(room, 'won', io);
      return;
    }
    room.phase++;
    room.phaseEnteredAt = now();
    const next = PHASES[room.phase];
    io.to(room.code).emit('phase', objectiveReport(room));
    io.to(room.code).emit('radio', { text: next.radio });
    // Power follows entry time, never phase transitions (including after restoration).
  }

  // 마지막 단계에서 증원 병력이 들어온다
  if (PHASES[room.phase].id === 'extract' && !room.flags.reinforced
      && now() - room.phaseEnteredAt > REINFORCE_DELAY_MS) {
    room.flags.reinforced = true;
    spawnReinforcements(room, io);
  }

  broadcastObjectives(room, io);
}

/**
 * 미션표 갱신.
 *
 * 예전에는 단계가 "통째로" 끝날 때만 목표 목록을 보냈다. 그래서 외곽 경비를
 * 다 잡아도 화면의 "0/2" 가 그대로 남아 있었고, 플레이어는 자기가 한 일이
 * 반영되지 않는다고 느꼈다. 목표 하나가 바뀔 때마다 보낸다.
 *
 * 매 틱 보내면 낭비이므로 내용이 실제로 달라졌을 때만 보낸다.
 */
function broadcastObjectives(room, io) {
  const report = objectiveReport(room);
  const signature = JSON.stringify(report.list) + report.phase;
  if (signature === room.objectiveSignature) return;
  room.objectiveSignature = signature;
  io.to(room.code).emit('objectives', report);
}

/*
 * 정전.
 *
 * 저택 쪽에서 두꺼비집을 내린다. 실내등이 전부 꺼지고, 그때부터 안에서는
 * 서로가 잘 안 보인다 - 적도 나를 늦게 발견하고, 나도 적을 늦게 본다.
 * 손전등(L)을 켜면 보이지만, 켠 사람은 어둠 속에서 훨씬 먼저 눈에 띈다.
 */
function cutPower(room, io) {
  if (!room.power) return;
  room.power = false;
  io.to(room.code).emit('power', { on: false });
  io.to(room.code).emit('radio', { text: MISSION.powerCut });
  // 불이 꺼지는 순간 모두가 움찔한다. 소리가 아니라 상태 변화로 전한다.
  for (const npc of room.npcs) {
    if (!npc.alive || npc.kind === 'civilian') continue;
    npc.morale = Math.max(0, npc.morale - 0.05);
  }
}

function spawnReinforcements(room, io) {
  const diff = DIFFICULTY[room.difficulty] || DIFFICULTY.normal;
  const gate = [{ x: -2.4, z: 40.6 }, { x: 2.4, z: 40.6 }, { x: 0, z: 38.6 }];
  const created = [];
  for (let i = 0; i < REINFORCE_COUNT; i++) {
    const spot = gate[i % gate.length];
    const suspect = createSuspect(`rf_${i}`, {
      post: { x: spot.x, z: spot.z, yaw: Math.PI, room: 'COURTYARD' },
      personality: 'aggressive',
      hp: Math.round(SUSPECT_MAX_HP * diff.hpMul),
    });
    suspect.origin = 'outdoor';
    suspect.reinforcement = true;
    suspect.state = 'investigate';
    suspect.stateUntil = now() + 60000;
    suspect.lastHeard = { x: 0, z: 18, t: now(), level: 1, type: 'contact' };
    room.npcs.push(suspect);
    created.push(suspect);
  }
  io.to(room.code).emit('npcsJoined', { npcs: created.map(npcPublic) });
  io.to(room.code).emit('radio', { text: MISSION.reinforcements });
}

/* ========================================================================== *
 *  종료
 * ========================================================================== */
function checkMissionEnd(room, io) {
  if (room.state !== 'active') return;
  if (room.players.size > 0 && room.alivePlayers.length === 0) finishMatch(room, 'lost', io);
}

function finishMatch(room, result, io) {
  if (room.state !== 'active') return;
  room.state = result;
  if (room.timer) { clearInterval(room.timer); room.timer = null; }

  room.stats.objectivesMissed = missedObjectives(room);
  room.stats.teamLost = [...room.players.values()].filter((p) => !p.alive).length;
  const hostage = room.npcs.find((n) => n.id === 'hostage');
  if (hostage?.alive) room.stats.hostageSaved = true;
  if (result === 'won') room.stats.completed = true;

  const score = scoreMission(room.stats);
  io.to(room.code).emit('matchEnd', {
    result,
    reason: result === 'won' ? '작전 목표 전부 달성 · 철수 완료'
      : (room.alivePlayers.length === 0 ? '팀 전멸' : '제한 시간 초과'),
    grade: score.grade,
    gradeLabel: score.gradeLabel,
    score: score.total,
    lines: score.lines,
    advice: gradeAdvice(score, room.stats),
    stats: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, kills: p.kills, arrests: p.arrests,
      rescues: p.rescues, alive: p.alive && !p.downed,
    })),
    sites: room.sites.map((s) => ({ id: s.id, defused: s.defused })),
  });
}

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

/*
 * 스냅샷에 실어 보내는 NPC 정보.
 *
 * 서버 안에서 npc.hostage 는 두 가지 뜻으로 쓰인다.
 *   - 민간인의 hostage  = 내가 붙잡혀 있다            (인질 본인)
 *   - 용의자의 hostage  = 내가 누구를 붙잡고 있다     (인질범)
 * 예전에는 이 둘을 hostage 한 필드로 합쳐 보냈다. 그래서 인질을 붙잡은 주요
 * 용의자의 머리 위에 '인질' 이라는 이름표가 붙었다. 뜻이 다른 값이니 따로 보낸다.
 */
const npcPublic = (n) => ({
  id: n.id, kind: n.kind, x: +n.x.toFixed(2), y: +n.y.toFixed(2), z: +n.z.toFixed(2),
  yaw: +n.yaw.toFixed(2), hp: Math.max(0, n.hp), maxHp: n.maxHp,
  state: n.state,
  hostage: n.kind === 'civilian' && !!n.hostage,        // 붙잡혀 있는 시민
  holdingHostage: n.kind !== 'civilian' && !!n.hostage, // 시민을 방패로 삼은 자
});

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

  io.to(room.code).emit('matchStart', {
    protocol: GAME_PROTOCOL,
    endsAt: room.endsAt,
    sites: room.sites.map((s) => ({ id: s.id, x: s.x, z: s.z, label: s.label })),
    evidence: room.evidence.map((e) => ({ id: e.id, x: e.x, z: e.z, label: e.label })),
    defuseSeconds: DEFUSE_SECONDS,
    extraction: EXTRACTION,
    doors: room.doors.snapshot(),
    npcs: room.npcs.map(npcPublic),
    objectives: objectiveReport(room),
    generatorStarted: room.generatorStarted,
    power: room.power,          // 재접속 시에도 정전/복구 상태를 전달한다
    grenades: GRENADES,
    grenadeOrder: GRENADE_ORDER,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, slot: p.slot, weapon: p.weapon,
      x: p.x, z: p.z, yaw: p.yaw,
    })),
    weapons: WEAPONS,
    shotProtocol: 2,
  });
  io.to(room.code).emit('radio', { text: MISSION.entry });

  if (room.timer) clearInterval(room.timer);
  room.lastTick = now();
  room.timer = setInterval(() => tickRoom(room, io), TICK_MS);
}

/* ========================================================================== *
 *  메인 틱
 * ========================================================================== */
function tickRoom(room, io) {
  const t = now();
  const dt = Math.min(0.25, (t - room.lastTick) / 1000);
  room.lastTick = t;
  if (room.state !== 'active') return;

  // 쓰러진 대원의 출혈
  for (const p of room.players.values()) {
    if (p.downed && t - p.downedAt > BLEED_OUT_MS) killPlayer(room, p, io);
  }

  if (powerCutDue(room, t)) cutPower(room, io);
  updateDoorQueue(room, io);
  updateGrenades(room, dt, io);

  const world = makeWorld(room, dt, io);
  for (const npc of room.npcs) {
    if (!npc.alive) continue;
    world.alliesNear = room.suspects.filter((s) => s !== npc && s.alive && dist2D(s, npc) < 9).length;
    if (npc.kind === 'civilian') updateCivilian(npc, world);
    else updateSuspect(npc, world);
  }

  room.targetHistory.record(t, shotTargets(room));
  updateInteractions(room, dt, io);
  updateObjectives(room, dt, io);
  if (room.state !== 'active') return;

  // 재장전 완료
  for (const p of room.players.values()) {
    if (p.reloadUntil && t >= p.reloadUntil) {
      const w = WEAPONS[p.weapon];
      const take = Math.min(w.mag - p.ammo, p.reserve);
      p.ammo += take;
      p.reserve -= take;
      p.reloadUntil = 0;
    }
  }

  if (t > room.endsAt) { finishMatch(room, 'lost', io); return; }

  room.seq++;
  io.to(room.code).emit('snapshot', {
    t,
    seq: room.seq,
    remaining: Math.max(0, room.endsAt - t),
    phase: room.phase,
    power: room.power ? 1 : 0,
    generatorStarted: room.generatorStarted,
    ...(room.doorsDirty ? { doors: room.doors.snapshot() } : null),
    players: [...room.players.values()].map((p) => ({
      id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
      yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
      hp: p.hp, alive: p.alive, downed: p.downed ? 1 : 0,
      moving: p.moving, sprint: p.sprint, crouch: p.crouch, light: p.light ? 1 : 0,
      ammo: p.ammo, reserve: p.reserve, reloading: p.reloadUntil > 0 ? 1 : 0,
      defusing: p.defusing ? 1 : 0,
      gas: +(p.gas || 0).toFixed(2),
      blind: Math.max(0, p.blindUntil - t),
      hold: p.interacting ? +p.interactProgress.toFixed(2) : 0,
      holdLabel: p.interactLabel || '',
      doorBusy: Math.max(0, (p.doorBusyUntil || 0) - t),
      grenades: p.grenades, sel: p.selectedGrenade,
      inputSeq: p.inputSeq, shotSeq: p.shotSeq,
    })),
    npcs: room.npcs.map((n) => ({
      id: n.id, kind: n.kind,
      x: +n.x.toFixed(2), y: +n.y.toFixed(2), z: +n.z.toFixed(2), yaw: +n.yaw.toFixed(2),
      hp: Math.max(0, n.hp), alive: n.alive ? 1 : 0,
      state: n.state, moving: n.moving, crouch: n.crouch,
      hands: n.hands ? 1 : 0, cuffed: n.arrested || n.secured ? 1 : 0,
    })),
    grenades: room.grenades.map((g) => ({
      id: g.id, type: g.type, x: +g.x.toFixed(2), y: +g.y.toFixed(2), z: +g.z.toFixed(2),
    })),
  });
  room.doorsDirty = false;
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

  const leave = () => {
    if (!room) return;
    cancelBriefing(room, io);
    room.removePlayer(socket.id);
    socket.leave(room.code);
    io.to(room.code).emit('lobby', room.lobbyState());
    io.to(room.code).emit('playerLeft', { id: socket.id });
    if (room.players.size === 0) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(room.code);
    } else {
      checkMissionEnd(room, io);
    }
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
    if (r.players.size >= 4) return cb?.({ ok: false, error: '방이 꽉 찼어요 (최대 4명).' });
    if (r.state === 'active' || r.state === 'briefing') return cb?.({ ok: false, error: '이미 작전이 진행 중이에요.' });
    if (room === r) return cb?.({ ok: true, you: me.id, lobby: room.lobbyState() });
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
    if (!room || room.hostId !== socket.id || room.state === 'active' || room.state === 'briefing') return;
    if (botCount) room.botCount = clamp(botCount | 0, 3, 14);
    if (difficulty && DIFFICULTY[difficulty]) room.difficulty = difficulty;
    io.to(room.code).emit('lobby', room.lobbyState());
  });

  socket.on('startMatch', () => {
    if (!room || room.hostId !== socket.id) return;
    if (room.state === 'active' || room.state === 'briefing') return;
    if (![...room.players.values()].every((p) => p.ready)) return;
    beginBriefing(room, io);
  });

  socket.on('briefingReady', ({ id } = {}) => {
    if (!room || !me || room.state !== 'briefing' || id !== room.briefingId) return;
    me.briefingReady = true;
    io.to(room.code).emit('lobby', room.lobbyState());
    if ([...room.players.values()].every((p) => p.briefingReady)) startMatch(room, io);
  });

  socket.on('cancelBriefing', () => {
    if (!room || room.hostId !== socket.id || room.state !== 'briefing') return;
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
  socket.on('disconnect', leave);
});

export { Room, tickRoom, updateInteractions };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) server.listen(PORT, () => {
  console.log('');
  console.log('  ███  RAVENWOOD : 긴 밤  ███');
  console.log(`  구역: ${MAP.name}  (${MAP.width}m x ${MAP.depth}m, 충돌박스 ${COLLIDERS.length}개, 방 ${ROOMS.length}개)`);
  console.log(`  단계 ${PHASES.length}개 · 제한 시간 ${MISSION_TIME_MS / 60000}분`);
  console.log(`  서버 준비됨 ->  http://localhost:${PORT}`);
  console.log('  같은 와이파이의 폰에서는 PC의 내부 IP로 접속하세요 (예: http://192.168.0.10:' + PORT + ')');
  console.log('');
});
