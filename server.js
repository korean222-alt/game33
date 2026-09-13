/* =============================================================================
 *  server.js  -  Express + Socket.io 게임 서버
 *
 *  역할
 *    1) public/ 정적 서빙 + node_modules/three 를 /vendor/three 로 서빙
 *    2) 방(room) 관리 - 방 코드로 2~4인 입장
 *    3) 적 AI 봇 시뮬레이션 (서버가 진실, 클라는 보간만)
 *    4) 사격 판정 / 피해 / 목표(폭발물 해체) 진행도 / 승패 판정
 *
 *  실행: npm install && npm start   ->  http://localhost:3000
 * ========================================================================== */

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import {
  MAP, COLLIDERS, SPAWNS, BOMB_SITES, BOT_SPAWNS, PATROL_NODES,
  resolveCircle, raycastBoxes, hasLineOfSight3D,
} from './public/js/map-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/* ========================================================================== *
 *  튜닝 상수
 * ========================================================================== */
const TICK_HZ          = 20;          // 서버 시뮬레이션 / 스냅샷 주기
const TICK_MS          = 1000 / TICK_HZ;

const PLAYER_RADIUS    = 0.35;
const PLAYER_MAX_HP    = 100;
const PLAYER_EYE       = 1.62;

const BOT_RADIUS       = 0.38;
const BOT_MAX_HP       = 100;
const BOT_EYE          = 1.55;
const BOT_VIEW_DIST    = 18;          // 최대 시야 거리 (m)
const BOT_FOV          = Math.PI * 0.72; // 시야각 (약 130도)
const BOT_SPEED_PATROL = 1.15;
const BOT_SPEED_ALERT  = 2.35;
const BOT_TURN_SPEED   = 4.5;         // rad/s
const BOT_REACTION_MS  = 420;         // 발견 후 첫 사격까지 딜레이
const BOT_FIRE_MS      = 620;         // 사격 간격
const BOT_DAMAGE       = 14;
const BOT_ALERT_RADIUS = 14;          // 총소리 전파 거리
const BOT_MEMORY_MS    = 6000;        // 놓친 뒤 마지막 위치 수색 시간

const MISSION_TIME_MS  = 6 * 60 * 1000;  // 6분
const DEFUSE_SECONDS   = 6;              // 폭발물 1개 해체에 걸리는 시간
const DEFUSE_RANGE     = 1.6;

const WEAPONS = {
  rifle:  { name: 'M416',  mag: 30, reserve: 150, rpm: 700, damage: 26, headMul: 2.2, range: 60, reload: 2.3 },
  smg:    { name: 'UMP9',  mag: 25, reserve: 150, rpm: 600, damage: 21, headMul: 2.0, range: 40, reload: 2.0 },
  sniper: { name: 'AWM',   mag: 5,  reserve: 30,  rpm: 45,  damage: 95, headMul: 1.5, range: 80, reload: 3.2 },
};

/* ========================================================================== *
 *  유틸
 * ========================================================================== */
const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

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
    this.bots = [];
    this.state = 'lobby';       // lobby | active | won | lost
    this.hostId = null;
    this.botCount = 4;
    this.difficulty = 'normal'; // easy | normal | hard
    this.sites = [];
    this.endsAt = 0;
    this.timer = null;
    this.lastTick = now();
    this.seq = 0;
  }

  get alivePlayers() {
    return [...this.players.values()].filter((p) => p.alive);
  }

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
      alive: true,
      ready: false,
      weapon: wk,
      ammo: WEAPONS[wk].mag,
      reserve: WEAPONS[wk].reserve,
      reloadUntil: 0,
      lastShot: 0,
      moving: 0, sprint: 0, crouch: 0,
      defusing: null,
      kills: 0,
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
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, slot: p.slot, ready: p.ready, weapon: p.weapon,
      })),
    };
  }
}

/* ========================================================================== *
 *  봇 AI
 * ========================================================================== */
const DIFFICULTY = {
  easy:   { hpMul: 0.7, dmgMul: 0.7, accuracy: 0.42, reactMul: 1.6 },
  normal: { hpMul: 1.0, dmgMul: 1.0, accuracy: 0.60, reactMul: 1.0 },
  hard:   { hpMul: 1.3, dmgMul: 1.3, accuracy: 0.78, reactMul: 0.7 },
};

function spawnBots(room) {
  const diff = DIFFICULTY[room.difficulty] || DIFFICULTY.normal;
  room.bots = [];
  const spots = [...BOT_SPAWNS].sort(() => Math.random() - 0.5);
  for (let i = 0; i < room.botCount; i++) {
    const s = spots[i % spots.length];
    room.bots.push({
      id: `bot_${i}`,
      x: s.x + (Math.random() - 0.5) * 0.6,
      z: s.z + (Math.random() - 0.5) * 0.6,
      yaw: Math.random() * Math.PI * 2,
      hp: Math.round(BOT_MAX_HP * diff.hpMul),
      maxHp: Math.round(BOT_MAX_HP * diff.hpMul),
      alive: true,
      state: 'patrol',           // patrol | alert | engage | search | dead
      targetId: null,
      lastSeen: null,            // {x,z,t}
      nextNode: PATROL_NODES[Math.floor(Math.random() * PATROL_NODES.length)],
      spotTime: 0,
      nextFire: 0,
      moving: 0,
      idleUntil: 0,
    });
  }
}

/** 플레이어의 현재 눈높이 (앉으면 낮아진다) */
function eyeOf(p) {
  return p.crouch ? PLAYER_EYE - 0.45 : PLAYER_EYE;
}

/**
 * 봇이 특정 플레이어를 볼 수 있는가.
 *
 * ★ 3D 로 본다. 예전에는 평면으로만 봐서, 드럼통(0.99m) 뒤에 앉아 있어도
 *   봇이 그대로 보고 쐈다. 이제는 앉아서 엄폐하면 실제로 안 보인다.
 *   가슴 높이도 같이 검사해서 "머리만 빼꼼" 도 인지하게 한다.
 */
function botCanSee(bot, p) {
  const d = dist2D(bot, p);
  if (d > BOT_VIEW_DIST) return false;

  // 시야각
  const toX = p.x - bot.x, toZ = p.z - bot.z;
  const fwdX = -Math.sin(bot.yaw), fwdZ = -Math.cos(bot.yaw);
  const dot = (toX * fwdX + toZ * fwdZ) / (d || 1);
  if (dot < Math.cos(BOT_FOV / 2) && d > 2.5) return false; // 2.5m 이내는 뒤통수도 인지

  const eye = eyeOf(p);
  return hasLineOfSight3D(bot.x, BOT_EYE, bot.z, p.x, eye, p.z, COLLIDERS)
      || hasLineOfSight3D(bot.x, BOT_EYE, bot.z, p.x, eye - 0.45, p.z, COLLIDERS);
}

function botFindTarget(room, bot) {
  let best = null, bestD = Infinity;
  for (const p of room.alivePlayers) {
    if (!botCanSee(bot, p)) continue;
    const d = dist2D(bot, p);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/** 봇 이동: 목표 지점 쪽으로 걷고 충돌 처리 */
function botMoveToward(bot, tx, tz, speed, dt) {
  const dx = tx - bot.x, dz = tz - bot.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) { bot.moving = 0; return true; }

  let nx = bot.x + (dx / d) * speed * dt;
  let nz = bot.z + (dz / d) * speed * dt;

  // 벽에 정면으로 막히면 좌/우로 미끄러진다 (아주 단순한 회피)
  const before = { x: nx, z: nz };
  const fixed = resolveCircle(nx, nz, BOT_RADIUS, COLLIDERS);
  if (Math.hypot(fixed.x - before.x, fixed.z - before.z) > 0.01) {
    const side = (bot.id.charCodeAt(4) % 2 === 0) ? 1 : -1;
    const px = -(dz / d) * side, pz = (dx / d) * side;
    const slideX = bot.x + px * speed * dt;
    const slideZ = bot.z + pz * speed * dt;
    const s = resolveCircle(slideX, slideZ, BOT_RADIUS, COLLIDERS);
    bot.x = s.x; bot.z = s.z;
  } else {
    bot.x = fixed.x; bot.z = fixed.z;
  }
  bot.moving = 1;
  return d < 0.6;
}

function botFaceToward(bot, tx, tz, dt) {
  const want = Math.atan2(-(tx - bot.x), -(tz - bot.z));
  let diff = want - bot.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const step = clamp(diff, -BOT_TURN_SPEED * dt, BOT_TURN_SPEED * dt);
  bot.yaw += step;
  return Math.abs(diff) < 0.18;
}

function alertNearbyBots(room, x, z, fromId) {
  for (const b of room.bots) {
    if (!b.alive) continue;
    if (Math.hypot(b.x - x, b.z - z) > BOT_ALERT_RADIUS) continue;
    if (b.state === 'engage') continue;
    b.state = 'alert';
    b.lastSeen = { x, z, t: now() };
    b.targetId = fromId || b.targetId;
  }
}

function updateBots(room, dt, io) {
  const diff = DIFFICULTY[room.difficulty] || DIFFICULTY.normal;
  const t = now();

  for (const bot of room.bots) {
    if (!bot.alive) continue;

    const seen = botFindTarget(room, bot);

    if (seen) {
      if (bot.state !== 'engage') { bot.state = 'engage'; bot.spotTime = t; }
      bot.targetId = seen.id;
      bot.lastSeen = { x: seen.x, z: seen.z, t };
    } else if (bot.state === 'engage') {
      bot.state = 'search';
    }

    switch (bot.state) {
      /* --- 순찰 --------------------------------------------------------- */
      case 'patrol': {
        if (t < bot.idleUntil) { bot.moving = 0; break; }
        botFaceToward(bot, bot.nextNode.x, bot.nextNode.z, dt);
        const arrived = botMoveToward(bot, bot.nextNode.x, bot.nextNode.z, BOT_SPEED_PATROL, dt);
        if (arrived) {
          bot.nextNode = PATROL_NODES[Math.floor(Math.random() * PATROL_NODES.length)];
          bot.idleUntil = t + 700 + Math.random() * 1800; // 잠깐 멈춰 서서 두리번
        }
        break;
      }

      /* --- 총소리 듣고 이동 ---------------------------------------------- */
      case 'alert': {
        if (!bot.lastSeen) { bot.state = 'patrol'; break; }
        botFaceToward(bot, bot.lastSeen.x, bot.lastSeen.z, dt);
        const arrived = botMoveToward(bot, bot.lastSeen.x, bot.lastSeen.z, BOT_SPEED_ALERT, dt);
        if (arrived || t - bot.lastSeen.t > BOT_MEMORY_MS) { bot.state = 'search'; }
        break;
      }

      /* --- 교전 --------------------------------------------------------- */
      case 'engage': {
        const target = room.players.get(bot.targetId);
        if (!target || !target.alive) { bot.state = 'search'; break; }

        const d = dist2D(bot, target);
        const aimed = botFaceToward(bot, target.x, target.z, dt);

        // 너무 멀면 접근, 너무 가까우면 유지
        if (d > 8) botMoveToward(bot, target.x, target.z, BOT_SPEED_ALERT, dt);
        else bot.moving = 0;

        const reactReady = t - bot.spotTime > BOT_REACTION_MS * diff.reactMul;
        if (aimed && reactReady && t >= bot.nextFire) {
          bot.nextFire = t + BOT_FIRE_MS * (0.8 + Math.random() * 0.5);

          // 명중 확률: 거리 + 난이도 + 대상 이동 여부
          let chance = diff.accuracy * clamp(1.25 - d / 22, 0.3, 1.0);
          if (target.sprint) chance *= 0.72;
          else if (target.moving) chance *= 0.88;
          if (target.crouch) chance *= 0.85;

          // 조준선이 엄폐물에 막히면 아무리 명중률이 높아도 못 맞힌다
          const aimY = eyeOf(target) - 0.25;
          const clear = hasLineOfSight3D(bot.x, BOT_EYE, bot.z, target.x, aimY, target.z, COLLIDERS);
          const hit = clear && Math.random() < chance;

          io.to(room.code).emit('botShot', {
            id: bot.id, x: bot.x, y: BOT_EYE, z: bot.z,
            tx: target.x, ty: aimY, tz: target.z, hit,
          });

          if (hit) {
            const dmg = Math.round(BOT_DAMAGE * diff.dmgMul * (0.85 + Math.random() * 0.3));
            damagePlayer(room, target, dmg, bot.id, io);
          }
        }
        break;
      }

      /* --- 마지막 위치 수색 ---------------------------------------------- */
      case 'search': {
        if (!bot.lastSeen || t - bot.lastSeen.t > BOT_MEMORY_MS) {
          bot.state = 'patrol';
          bot.nextNode = PATROL_NODES[Math.floor(Math.random() * PATROL_NODES.length)];
          break;
        }
        botFaceToward(bot, bot.lastSeen.x, bot.lastSeen.z, dt);
        const arrived = botMoveToward(bot, bot.lastSeen.x, bot.lastSeen.z, BOT_SPEED_ALERT * 0.8, dt);
        if (arrived) bot.lastSeen.t = Math.min(bot.lastSeen.t, t - BOT_MEMORY_MS + 1200);
        break;
      }
    }
  }
}

/* ========================================================================== *
 *  피해 / 사망
 * ========================================================================== */
function damagePlayer(room, player, dmg, byId, io) {
  if (!player.alive) return;
  player.hp = Math.max(0, player.hp - dmg);
  io.to(room.code).emit('playerHit', { id: player.id, hp: player.hp, dmg, by: byId });

  if (player.hp === 0) {
    player.alive = false;
    player.defusing = null;
    io.to(room.code).emit('playerDown', { id: player.id, by: byId });
    checkMissionEnd(room, io);
  }
}

function damageBot(room, bot, dmg, byId, io) {
  if (!bot.alive) return;
  bot.hp -= dmg;
  const shooter = room.players.get(byId);
  io.to(room.code).emit('botHit', { id: bot.id, hp: Math.max(0, bot.hp), dmg, by: byId });

  if (bot.hp <= 0) {
    bot.alive = false;
    bot.state = 'dead';
    bot.moving = 0;
    if (shooter) shooter.kills++;
    io.to(room.code).emit('botDown', { id: bot.id, by: byId });
  } else {
    // 맞으면 즉시 반응
    if (shooter) {
      bot.state = 'engage';
      bot.targetId = byId;
      bot.spotTime = now() - BOT_REACTION_MS * 0.5;
      bot.lastSeen = { x: shooter.x, z: shooter.z, t: now() };
    }
  }
}

/* ========================================================================== *
 *  사격 판정 (서버 권위)
 * ========================================================================== */
function resolveShot(room, shooter, origin, dir, io) {
  const w = WEAPONS[shooter.weapon];
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };

  // ★ 3D 로 막힌 지점을 찾는다.
  //   평면 판정이면 상자/드럼통 위로 넘어가는 총알까지 막혀버리고,
  //   반대로 낮은 엄폐물 뒤에 앉은 적이 그냥 맞아버린다.
  const wallDist = raycastBoxes(origin.x, origin.y, origin.z, d.x, d.y, d.z, w.range, COLLIDERS);

  let best = null;
  let bestT = Math.min(w.range, wallDist);

  const testSphere = (cx, cy, cz, r, meta) => {
    const ox = origin.x - cx, oy = origin.y - cy, oz = origin.z - cz;
    const b = ox * d.x + oy * d.y + oz * d.z;
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - c;
    if (disc < 0) return;
    const t = -b - Math.sqrt(disc);
    if (t > 0.2 && t < bestT) { bestT = t; best = { t, ...meta }; }
  };

  for (const bot of room.bots) {
    if (!bot.alive) continue;
    testSphere(bot.x, 1.05, bot.z, 0.42, { type: 'bot', ref: bot, part: 'body' });   // 몸통
    testSphere(bot.x, 1.63, bot.z, 0.20, { type: 'bot', ref: bot, part: 'head' });   // 머리
  }

  if (!best) {
    return { hit: false, dist: Math.min(bestT, w.range) };
  }

  const dmg = Math.round(w.damage * (best.part === 'head' ? w.headMul : 1));
  damageBot(room, best.ref, dmg, shooter.id, io);
  return { hit: true, dist: best.t, part: best.part, targetId: best.ref.id };
}

/* ========================================================================== *
 *  미션 (폭발물 해체)
 * ========================================================================== */
function startMatch(room, io) {
  room.state = 'active';
  room.endsAt = now() + MISSION_TIME_MS;
  room.sites = BOMB_SITES.map((s) => ({ ...s, progress: 0, defused: false, activeBy: [] }));
  spawnBots(room);

  let i = 0;
  for (const p of room.players.values()) {
    const spawn = SPAWNS[i % SPAWNS.length];
    p.x = spawn.x; p.z = spawn.z; p.y = 0; p.yaw = spawn.yaw; p.pitch = 0;
    p.hp = PLAYER_MAX_HP; p.alive = true; p.kills = 0;
    p.ammo = WEAPONS[p.weapon].mag;
    p.reserve = WEAPONS[p.weapon].reserve;
    p.reloadUntil = 0; p.defusing = null;
    i++;
  }

  io.to(room.code).emit('matchStart', {
    endsAt: room.endsAt,
    sites: room.sites.map((s) => ({ id: s.id, x: s.x, z: s.z, label: s.label })),
    defuseSeconds: DEFUSE_SECONDS,
    bots: room.bots.map((b) => ({ id: b.id, x: b.x, z: b.z, yaw: b.yaw, hp: b.hp, maxHp: b.maxHp })),
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, slot: p.slot, weapon: p.weapon,
      x: p.x, z: p.z, yaw: p.yaw,
    })),
    weapons: WEAPONS,
  });

  if (room.timer) clearInterval(room.timer);
  room.lastTick = now();
  room.timer = setInterval(() => tickRoom(room, io), TICK_MS);
}

function updateObjectives(room, dt, io) {
  for (const site of room.sites) {
    if (site.defused) continue;

    const workers = [...room.players.values()].filter(
      (p) => p.alive && p.defusing === site.id && dist2D(p, site) <= DEFUSE_RANGE
    );

    const before = site.progress;
    if (workers.length > 0) {
      // 2명 이상이면 조금 빠르게 (협동 보상)
      const rate = (1 / DEFUSE_SECONDS) * (1 + (workers.length - 1) * 0.6);
      site.progress = clamp(site.progress + rate * dt, 0, 1);
    } else if (site.progress > 0) {
      site.progress = clamp(site.progress - 0.35 * dt, 0, 1); // 손 떼면 서서히 되돌아감
    }

    site.activeBy = workers.map((p) => p.id);

    if (site.progress >= 1 && !site.defused) {
      site.defused = true;
      site.progress = 1;
      io.to(room.code).emit('siteDefused', { id: site.id, by: workers.map((p) => p.id) });
      // 해체하면 남은 적들이 몰려온다
      alertNearbyBots(room, site.x, site.z, null);
      for (const b of room.bots) {
        if (b.alive) { b.state = 'alert'; b.lastSeen = { x: site.x, z: site.z, t: now() }; }
      }
    }

    if (Math.abs(site.progress - before) > 0.001) {
      io.to(room.code).emit('siteProgress', { id: site.id, progress: site.progress, by: site.activeBy });
    }
  }

  if (room.sites.every((s) => s.defused)) finishMatch(room, 'won', io);
}

function checkMissionEnd(room, io) {
  if (room.state !== 'active') return;
  if (room.players.size > 0 && room.alivePlayers.length === 0) finishMatch(room, 'lost', io);
}

function finishMatch(room, result, io) {
  if (room.state !== 'active') return;
  room.state = result;
  if (room.timer) { clearInterval(room.timer); room.timer = null; }

  io.to(room.code).emit('matchEnd', {
    result,
    reason: result === 'won' ? '폭발물 전량 해체' :
            (room.alivePlayers.length === 0 ? '팀 전멸' : '제한 시간 초과'),
    stats: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, kills: p.kills, alive: p.alive,
    })),
    sites: room.sites.map((s) => ({ id: s.id, defused: s.defused })),
  });
}

/* ========================================================================== *
 *  메인 틱
 * ========================================================================== */
function tickRoom(room, io) {
  const t = now();
  const dt = Math.min(0.25, (t - room.lastTick) / 1000);
  room.lastTick = t;

  if (room.state !== 'active') return;

  updateBots(room, dt, io);
  updateObjectives(room, dt, io);

  // 재장전 완료 처리
  for (const p of room.players.values()) {
    if (p.reloadUntil && t >= p.reloadUntil) {
      const w = WEAPONS[p.weapon];
      const need = w.mag - p.ammo;
      const take = Math.min(need, p.reserve);
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
    players: [...room.players.values()].map((p) => ({
      id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
      yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
      hp: p.hp, alive: p.alive, moving: p.moving, sprint: p.sprint, crouch: p.crouch,
      ammo: p.ammo, reserve: p.reserve, reloading: p.reloadUntil > 0 ? 1 : 0,
      defusing: p.defusing ? 1 : 0,
    })),
    bots: room.bots.map((b) => ({
      id: b.id, x: +b.x.toFixed(3), z: +b.z.toFixed(3), yaw: +b.yaw.toFixed(3),
      hp: Math.max(0, b.hp), alive: b.alive ? 1 : 0, moving: b.moving, state: b.state,
    })),
  });
}

/* ========================================================================== *
 *  HTTP + Socket.io
 * ========================================================================== */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
// three.js 를 CDN 없이 로컬에서 서빙 (오프라인/기내에서도 동작)
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three')));

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  const leave = () => {
    if (!room) return;
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
    if (r.state === 'active') return cb?.({ ok: false, error: '이미 작전이 진행 중이에요.' });

    room = r;
    me = room.addPlayer(socket, name, weapon);
    socket.join(room.code);
    cb?.({ ok: true, you: me.id, lobby: room.lobbyState() });
    io.to(room.code).emit('lobby', room.lobbyState());
  });

  socket.on('setLoadout', ({ weapon, ready } = {}) => {
    if (!me) return;
    if (weapon && WEAPONS[weapon]) {
      me.weapon = weapon;
      me.ammo = WEAPONS[weapon].mag;
      me.reserve = WEAPONS[weapon].reserve;
    }
    if (typeof ready === 'boolean') me.ready = ready;
    io.to(room.code).emit('lobby', room.lobbyState());
  });

  socket.on('setRoomConfig', ({ botCount, difficulty } = {}) => {
    if (!room || room.hostId !== socket.id) return;
    if (botCount) room.botCount = clamp(botCount | 0, 2, 5);
    if (difficulty && DIFFICULTY[difficulty]) room.difficulty = difficulty;
    io.to(room.code).emit('lobby', room.lobbyState());
  });

  socket.on('startMatch', () => {
    if (!room || room.hostId !== socket.id) return;
    if (room.state === 'active') return;
    startMatch(room, io);
  });

  /* ---- 인게임 ---------------------------------------------------------- */
  socket.on('input', (d) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return;
    // 위치는 클라 예측을 신뢰하되 서버에서 한 번 더 충돌 보정 (벽 뚫기 방지)
    const fixed = resolveCircle(+d.x || 0, +d.z || 0, PLAYER_RADIUS, COLLIDERS);
    me.x = fixed.x;
    me.z = fixed.z;
    me.y = clamp(+d.y || 0, 0, 3);
    me.yaw = +d.yaw || 0;
    me.pitch = clamp(+d.pitch || 0, -1.5, 1.5);
    me.moving = d.moving ? 1 : 0;
    me.sprint = d.sprint ? 1 : 0;
    me.crouch = d.crouch ? 1 : 0;
  });

  socket.on('shoot', (d, cb) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return cb?.({ ok: false });
    const w = WEAPONS[me.weapon];
    const t = now();
    if (me.reloadUntil > 0) return cb?.({ ok: false, reason: 'reloading' });
    if (me.ammo <= 0) return cb?.({ ok: false, reason: 'empty' });
    if (t - me.lastShot < (60000 / w.rpm) * 0.85) return cb?.({ ok: false, reason: 'rate' });

    me.lastShot = t;
    me.ammo--;

    const origin = { x: me.x, y: PLAYER_EYE - (me.crouch ? 0.45 : 0), z: me.z };
    const dir = { x: +d.dx || 0, y: +d.dy || 0, z: +d.dz || -1 };
    const res = resolveShot(room, me, origin, dir, io);

    io.to(room.code).emit('playerShot', {
      id: me.id, x: origin.x, y: origin.y, z: origin.z,
      dx: dir.x, dy: dir.y, dz: dir.z, dist: res.dist, hit: res.hit,
    });
    alertNearbyBots(room, me.x, me.z, me.id);

    cb?.({ ok: true, ammo: me.ammo, ...res });
  });

  socket.on('reload', () => {
    if (!me || !room || room.state !== 'active' || !me.alive) return;
    const w = WEAPONS[me.weapon];
    if (me.reloadUntil > 0 || me.ammo >= w.mag || me.reserve <= 0) return;
    me.reloadUntil = now() + w.reload * 1000;
    io.to(room.code).emit('playerReload', { id: me.id, duration: w.reload });
  });

  socket.on('defuse', ({ siteId, active } = {}) => {
    if (!me || !room || room.state !== 'active' || !me.alive) return;
    me.defusing = active ? siteId : null;
  });

  socket.on('ping:rtt', (t0, cb) => cb?.(t0));

  socket.on('leaveRoom', leave);
  socket.on('disconnect', leave);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ███  MARKET RAID  ███');
  console.log(`  맵: ${MAP.name}  (${MAP.width}m x ${MAP.depth}m, 충돌박스 ${COLLIDERS.length}개)`);
  console.log(`  서버 준비됨 ->  http://localhost:${PORT}`);
  console.log('  같은 와이파이의 폰에서는 PC의 내부 IP로 접속하세요 (예: http://192.168.0.10:' + PORT + ')');
  console.log('');
});
