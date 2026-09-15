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
/** Render 무료 슬립·일시 끊김 후 재접속 유예 (ms). 이 시간 안에는 플레이어를 유지한다. */
const DISCONNECT_GRACE_MS = 90_000;

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
      disconnected: false,
      disconnectedAt: 0,
      disconnectTimer: null,
    };
    this.players.set(socket.id, p);
    if (!this.hostId) this.hostId = socket.id;
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p?.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
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
