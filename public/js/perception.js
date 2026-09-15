/* =============================================================================
 *  perception.js  -  소리와 시야 (서버/클라이언트 공용, 순수 함수)
 *
 *  원칙
 *    NPC 는 "본 것"과 "들은 것"만 안다. 벽 너머의 플레이어 위치를 아는 경로는
 *    이 파일 어디에도 없다. 그래서 몰래 접근이 통하고, 총을 쏘면 들킨다.
 * ========================================================================== */

import { obstaclesBetween, rayObstacleDistance, isIndoors } from './map-data.js';

/** 행동별 상대 소음 (0~1). 설계 문서의 표를 그대로 옮겼다. */
export const NOISE = {
  crouchWalk: 0.06, walk: 0.12, run: 0.32, sprint: 0.6, land: 0.25,
  doorOpen: 0.32, doorClose: 0.28, doorPeek: 0.06, doorUnlock: 0.1,
  doorKick: 0.86, doorBreach: 1.0,
  shot: 1.0, reload: 0.12, shout: 0.55,
  flashbang: 0.95, frag: 1.0, gas: 0.5,
  bodyFall: 0.3, glass: 0.5, defuse: 0.08,
};

/** 이보다 약하게 도달한 소리는 알아채지 못한다. */
export const HEAR_FLOOR = 0.075;
/** 이보다 세게 들리면 "저기서 무슨 일이 났다"고 확신하고 움직인다. */
export const HEAR_INVESTIGATE = 0.2;

/**
 * 소리가 청취자에게 도달하는 세기.
 *   전달된 소리 = 원래 크기 x 거리 감쇠 x 벽 투과율^(벽 개수)
 */
export function heardLevel(level, from, to, colliders, wallTransmission = 0.42) {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const falloff = 1 / (1 + (distance / 6.5) ** 1.7);
  const walls = obstaclesBetween(from, to, 1.35, colliders);
  return level * falloff * wallTransmission ** walls;
}

/** yaw 기준 전방 벡터. yaw = 0 은 -Z 를 본다 (맵 규약). */
export const forwardOf = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

/** 목표가 화각 안에 있는가. peripheral 이내는 뒤통수도 인지한다. */
export function inFieldOfView(observer, target, fov, peripheral = 2.6) {
  const dx = target.x - observer.x, dz = target.z - observer.z;
  const distance = Math.hypot(dx, dz) || 1e-6;
  if (distance <= peripheral) return true;
  const fwd = forwardOf(observer.yaw);
  return (dx * fwd.x + dz * fwd.z) / distance >= Math.cos(fov / 2);
}

/**
 * 눈 -> 목표 몸통으로 가는 광선이 트여 있는가.
 * 문이 닫혀 있으면 colliders 에 문이 들어 있으므로 자동으로 막힌다.
 */
export function hasClearShot(eye, target, targetHeight, colliders) {
  const aim = {
    x: target.x - eye.x,
    y: (target.y || 0) + targetHeight - eye.y,
    z: target.z - eye.z,
  };
  const length = Math.hypot(aim.x, aim.y, aim.z) || 1e-6;
  const dir = { x: aim.x / length, y: aim.y / length, z: aim.z / length };
  return rayObstacleDistance(eye, dir, length, colliders) >= length - 0.02;
}

/**
 * 발견 확률 계수. 어두운 실내, 웅크린 자세, 정지 상태는 발견을 늦춘다.
 * 0 이면 못 본다.
 *
 * 손전등(target.light)은 이 계산을 뒤집는다. 켜면 내가 보이지만, 어둠 속에서
 * 움직이는 불빛은 그 자체가 표적이라 훨씬 먼저 눈에 띈다. 밝은 곳에서는 이미
 * 잘 보이므로 더 나빠질 것이 별로 없다 - 그래서 어두울수록 손해가 크다.
 */
export function visibilityFactor(target, distance, brightness) {
  let factor = 1 - Math.min(0.72, distance / 26);
  if (target.crouch) factor *= 0.72;
  if (target.sprint) factor *= 1.25;
  else if (!target.moving) factor *= 0.82;
  const lit = target.light ? Math.max(brightness, 0.85) : brightness;
  factor *= 0.45 + lit * 0.55;
  return Math.max(0, factor);
}

/** 조명 밝기 추정 (0~1). 가까운 광원의 합. 실외의 밤은 어둡다. */
export function brightnessAt(x, z, lights) {
  let total = isIndoors(x, z) ? 0.18 : 0.1;
  for (const light of lights) {
    const d = Math.hypot(light.x - x, light.z - z);
    if (d > light.distance) continue;
    total += (1 - d / light.distance) * Math.min(1, light.intensity / 70);
  }
  return Math.min(1, total);
}

/**
 * 명중 확률. 거리 / 자세 / 이동 / 사기 / 제압 / 섬광을 모두 반영한다.
 * 서버와 테스트가 같은 식을 쓴다.
 */
export function hitChance({ skill, distance, targetMoving, targetSprinting, targetCrouch,
  suppression = 0, morale = 1, blinded = false, gas = 0 }) {
  if (blinded) return 0;
  let chance = skill * Math.max(0.22, Math.min(1, 1.3 - distance / 24));
  if (targetSprinting) chance *= 0.68;
  else if (targetMoving) chance *= 0.86;
  if (targetCrouch) chance *= 0.84;
  chance *= 1 - Math.min(0.65, suppression * 0.55);
  chance *= 0.6 + Math.min(1, morale) * 0.4;
  chance *= 1 - Math.min(0.5, gas * 0.5);
  return Math.max(0, Math.min(0.95, chance));
}
