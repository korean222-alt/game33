/* =============================================================================
 *  server/combat.js  -  피해 · 사망 · 사격 판정 · 투척 장비
 *
 *  총알이 어디에 맞았는지, 누가 쓰러졌는지, 수류탄이 무엇을 했는지를 서버가
 *  혼자 정한다. 클라이언트가 보내는 것은 총구의 방향뿐이다.
 * ========================================================================== */
import { COLLIDERS, rayObstacleDistance, isIndoors } from '../public/js/map-data.js';
import { NOISE, hasClearShot } from '../public/js/perception.js';
import { SUSPECT_EYE } from '../public/js/suspect-ai.js';
import {
  GRENADES, createGrenade, stepGrenade, flashStrength, flashSeconds, fragDamage, gasIntensity,
} from '../public/js/grenades.js';
import { traceShot } from '../public/js/shot-trace.js';
import { MISSION } from '../public/js/mission-story.js';
import { WEAPONS, PLAYER_EYE, BLEED_OUT_MS } from './constants.js';
import { now, clamp, dist2D, at3, emitNoise } from './util.js';
import { checkMissionEnd } from './mission.js';

export function damagePlayer(room, player, dmg, byId, io, from = null) {
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

export function killPlayer(room, player, io) {
  player.downed = false;
  player.alive = false;
  player.dead = true;
  io.to(room.code).emit('playerDead', { id: player.id, ...at3(player) });
  checkMissionEnd(room, io);
}

/** 교전 규칙 위반 기록. */
export function roeViolation(room, byId, reason, io) {
  room.stats.roeViolations++;
  io.to(room.code).emit('roeViolation', { by: byId, reason });
  io.to(room.code).emit('radio', { text: `지휘부: 교전 규칙 위반 기록됨 — ${reason}` });
}

export function damageNpc(room, npc, dmg, byId, io, part = 'body') {
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

export function shotTargets(room) {
  return room.npcs.filter((n) => n.alive).map((n) => ({
    id: n.id, x: n.x, y: n.y, z: n.z, alive: true,
  }));
}

export function resolveShot(room, shooter, origin, dir, io, viewTime) {
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

export function throwGrenade(room, player, type, dir, power, io) {
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

export function explode(room, grenade, io) {
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
      if (p.socketId) io.to(p.socketId).emit('flashed', { seconds });
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

export function updateGrenades(room, dt, io) {
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
