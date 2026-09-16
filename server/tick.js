/* =============================================================================
 *  server/tick.js  -  20Hz 메인 루프
 *
 *  한 틱에 하는 일의 순서가 그대로 적혀 있다. 순서를 바꾸면 결과가 달라지는
 *  자리가 몇 군데 있어서(예: 목표 판정이 스냅샷보다 먼저), 이 파일은 짧게 둔다.
 * ========================================================================== */
import { powerCutDue } from '../public/js/power-state.js';
import { updateSuspect, updateCivilian } from '../public/js/suspect-ai.js';
import { WEAPONS, BLEED_OUT_MS } from './constants.js';
import { now, dist2D } from './util.js';
import { updateDoorQueue } from './door-actions.js';
import { killPlayer, shotTargets, updateGrenades } from './combat.js';
import { makeWorld } from './world.js';
import { updateInteractions } from './interactions.js';
import { dropExpiredHolds, cutPower, updateObjectives, finishMatch } from './mission.js';

export function tickRoom(room, io) {
  const t = now();
  const dt = Math.min(0.25, (t - room.lastTick) / 1000);
  room.lastTick = t;
  if (room.state !== 'active') return;

  // 유예 시간이 끝난 대원은 이제 진짜로 나간 것으로 친다.
  if (room.heldPlayers.length) dropExpiredHolds(room, io);
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
