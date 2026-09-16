/* =============================================================================
 *  server/interactions.js  -  꾹 눌러서 하는 일 · 구두 경고
 *
 *  해체 · 체포 · 확보 · 증거 회수 · 소생 · 발전기. 전부 "가까이 가서 누르고
 *  있기" 한 동작으로 묶여 있다.
 * ========================================================================== */
import { BACKUP_GENERATOR } from '../public/js/map-data.js';
import { restorePower } from '../public/js/power-state.js';
import { NOISE, hasClearShot, inFieldOfView } from '../public/js/perception.js';
import { warnSuspect, WARNING } from '../public/js/suspect-ai.js';
import { MISSION } from '../public/js/mission-story.js';
import {
  INTERACT_RANGE, PLAYER_EYE, SECURE_SECONDS, ARREST_SECONDS, REVIVE_SECONDS,
  EVIDENCE_SECONDS, SHOUT_COOLDOWN,
} from './constants.js';
import { now, dist2D, at3, emitNoise } from './util.js';
import { makeWorld } from './world.js';

export function interactionTarget(room, player) {
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

export function updateInteractions(room, dt, io) {
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

export function completeInteraction(room, player, target, io) {
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

/**
 * @param line  외친 대사의 번호. 대사 문구 자체는 클라이언트가 갖고 있다 - 글을
 *              그대로 받아 넘기면 남의 화면에 아무 글이나 띄울 수 있다.
 */
export function shout(room, player, io, line = 0) {
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
  if (player.socketId) io.to(player.socketId).emit('shoutResult', tally);
}
