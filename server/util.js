/* =============================================================================
 *  server/util.js  -  여기저기서 쓰는 잔 도구
 * ========================================================================== */
import { COLLIDERS, resolveCircle, zoneAt } from '../public/js/map-data.js';
import { deliverNoise } from '../public/js/suspect-ai.js';
import { wetAt, WET_NOISE } from './events.js';

export const now = () => Date.now();
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** 소리를 낼 위치. 클라이언트가 그 자리에서 들리게 하려면 좌표가 필요하다. */
export const at3 = (o) => ({ x: +o.x.toFixed(2), y: +(o.y || 0).toFixed(2), z: +o.z.toFixed(2) });
export const pick = (list, random = Math.random) => list[Math.floor(random() * list.length)];

/**
 * 정해진 자리에서 조금 흩어 놓는다.
 *
 * 자리 목록이 고정이면 두 번째 판부터는 "저 방 저 구석" 을 외워서 문을 열자마자
 * 그쪽을 쏘게 된다. 벽에 끼지 않는 선에서 흔들어 매 판 다르게 만든다.
 */
export function jitter(spot, random, spread = 1.1, radius = 0.42) {
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

export function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(I,O,0,1) 제외
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ========================================================================== *
 *  소리
 * ========================================================================== */
export function emitNoise(room, x, z, level, type, byId = null) {
  /* 물소리가 발소리를 덮는다. 스프링클러가 도는 구역에서 난 소리는 절반만
   * 전달된다 - 이게 "경보기를 당기고 그 구역으로 들어간다" 를 성립시킨다. */
  const wet = wetAt(room, x, z) ? WET_NOISE : 1;
  const event = { x, z, level: level * wet, type, by: byId, t: now() };
  const colliders = room.doors.colliders();
  for (const npc of room.npcs) {
    if (!npc.alive) continue;
    deliverNoise(npc, event, colliders);
  }
  return event;
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
export const npcPublic = (n) => ({
  id: n.id, kind: n.kind, role: n.role || null, x: +n.x.toFixed(2), y: +n.y.toFixed(2), z: +n.z.toFixed(2),
  yaw: +n.yaw.toFixed(2), hp: Math.max(0, n.hp), maxHp: n.maxHp,
  state: n.state,
  hostage: n.kind === 'civilian' && !!n.hostage,        // 붙잡혀 있는 시민
  holdingHostage: n.kind !== 'civilian' && !!n.hostage, // 시민을 방패로 삼은 자
});
