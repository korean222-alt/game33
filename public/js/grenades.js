/* =============================================================================
 *  grenades.js  -  투척 장비 (서버/클라이언트 공용)
 *
 *  방 안에서 문을 겨누고 있는 적을 정면으로 상대하면 거의 진다. 섬광탄으로
 *  눈을 가리거나 가스로 자리를 뺏는 것이 정답이 되도록 수치를 잡았다.
 *
 *  물리는 단순하지만 벽/가구에 제대로 튕긴다. 문이 닫혀 있으면 문에 부딪혀
 *  되돌아오므로 "문을 먼저 열고 던진다"는 순서가 생긴다.
 * ========================================================================== */

import { resolveCircle, nearbyColliders, overlaps, isIndoors, MAP, obstaclesBetween } from './map-data.js';
import { NOISE, forwardOf, hasClearShot } from './perception.js';

export const GRENADES = {
  flash: {
    id: 'flash', label: '섬광탄', short: '섬광', fuse: 1.45, radius: 9,
    blindSeconds: 4.6, deafSeconds: 6, noise: NOISE.flashbang, color: 0xf6f2dc, count: 2,
  },
  frag: {
    id: 'frag', label: '파편탄', short: '파편', fuse: 3.1, radius: 6.4,
    damage: 120, noise: NOISE.frag, color: 0x6b7248, count: 1,
  },
  gas: {
    id: 'gas', label: '가스탄', short: '가스', fuse: 1.9, radius: 6.2,
    cloudSeconds: 20, noise: NOISE.gas, color: 0x8fa0a8, count: 2,
  },
};

export const GRENADE_ORDER = ['flash', 'gas', 'frag'];
export const THROW_SPEED = 12.5;
export const UNDERHAND_SPEED = 6.2;

const RADIUS = 0.085;
const GRAVITY = -18;
const RESTITUTION = 0.36;
const ROLL_FRICTION = 0.72;
const top = (c) => (c.y || 0) + c.h;

/** 투척체 하나. origin 은 손 위치, dir 는 조준 방향(정규화). */
export function createGrenade(id, type, origin, dir, { by = null, power = 1, now = 0 } = {}) {
  const spec = GRENADES[type];
  const speed = (power >= 1 ? THROW_SPEED : UNDERHAND_SPEED) * (0.6 + power * 0.4);
  return {
    id, type, by,
    x: origin.x, y: origin.y, z: origin.z,
    vx: dir.x * speed, vy: dir.y * speed + 1.6, vz: dir.z * speed,
    explodeAt: now + spec.fuse * 1000,
    resting: false,
  };
}

/** 한 틱 이동. 폭발 시각이 지났으면 true. */
export function stepGrenade(g, dt, colliders, now) {
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let i = 0; i < steps && !g.resting; i++) {
    const oldY = g.y;
    g.vy += GRAVITY * h;
    let nx = g.x + g.vx * h, ny = g.y + g.vy * h, nz = g.z + g.vz * h;

    // 옆면 충돌: 밀려난 방향을 법선으로 보고 반사한다.
    const fixed = resolveCircle(nx, nz, RADIUS, colliders, Math.max(oldY, ny), 0.18);
    const pushX = fixed.x - nx, pushZ = fixed.z - nz;
    const push = Math.hypot(pushX, pushZ);
    if (push > 1e-4) {
      const n = { x: pushX / push, z: pushZ / push };
      const dot = g.vx * n.x + g.vz * n.z;
      if (dot < 0) {
        g.vx -= (1 + RESTITUTION) * dot * n.x;
        g.vz -= (1 + RESTITUTION) * dot * n.z;
      }
      nx = fixed.x; nz = fixed.z;
    }

    // 바닥 / 가구 윗면
    let floor = 0;
    for (const c of nearbyColliders(nx, nz, RADIUS + 1.2, colliders)) {
      const t = top(c);
      if (t <= oldY + 0.03 && t > floor && overlaps(nx, nz, RADIUS, c)) floor = t;
    }
    if (ny <= floor + 0.001) {
      ny = floor;
      if (Math.abs(g.vy) > 0.75) g.vy = -g.vy * RESTITUTION;
      else {
        g.vy = 0;
        g.vx *= ROLL_FRICTION; g.vz *= ROLL_FRICTION;
        if (Math.hypot(g.vx, g.vz) < 0.12) { g.vx = 0; g.vz = 0; }
      }
    } else if (isIndoors(nx, nz) && ny + 0.1 > MAP.height) {
      ny = MAP.height - 0.1;
      g.vy = -Math.abs(g.vy) * RESTITUTION;
    }

    g.x = nx; g.y = Math.max(0, ny); g.z = nz;
  }
  return now >= g.explodeAt;
}

/* ========================================================================== *
 *  효과
 * ========================================================================== */
/**
 * 섬광 강도 (0~1). 벽 뒤면 0, 등지고 있으면 크게 약해진다.
 * yaw 가 없으면 방향 보정을 생략한다(NPC 는 항상 최악을 가정하지 않도록 yaw 를 넘긴다).
 */
export function flashStrength(origin, victim, colliders, yaw) {
  const spec = GRENADES.flash;
  const eye = { x: victim.x, y: (victim.y || 0) + 1.55, z: victim.z };
  const distance = Math.hypot(eye.x - origin.x, eye.y - origin.y, eye.z - origin.z);
  if (distance > spec.radius) return 0;
  if (!hasClearShot(origin, { x: victim.x, y: victim.y || 0, z: victim.z }, 1.55, colliders)) return 0;
  let strength = 1 - distance / spec.radius;
  if (Number.isFinite(yaw)) {
    const fwd = forwardOf(yaw);
    const dx = origin.x - victim.x, dz = origin.z - victim.z;
    const len = Math.hypot(dx, dz) || 1e-6;
    const dot = (dx * fwd.x + dz * fwd.z) / len;
    strength *= dot > 0.25 ? 1 : dot > -0.3 ? 0.5 : 0.2;
  }
  return Math.max(0, Math.min(1, strength));
}

/** 파편 피해. 벽은 완전히 막고, 허리 높이 가구는 상당 부분만 막는다. */
export function fragDamage(origin, victim, colliders) {
  const spec = GRENADES.frag;
  const center = { x: victim.x, y: (victim.y || 0) + 0.95, z: victim.z };
  const distance = Math.hypot(center.x - origin.x, center.y - origin.y, center.z - origin.z);
  if (distance > spec.radius) return 0;
  // 사람 키보다 높은 고체가 사이에 있으면 파편이 닿지 않는다.
  if (obstaclesBetween(origin, victim, 1.7, colliders) > 0) return 0;
  const clear = hasClearShot(origin, { x: victim.x, y: victim.y || 0, z: victim.z }, 0.95, colliders);
  const falloff = (1 - distance / spec.radius) ** 1.5;
  return Math.round(spec.damage * falloff * (clear ? 1 : 0.35));
}

/** 가스 농도 (0~1). 시야와 무관하지만 벽으로 줄어든다. */
export function gasIntensity(cloud, victim, colliders) {
  const spec = GRENADES.gas;
  const distance = Math.hypot(cloud.x - victim.x, cloud.z - victim.z);
  if (distance > spec.radius) return 0;
  const walls = obstaclesBetween(cloud, victim, 1.2, colliders);
  return Math.max(0, (1 - distance / spec.radius) * 0.55 ** walls);
}

/** 소지 가능한 기본 장비 수. */
export function startingGrenades() {
  const out = {};
  for (const key of GRENADE_ORDER) out[key] = GRENADES[key].count;
  return out;
}
