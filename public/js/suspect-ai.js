/* =============================================================================
 *  suspect-ai.js  -  용의자 / 민간인 행동 (서버가 구동, 테스트가 검증)
 *
 *  설계 목표
 *    1) 플레이어를 자동으로 따라오지 않는다. 본 것과 들은 것만 안다.
 *    2) 각자 담당 구역이 있고, 대부분은 그 방을 지킨다. 겁이 많은 자는 도망치고
 *       매복형은 문을 겨누고 기다린다.
 *    3) 체력만 보지 않고 사기를 계산한다. 사기가 꺾이면 무기를 버리고 항복한다.
 *    4) 엄폐물을 쓰고, 제압 사격을 받으면 머리를 숙인다.
 *
 *  순수하지 않은 동작(발사, 문 열기, 소리 발생)은 모두 world 인터페이스를 통해
 *  서버에 위임한다. 덕분에 테스트에서 가짜 world 로 행동을 검증할 수 있다.
 * ========================================================================== */

import { resolveCircle, groundHeight, zoneAt, COVER_POINTS } from './map-data.js';
import {
  NOISE, HEAR_FLOOR, HEAR_INVESTIGATE, heardLevel, inFieldOfView,
  hasClearShot, visibilityFactor, hitChance,
} from './perception.js';

export const SUSPECT_RADIUS = 0.38;
export const SUSPECT_EYE = 1.58;
export const CROUCH_EYE = 1.12;

/** 성향. 같은 방에 같은 인원이 있어도 매번 다른 전투가 되도록 한다. */
export const PERSONALITIES = {
  aggressive: { label: '공격적', hold: 0.15, push: 1.0, patrol: 0.45, react: 0.85, skill: 0.62, moraleFloor: 0.16, surrender: 0.35 },
  defensive: { label: '방어적', hold: 0.75, push: 0.25, patrol: 0.18, react: 1.0, skill: 0.58, moraleFloor: 0.3, surrender: 0.55 },
  ambusher: { label: '매복형', hold: 0.95, push: 0.05, patrol: 0.05, react: 0.78, skill: 0.66, moraleFloor: 0.26, surrender: 0.5 },
  coward: { label: '겁이 많음', hold: 0.2, push: 0.05, patrol: 0.4, react: 1.4, skill: 0.44, moraleFloor: 0.62, surrender: 0.8 },
  leader: { label: '지휘자', hold: 0.6, push: 0.5, patrol: 0.1, react: 0.8, skill: 0.7, moraleFloor: 0.1, surrender: 0.2 },
};

const SPEED = { walk: 1.2, alert: 2.3, sprint: 3.3, crouch: 0.95 };
const TURN = 4.6;
const VIEW = 20;
const FOV = Math.PI * 0.78;
const FIRE_GAP = 900;         // 점사 사이의 쉬는 시간
const BURST = 3;              // 한 점사에 쏘는 발수
const BURST_GAP = 115;
const UNAWARE_DELAY = 420;    // 태세가 안 된 상태에서 발견했을 때의 추가 지연
const MEMORY = 7000;
const MAG = 30;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/* ========================================================================== *
 *  생성
 * ========================================================================== */
export function createSuspect(id, { post, personality, hp = 100, kind = 'suspect', hostage = null }) {
  return {
    id, kind,
    x: post.x, z: post.z, y: 0, yaw: post.yaw ?? 0,
    hp, maxHp: hp, alive: true,
    personality, traits: PERSONALITIES[personality] || PERSONALITIES.defensive,
    room: post.room || zoneAt(post.x, post.z),
    post: { x: post.x, z: post.z, yaw: post.yaw ?? 0 },
    state: 'guard', stateSince: 0, stateUntil: 0,
    morale: 1, suppression: 0, blindUntil: 0, gas: 0,
    targetId: null, lastSeen: null, lastHeard: null,
    route: null, routeGoal: null, routeUntil: 0,
    cover: null, crouch: 0, moving: 0,
    ammo: MAG, reloadUntil: 0, nextFire: 0, burst: BURST, spotTime: 0,
    hostage, weaponDropped: false, arrested: false, hands: 0,
    doorUntil: 0, shoutedAt: 0,
    // 구두 경고로 쌓이는 압박. 시간이 지나면 풀린다.
    pressure: 0, warnedAt: 0, defiantUntil: 0,
  };
}

export function createCivilian(id, spot) {
  return {
    id, kind: 'civilian',
    x: spot.x, z: spot.z, y: 0, yaw: spot.yaw ?? Math.random() * Math.PI * 2,
    hp: 100, maxHp: 100, alive: true,
    room: spot.room || zoneAt(spot.x, spot.z),
    home: { x: spot.x, z: spot.z },
    state: 'calm', stateSince: 0, stateUntil: 0,
    panic: 0, hands: 0, secured: false, crouch: 0, moving: 0,
    route: null, routeGoal: null, routeUntil: 0,
    lastHeard: null, hostage: false,
  };
}

/* ========================================================================== *
 *  소리 수신
 * ========================================================================== */
/** 소리 하나를 NPC 에게 전달한다. 실제로 들렸으면 true. */
export function deliverNoise(npc, event, colliders) {
  if (!npc.alive || npc.arrested || npc.secured) return false;
  const level = heardLevel(event.level, event, npc, colliders);
  if (level < HEAR_FLOOR) return false;
  const previous = npc.lastHeard;
  if (previous && previous.level > level && event.t - previous.t < 1200) return false;
  npc.lastHeard = { x: event.x, z: event.z, t: event.t, level, type: event.type, by: event.by };
  return true;
}

/* ========================================================================== *
 *  이동
 * ========================================================================== */
function faceToward(npc, tx, tz, dt) {
  const want = Math.atan2(-(tx - npc.x), -(tz - npc.z));
  let diff = want - npc.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  npc.yaw += clamp(diff, -TURN * dt, TURN * dt);
  return Math.abs(diff) < 0.2;
}

/** 경로를 따라 목표로 한 걸음. 도착하면 true. */
function stepToward(npc, goal, speed, w) {
  const key = `${Math.round(goal.x * 2)}:${Math.round(goal.z * 2)}`;
  if (npc.routeGoal !== key || !npc.route || w.now > npc.routeUntil) {
    npc.route = w.route(npc, goal);
    npc.routeGoal = key;
    npc.routeUntil = w.now + 2200;
  }
  while (npc.route?.length && dist2(npc, npc.route[0]) < 0.42) npc.route.shift();
  const waypoint = npc.route?.length ? npc.route[0] : goal;

  // 닫힌 문이 앞을 막으면 열고 지나간다 (소리가 난다).
  const blocking = w.doors?.blockingBetween(npc, waypoint);
  if (blocking) {
    if (w.now >= npc.doorUntil) {
      npc.doorUntil = w.now + 900;
      w.openDoor(npc, blocking);
    }
    npc.moving = 0;
    faceToward(npc, blocking.x, blocking.z, w.dt);
    return false;
  }

  const dx = waypoint.x - npc.x, dz = waypoint.z - npc.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.06) { npc.moving = 0; return dist2(npc, goal) < 0.7; }
  faceToward(npc, waypoint.x, waypoint.z, w.dt);

  const nx = npc.x + (dx / d) * speed * w.dt;
  const nz = npc.z + (dz / d) * speed * w.dt;
  const fixed = resolveCircle(nx, nz, SUSPECT_RADIUS, w.colliders, npc.y, 1.7);
  if (Math.hypot(fixed.x - nx, fixed.z - nz) > 0.02) {
    // 벽에 걸리면 옆으로 미끄러져 본다. 그래도 안 되면 경로를 다시 계산한다.
    const side = (npc.id.charCodeAt(npc.id.length - 1) % 2) ? 1 : -1;
    const sx = npc.x + (-(dz / d)) * side * speed * w.dt;
    const sz = npc.z + (dx / d) * side * speed * w.dt;
    const slid = resolveCircle(sx, sz, SUSPECT_RADIUS, w.colliders, npc.y, 1.7);
    npc.x = slid.x; npc.z = slid.z;
    npc.routeUntil = 0;
  } else {
    npc.x = fixed.x; npc.z = fixed.z;
  }
  npc.y = groundHeight(npc.x, npc.z, SUSPECT_RADIUS, w.colliders, npc.y);
  npc.moving = 1;
  return dist2(npc, goal) < 0.7 && !npc.route?.length;
}

/* ========================================================================== *
 *  지각
 * ========================================================================== */
function eyeOf(npc) {
  return { x: npc.x, y: npc.y + (npc.crouch ? CROUCH_EYE : SUSPECT_EYE), z: npc.z };
}

/** 지금 보이는 플레이어 중 가장 위협적인 대상. */
export function spotTarget(npc, w) {
  if (w.now < npc.blindUntil) return null;
  const eye = eyeOf(npc);
  let best = null, bestScore = 0;
  for (const p of w.players) {
    if (!p.alive) continue;
    const d = dist2(npc, p);
    if (d > VIEW) continue;
    if (!inFieldOfView(npc, p, FOV)) continue;
    if (!hasClearShot(eye, p, p.crouch ? 0.95 : 1.3, w.colliders)) continue;
    const factor = visibilityFactor(p, d, w.brightness(p.x, p.z));
    if (factor <= 0.12) continue;
    const score = factor * (1 + 6 / Math.max(1.5, d));
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

/* ========================================================================== *
 *  사기
 * ========================================================================== */
export function updateMorale(npc, w) {
  const traits = npc.traits;
  const wounded = 1 - npc.hp / npc.maxHp;
  let target = 1
    - wounded * 0.85
    - w.alliesDown * 0.16
    - npc.suppression * 0.3
    - (npc.pressure || 0) * 0.45
    - npc.gas * 0.35
    - (w.now < npc.blindUntil ? 0.3 : 0);
  if (npc.hostage) target += 0.3;
  if (w.alliesNear > 0) target += Math.min(0.15, w.alliesNear * 0.07);
  if (npc.kind === 'hvt') target += 0.15;
  npc.morale = clamp(npc.morale + (clamp(target, 0, 1.2) - npc.morale) * Math.min(1, w.dt * 1.6), 0, 1.2);
  return npc.morale;
}

/** 항복할 것인가. 인질을 잡고 있으면 항복하지 않는다. */
export function shouldSurrender(npc, w, visible) {
  if (npc.hostage || npc.state === 'surrender') return false;
  if (npc.morale > npc.traits.moraleFloor) return false;
  // 눈앞에 총구가 있고 사기가 바닥이면 손을 든다. 아니면 일단 도망친다.
  const pressured = visible && dist2(npc, visible) < 14;
  return pressured && w.random() < npc.traits.surrender;
}

/* ========================================================================== *
 *  구두 경고
 *
 *  "손 들어" 하고 외치면 무조건 항복하는 게임은 긴장이 없고, 아무 반응도
 *  없으면 버튼이 고장 난 것처럼 보인다. 그래서 확률로 갈린다.
 *
 *    총구를 겨눈 채로 가까이에서 외칠수록  -> 항복할 확률이 오른다
 *    사기가 남아 있고 공격 성향이면        -> 오히려 달려든다
 *    인질을 잡고 있으면                    -> 통하지 않는다
 * ========================================================================== */
export const WARNING = {
  range: 12,                 // 목소리가 압박이 되는 거리(m)
  aimAngle: Math.PI / 7,     // 총구를 겨눴다고 볼 각도(±약 26도)
  cooldown: 2200,            // 같은 사람에게 다시 통하기까지(ms)
  pressureDecay: 0.14,       // 초당 압박 감소량
};

/**
 * 지금 이 사람이 항복할 확률.
 * 순수 함수라 테스트에서 상황별로 값을 바로 확인할 수 있다.
 */
export function surrenderChance(npc, { aimed = false, distance = 6, alliesDown = 0 } = {}) {
  if (!npc.alive || npc.hostage || npc.state === 'surrender' || npc.arrested) return 0;
  const traits = npc.traits || PERSONALITIES.defensive;
  // 총구를 겨누지 않고 소리만 지르면 효과가 크게 떨어진다.
  let chance = traits.surrender * (aimed ? 1 : 0.3);
  chance *= clamp(1.3 - (npc.morale ?? 1), 0.12, 1.3);
  chance += (1 - npc.hp / npc.maxHp) * 0.35;           // 이미 다쳤으면 포기하기 쉽다
  chance += Math.min(0.22, alliesDown * 0.075);        // 동료가 쓰러지는 것을 봤다
  chance += Math.min(0.28, (npc.pressure || 0) * 0.28); // 계속 소리치면 눌린다
  chance -= Math.max(0, (distance - 6) * 0.045);       // 멀리서 외치면 덜 무섭다
  if (npc.kind === 'hvt') chance *= 0.45;              // 주범은 쉽게 꺾이지 않는다
  return clamp(chance, 0, 0.95);
}

/**
 * 경고 한 번의 결과.
 * @returns 'surrender' 항복 | 'defy' 반항(덤벼든다) | 'shaken' 흔들림 | 'ignored'
 */
export function warnSuspect(npc, w, { aimed = false, distance = 6, alliesDown = 0, from = null } = {}) {
  if (!npc.alive || npc.arrested || npc.state === 'surrender') return 'ignored';
  if (w.now - (npc.warnedAt || 0) < WARNING.cooldown) return 'ignored';
  npc.warnedAt = w.now;
  npc.pressure = clamp((npc.pressure || 0) + (aimed ? 0.45 : 0.2), 0, 1);
  npc.suppression = clamp((npc.suppression || 0) + (aimed ? 0.25 : 0.1), 0, 1);

  if (npc.hostage) return 'defy';     // 인질을 방패로 삼은 자는 응하지 않는다

  if (w.random() < surrenderChance(npc, { aimed, distance, alliesDown })) {
    setState(npc, 'surrender', w);
    npc.hands = 1; npc.crouch = 1; npc.weaponDropped = true; npc.moving = 0;
    w.onSurrender?.(npc);
    return 'surrender';
  }

  // 말을 안 듣는 쪽. 사기가 남아 있고 공격적일수록 오히려 달려든다.
  const defiance = clamp((1 - npc.traits.surrender) * 0.6 + npc.traits.push * 0.35, 0, 0.9)
    * clamp(npc.morale ?? 1, 0.2, 1.2);
  if (w.random() < defiance) {
    npc.defiantUntil = w.now + 5000;
    if (from) {
      npc.lastHeard = { x: from.x, z: from.z, t: w.now, level: 1, type: 'shout', by: from.id };
      npc.lastSeen = { x: from.x, z: from.z, t: w.now };
      npc.targetId = from.id ?? npc.targetId;
    }
    if (npc.state !== 'engage') setState(npc, 'engage', w);
    npc.spotTime = w.now;
    npc.burst = BURST;
    w.onDefy?.(npc);
    return 'defy';
  }
  return 'shaken';
}

/* ========================================================================== *
 *  엄폐
 * ========================================================================== */
/** 위협을 막아 주면서 아직 문을 볼 수 있는 자리. */
export function pickCover(npc, threat, w) {
  let best = null, bestScore = -Infinity;
  for (const point of COVER_POINTS) {
    if (point.room !== npc.room) continue;
    const toThreat = Math.hypot(point.x - threat.x, point.z - threat.z);
    if (toThreat < 2.2) continue;
    // 엄폐물이 나와 위협 사이에 있어야 의미가 있다.
    const behind = Math.hypot(point.cx - threat.x, point.cz - threat.z) < toThreat;
    const travel = dist2(npc, point);
    if (travel > 11) continue;
    const score = (behind ? 3 : 0) + Math.min(3, toThreat / 4) - travel * 0.22
      + (point.height > 0.85 ? 0.8 : 0);
    if (score > bestScore) { bestScore = score; best = point; }
  }
  return best;
}

/* ========================================================================== *
 *  상태 전이
 * ========================================================================== */
function setState(npc, state, w, holdMs = 0) {
  if (npc.state === state) { if (holdMs) npc.stateUntil = w.now + holdMs; return; }
  npc.state = state;
  npc.stateSince = w.now;
  npc.stateUntil = holdMs ? w.now + holdMs : 0;
  npc.route = null; npc.routeGoal = null;
  w.onStateChange?.(npc);
}

/* ========================================================================== *
 *  용의자 한 명의 한 틱
 * ========================================================================== */
export function updateSuspect(npc, w) {
  if (!npc.alive) { npc.moving = 0; return; }
  npc.suppression = Math.max(0, npc.suppression - w.dt * 0.45);
  npc.pressure = Math.max(0, (npc.pressure || 0) - w.dt * WARNING.pressureDecay);
  npc.gas = Math.max(0, npc.gas - w.dt * 0.25);
  if (npc.reloadUntil && w.now >= npc.reloadUntil) { npc.reloadUntil = 0; npc.ammo = MAG; }

  if (npc.arrested) { npc.moving = 0; npc.crouch = 1; npc.hands = 1; return; }

  if (npc.state === 'surrender') {
    npc.moving = 0; npc.crouch = 1; npc.hands = 1; npc.weaponDropped = true;
    return;
  }

  const visible = spotTarget(npc, w);
  updateMorale(npc, w);

  if (visible) {
    const unaware = npc.state === 'guard' || npc.state === 'patrol';
    npc.targetId = visible.id;
    npc.lastSeen = { x: visible.x, z: visible.z, t: w.now };
    if (npc.state !== 'engage' && npc.state !== 'surrender') {
      // 총을 내리고 있었다면 들어 올리는 시간이 더 걸린다.
      npc.spotTime = w.now + (unaware ? UNAWARE_DELAY : 0);
      npc.burst = BURST;
      setState(npc, 'engage', w);
      if (w.now - npc.shoutedAt > 6000) {
        npc.shoutedAt = w.now;
        w.noise(npc.x, npc.z, NOISE.shout, 'contact', npc.id);
        w.onContact?.(npc, visible);
      }
    }
  } else if (npc.state === 'engage') {
    setState(npc, 'search', w, 4200);
  }

  if (shouldSurrender(npc, w, visible)) {
    setState(npc, 'surrender', w);
    w.onSurrender?.(npc);
    return;
  }

  // 들은 소리에 대한 반응. 교전 중이면 소리는 무시한다.
  const heard = npc.lastHeard;
  if (heard && npc.state !== 'engage' && w.now - heard.t < 2500) {
    const loud = heard.level >= HEAR_INVESTIGATE;
    const atMyDoor = w.doorNear(heard, npc.room);
    if (loud && atMyDoor && npc.traits.hold > 0.5) {
      // 내 방 문이 열렸다. 나가지 않고 문을 겨눈 채 숨는다.
      setState(npc, 'ambush', w, 12000);
      npc.ambushAt = { x: heard.x, z: heard.z };
    } else if (loud && npc.morale > npc.traits.moraleFloor && w.random() < npc.traits.push) {
      setState(npc, 'investigate', w, 9000);
    } else if (npc.state === 'guard' || npc.state === 'patrol') {
      setState(npc, 'suspicious', w, 2600);
    }
  }

  switch (npc.state) {
    case 'guard': return guard(npc, w);
    case 'patrol': return patrol(npc, w);
    case 'suspicious': return suspicious(npc, w);
    case 'investigate': return investigate(npc, w);
    case 'ambush': return ambush(npc, w);
    case 'engage': return engage(npc, w, visible);
    case 'search': return search(npc, w);
    case 'retreat': return retreat(npc, w);
    default: return guard(npc, w);
  }
}

/* ---- 평상시: 담당 자리를 지키거나 방 안을 조금 돌아다닌다 ------------------ */
function guard(npc, w) {
  npc.crouch = 0;
  if (dist2(npc, npc.post) > 1.1) { stepToward(npc, npc.post, SPEED.walk, w); return; }
  npc.moving = 0;
  // 가끔 두리번거린다. 순찰 성향이면 방 안의 다른 자리로 옮긴다.
  if (w.now < npc.stateUntil) { faceToward(npc, npc.x + Math.sin(npc.yaw + 1), npc.z, w.dt); return; }
  npc.stateUntil = w.now + 2600 + w.random() * 4200;
  if (w.random() < npc.traits.patrol) {
    const spot = w.roamPoint(npc.room, npc);
    if (spot) { setState(npc, 'patrol', w, 14000); npc.roam = spot; return; }
  }
  // 담당 방향에서 크게 벗어나지 않게 둘러본다. 배치 시점에 등을 돌리고 있던
  // 경비가 곧바로 시작 지점을 보게 되면 "정보 없이 즉사" 가 된다.
  npc.yaw = npc.post.yaw + (w.random() - 0.5) * 1.1;
}

function patrol(npc, w) {
  npc.crouch = 0;
  if (!npc.roam || w.now > npc.stateUntil) { setState(npc, 'guard', w); return; }
  if (stepToward(npc, npc.roam, SPEED.walk, w)) setState(npc, 'guard', w, 2400);
}

/* ---- 작은 소리: 멈춰서 그쪽을 본다 --------------------------------------- */
function suspicious(npc, w) {
  npc.moving = 0;
  npc.crouch = 0;
  const look = npc.lastHeard || npc.post;
  faceToward(npc, look.x, look.z, w.dt);
  if (w.now > npc.stateUntil) setState(npc, 'guard', w, 1500);
}

/* ---- 큰 소리: 소리가 난 쪽으로 가 본다 ----------------------------------- */
function investigate(npc, w) {
  npc.crouch = 0;
  const goal = npc.lastHeard || npc.post;
  if (w.now > npc.stateUntil) { setState(npc, 'guard', w); return; }
  if (stepToward(npc, goal, SPEED.alert, w)) {
    // 도착했는데 아무것도 없으면 주변을 살피고 복귀한다.
    npc.moving = 0;
    faceToward(npc, npc.x + Math.cos(w.now / 700), npc.z + Math.sin(w.now / 700), w.dt);
    if (w.now - npc.stateSince > 4200) setState(npc, 'guard', w);
  }
}

/* ---- 매복: 문을 겨누고 엄폐물 뒤에서 기다린다 ---------------------------- */
function ambush(npc, w) {
  const threat = npc.ambushAt || npc.lastHeard || npc.post;
  if (!npc.cover || dist2(npc, npc.cover) > 12) npc.cover = pickCover(npc, threat, w) || npc.post;
  if (dist2(npc, npc.cover) > 0.8) { stepToward(npc, npc.cover, SPEED.alert, w); return; }
  npc.moving = 0;
  npc.crouch = 1;
  faceToward(npc, threat.x, threat.z, w.dt);
  if (w.now > npc.stateUntil) { npc.cover = null; setState(npc, 'guard', w); }
}

/* ---- 교전 ----------------------------------------------------------------- */
function engage(npc, w, visible) {
  const target = visible || w.playerById(npc.targetId);
  if (!target || !target.alive) { setState(npc, 'search', w, 3600); return; }
  const d = dist2(npc, target);

  // 사기가 남아 있고 공격 성향이면 거리를 좁히고, 아니면 엄폐물로 붙는다.
  const wantsCover = npc.traits.hold > 0.4 || npc.morale < 0.75 || npc.suppression > 0.3;
  if (wantsCover) {
    if (!npc.cover || w.now - (npc.coverAt || 0) > 5200) {
      npc.cover = pickCover(npc, target, w);
      npc.coverAt = w.now;
    }
    if (npc.cover && dist2(npc, npc.cover) > 0.9) { stepToward(npc, npc.cover, SPEED.alert, w); }
    else { npc.moving = 0; npc.crouch = npc.suppression > 0.35 ? 1 : 0; }
  } else if (d > 6.5) {
    stepToward(npc, { x: target.x, z: target.z }, SPEED.alert, w);
  } else {
    npc.moving = 0;
    npc.crouch = 0;
  }

  const aimed = faceToward(npc, target.x, target.z, w.dt);
  if (!visible) return;                                    // 지금 안 보이면 쏘지 않는다
  if (w.now < npc.blindUntil) { npc.crouch = 1; npc.moving = 0; return; }
  if (npc.reloadUntil) return;
  if (npc.ammo <= 0) { npc.reloadUntil = w.now + 2600; w.noise(npc.x, npc.z, NOISE.reload, 'reload', npc.id); return; }
  if (!aimed) return;
  if (w.now - npc.spotTime < 340 * npc.traits.react) return;
  if (w.now < npc.nextFire) return;

  // 점사: BURST 발을 짧게 끊어 쏘고 한 박자 쉰다. 쉬는 동안이 반격할 틈이다.
  const shotInBurst = BURST - npc.burst;
  if (npc.burst > 0) { npc.burst--; npc.nextFire = w.now + BURST_GAP; }
  else { npc.burst = BURST; npc.nextFire = w.now + FIRE_GAP * (0.8 + w.random() * 0.6); }
  npc.ammo--;

  const chance = hitChance({
    // 연달아 쏘면 총구가 들려서 뒤쪽 탄은 빗나간다.
    skill: npc.traits.skill * w.skillScale * Math.max(0.4, 1 - shotInBurst * 0.18),
    distance: d,
    targetMoving: !!target.moving,
    targetSprinting: !!target.sprint,
    targetCrouch: !!target.crouch,
    suppression: npc.suppression,
    morale: npc.morale,
    gas: npc.gas,
  });
  w.fire(npc, target, w.random() < chance);
  w.noise(npc.x, npc.z, NOISE.shot, 'shot', npc.id);
}

/* ---- 놓친 대상을 마지막 위치에서 찾는다 ---------------------------------- */
function search(npc, w) {
  npc.crouch = 0;
  const memory = npc.lastSeen;
  if (!memory || w.now - memory.t > MEMORY) { npc.cover = null; setState(npc, 'guard', w); return; }
  if (npc.morale < npc.traits.moraleFloor + 0.12) { setState(npc, 'retreat', w, 8000); return; }
  if (stepToward(npc, memory, SPEED.alert * 0.9, w)) {
    npc.moving = 0;
    faceToward(npc, npc.x + Math.cos(w.now / 600), npc.z + Math.sin(w.now / 600), w.dt);
    if (w.now > npc.stateUntil) setState(npc, 'guard', w);
  }
}

/* ---- 후퇴: 다른 방으로 물러나 다시 자리를 잡는다 ------------------------- */
function retreat(npc, w) {
  npc.crouch = 0;
  if (!npc.retreatTo || w.now > npc.stateUntil) {
    npc.retreatTo = w.fallbackPoint(npc);
    npc.stateUntil = w.now + 9000;
  }
  if (!npc.retreatTo) { setState(npc, 'guard', w); return; }
  if (stepToward(npc, npc.retreatTo, SPEED.sprint, w)) {
    npc.post = { x: npc.retreatTo.x, z: npc.retreatTo.z, yaw: npc.yaw };
    npc.room = zoneAt(npc.x, npc.z);
    npc.retreatTo = null;
    setState(npc, 'guard', w);
  }
}

/* ========================================================================== *
 *  민간인
 * ========================================================================== */
export function updateCivilian(npc, w) {
  if (!npc.alive) { npc.moving = 0; return; }
  if (npc.secured) { npc.moving = 0; npc.crouch = 1; npc.hands = 1; return; }
  npc.panic = Math.max(0, npc.panic - w.dt * 0.06);

  const heard = npc.lastHeard;
  if (heard && w.now - heard.t < 1500 && heard.level > HEAR_FLOOR) {
    npc.panic = Math.min(1, npc.panic + heard.level * 0.75);
    if (heard.type === 'shot' || heard.type === 'frag') npc.panic = Math.min(1, npc.panic + 0.35);
  }

  // 명령을 들었으면 따른다. 공황 상태면 잘 듣지 않는다.
  if (npc.commandedAt && w.now - npc.commandedAt < 2200 && npc.state !== 'comply') {
    if (w.random() > npc.panic * 0.6) {
      setState(npc, 'comply', w);
      npc.commandedAt = 0;
    } else {
      npc.commandedAt = 0;
      npc.panic = Math.min(1, npc.panic + 0.15);
    }
  }

  switch (npc.state) {
    case 'comply':
      npc.moving = 0; npc.crouch = 1; npc.hands = 1;
      if (w.nearestPlayer(npc)) faceToward(npc, w.nearestPlayer(npc).x, w.nearestPlayer(npc).z, w.dt);
      return;
    case 'hide':
      npc.hands = 0;
      if (!npc.hideSpot) npc.hideSpot = w.hideSpot(npc);
      if (npc.hideSpot && dist2(npc, npc.hideSpot) > 0.6) { stepToward(npc, npc.hideSpot, SPEED.alert, w); return; }
      npc.moving = 0; npc.crouch = 1;
      if (npc.panic < 0.25) setState(npc, 'calm', w);
      return;
    case 'flee': {
      npc.hands = 0; npc.crouch = 0;
      if (!npc.fleeTo) npc.fleeTo = w.hideSpot(npc);
      if (npc.fleeTo && stepToward(npc, npc.fleeTo, SPEED.sprint, w)) { npc.fleeTo = null; setState(npc, 'hide', w); }
      if (npc.panic < 0.4) setState(npc, 'hide', w);
      return;
    }
    default: {
      npc.hands = 0; npc.crouch = 0;
      if (npc.panic > 0.55) { npc.hideSpot = null; setState(npc, 'flee', w); return; }
      if (npc.panic > 0.25) { npc.hideSpot = null; setState(npc, 'hide', w); return; }
      if (dist2(npc, npc.home) > 1.2) { stepToward(npc, npc.home, SPEED.walk * 0.8, w); return; }
      npc.moving = 0;
      if (w.now > npc.stateUntil) {
        npc.stateUntil = w.now + 3000 + w.random() * 5000;
        npc.yaw += (w.random() - 0.5) * 2.2;
      }
      return;
    }
  }
}

/* ========================================================================== *
 *  배치 계획
 * ========================================================================== */
/**
 * 방마다 적이 있을 수도, 없을 수도 있게 배치한다.
 * "빈 방"이 실제로 존재해야 문을 열 때의 긴장이 생긴다.
 */
export function planOccupancy(posts, count, random = Math.random) {
  const byRoom = new Map();
  for (const post of posts) {
    if (!byRoom.has(post.room)) byRoom.set(post.room, []);
    byRoom.get(post.room).push(post);
  }
  const rooms = [...byRoom.keys()].sort(() => random() - 0.5);
  const chosen = [];
  // 1) 바깥 경비를 먼저 한두 명 세운다 (플레이어가 밖에서 시작하므로).
  const outdoor = ['COURTYARD', 'WEST YARD', 'EAST YARD', 'GARDEN'];
  const outdoorPosts = posts.filter((p) => outdoor.includes(p.room));
  const guards = Math.min(outdoorPosts.length, Math.max(1, Math.round(count * 0.3)));
  const shuffledOutdoor = [...outdoorPosts].sort(() => random() - 0.5);
  for (let i = 0; i < guards; i++) chosen.push(shuffledOutdoor[i]);

  // 2) 남은 인원을 실내 방에 나눠 넣는다. 한 방에 최대 2명.
  const indoorRooms = rooms.filter((r) => !outdoor.includes(r));
  let room = 0;
  while (chosen.length < count && indoorRooms.length) {
    const name = indoorRooms[room % indoorRooms.length];
    const free = byRoom.get(name).filter((p) => !chosen.includes(p));
    if (free.length && random() < 0.82) chosen.push(free[Math.floor(random() * free.length)]);
    room++;
    if (room > indoorRooms.length * 3) break;
  }
  const personalities = Object.keys(PERSONALITIES).filter((p) => p !== 'leader');
  return chosen.map((post, i) => ({
    post,
    personality: post.room === 'COURTYARD' && i === 0
      ? 'defensive'
      : personalities[Math.floor(random() * personalities.length)],
  }));
}
