/* =============================================================================
 *  server/world.js  -  NPC 한 마리가 세상을 보는 창
 *
 *  suspect-ai.js 는 맵도 방도 모른다. 그 대신 "지금 보이는 사람", "길", "밝기",
 *  "쏘면 어떻게 되는가" 를 물어볼 수 있는 이 객체 하나를 받는다. 덕분에 AI 는
 *  서버 없이도 테스트할 수 있다.
 * ========================================================================== */
import { LIGHTS, POSTS, COVER_POINTS, findRoute } from '../public/js/map-data.js';
import { PHASES } from '../public/js/mission-story.js';
import { DOOR, isBlocking } from '../public/js/doors.js';
import { NOISE, brightnessAt } from '../public/js/perception.js';
import { SUSPECT_EYE } from '../public/js/suspect-ai.js';
import {
  DIFFICULTY, outdoorZones, outdoorLights, PLAYER_EYE, SUSPECT_DAMAGE,
} from './constants.js';
import { now, dist2D, at3, emitNoise } from './util.js';
import { damagePlayer } from './combat.js';
import { setDoorState } from './door-actions.js';
import { wetAt, WET_BRIGHTNESS } from './events.js';

/** 순찰로 한 번에 건너갈 수 있는 거리. 이보다 멀면 방을 옮기지 않는다. */
const ROAM_RANGE = 26;

export function makeWorld(room, dt, io) {
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

  /* 잔여 인원 단계인가.
   *
   *  4단계(확보)와 5단계(철수)에서는 남은 몇 명이 더 자주, 더 멀리 돈다.
   *  구석에 박혀 있는 마지막 한 명 때문에 방 열여덟 칸을 다시 여는 것이
   *  사옥에서 실제로 판을 멎게 한 원인이었다. */
  const phaseId = PHASES[room.phase]?.id;
  const hunting = phaseId === 'clear' || phaseId === 'extract';
  const outdoor = outdoorZones();
  /* 마당 사람은 마당에서, 건물 사람은 건물에서 돈다. 이 경계를 넘게 두면
   * 1단계(외곽 무장 인원 정리)가 건물 안에서 끝나야 하는 일이 생긴다. */
  const sameSide = (a, b) => outdoor.includes(a) === outdoor.includes(b);

  return {
    now: t, dt, colliders, doors: room.doors, players,
    skillScale: diff.skill,
    patrolScale: hunting ? 2.4 : 1,
    alliesDown: downCount,
    alliesNear: 0,
    random: Math.random,
    /* 저택 전기가 끊기면 실내등은 계산에서 빠진다. 그래서 정전 뒤에는
     * 실내에서 서로가 잘 안 보인다 - 적도, 나도.
     *
     * 스프링클러가 도는 구역도 같은 자리에서 처리한다. 불은 켜져 있지만
     * 물이 빛을 흩어서 사람이 늦게 눈에 띈다. */
    brightness: (x, z) => brightnessAt(x, z, room.power ? LIGHTS : outdoorLights())
      * (wetAt(room, x, z) ? WET_BRIGHTNESS : 1),
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
    /**
     * 순찰해서 갈 자리.
     *
     *  예전에는 자기 방 안의 다른 자리만 골랐다. 방이 여섯 칸인 저택에서는
     *  그걸로 충분했지만, 열여덟 칸짜리 사옥에서는 "저 사람은 저 방에서 평생
     *  안 나온다" 가 된다. 이제 옆방까지 나간다 - 문을 열고 지나가므로 소리도
     *  난다. 그 소리가 "어디에 누가 남았는지" 를 알려 주는 단서가 된다.
     */
    roamPoint: (roomName, npc) => {
      const here = POSTS.filter((p) => p.room === roomName && dist2D(p, npc) > 1.5);
      const away = POSTS.filter((p) => p.room !== roomName
        && sameSide(p.room, roomName) && dist2D(p, npc) < ROAM_RANGE);
      const pool = away.length && Math.random() < (hunting ? 0.65 : 0.3) ? away : here;
      if (!pool.length) return null;
      return pool[Math.floor(Math.random() * pool.length)];
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
      const outdoor = outdoorZones();
      const away = POSTS.filter((p) => p.room !== npc.room && !outdoor.includes(p.room));
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
      // 역할이 정한 한 발의 무게. 저격수는 34, 나머지는 13.
      const dmg = Math.round((npc.damage ?? SUSPECT_DAMAGE) * diff.dmgMul * (0.85 + Math.random() * 0.35));
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
      const targetSocket = target?.id ? room.players.get(target.id)?.socketId : null;
      if (targetSocket) {
        io.to(targetSocket).emit('spotted', {
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
