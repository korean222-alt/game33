/* =============================================================================
 *  server/events.js  -  맵이 스스로 내는 소리
 *
 *  저택은 조용하다. 사람이 내는 소리 말고는 아무 소리도 안 난다. 사옥은 그렇지
 *  않다 - 서버실 팬이 계속 돌고, 예약 인쇄가 밤에도 돌아가고, 아무도 안 탄
 *  승강기가 층을 오간다. 그 소리들이 NPC 의 귀에 똑같이 들어가면서 두 가지가
 *  생긴다.
 *
 *    1) 발소리를 숨길 틈. 복사기가 도는 동안 그 방 앞을 지나갈 수 있다.
 *    2) 거짓 신호. 승강기 소리에 경비가 코어로 올라가면 복도가 빈다.
 *
 *  그리고 화재경보기. 당기면 그 자리에서 8초간 큰 소리가 계속 나서 들리는
 *  범위의 경비를 그쪽으로 끌어당긴다. 공짜는 아니다 - 당기는 동안 바로 옆에
 *  있는 자에게는 그냥 들킨다.
 *
 *  경보기에는 스프링클러가 물려 있다. 2.5초 뒤 그 방화구역의 헤드가 터져
 *  18초간 물이 돈다. 물이 도는 구역에서는 서로 잘 안 보이고(밝기 계산이
 *  내려간다) 거기서 난 소리도 잘 안 들린다. 적에게도 똑같이 적용되므로
 *  무적 시간이 아니라 거리를 좁히는 도구다.
 *
 *  맵에 AMBIENT_NOISE / ALARMS 가 없으면 이 파일의 함수들은 전부 즉시 돌아온다.
 *  저택은 예전과 정확히 똑같이 조용하다.
 * ========================================================================== */
import { deliverNoise } from '../public/js/suspect-ai.js';
import { now } from './util.js';

/** 경보기를 당기는 데 걸리는 시간(초). 문을 여는 것보다 조금 빠르다. */
export const ALARM_SECONDS = 1.2;
/** 한 번 당기면 이만큼 운다. */
export const ALARM_RING_MS = 8000;
/** 우는 동안 소리를 내는 간격. */
const ALARM_PULSE_MS = 650;
/** 경보음의 세기. 총성(1.0)보다는 작고 고함(0.55)보다는 크다. */
const ALARM_LEVEL = 0.72;
/**
 * 사람이 낸 소리를 기계 소리가 덮지 않는 시간.
 *
 *  suspect-ai 의 deliverNoise 는 1.2초가 지나면 더 약한 소리로도 기억을
 *  덮어쓴다. 그대로 두면 발소리를 듣고 돌아서던 경비가 복사기 한 번에
 *  잊어버린다 - 기계 소리가 공짜 은신이 되어서는 안 된다.
 */
const HUMAN_MEMORY_MS = 6000;

/** 경보기를 당기고 물이 나오기까지. */
export const SPRINKLER_DELAY_MS = 2500;
/** 한 번 터지면 이만큼 돈다. */
export const SPRINKLER_MS = 18000;
/** 물속에서의 밝기 배율. 시야 판정(visibilityFactor)이 이만큼 내려간다. */
export const WET_BRIGHTNESS = 0.42;
/** 물속에서 난 소리가 NPC 에게 닿는 배율. */
export const WET_NOISE = 0.5;

/** 이 맵에 사건이 있는가. */
const sourcesOf = (room) => room.map.AMBIENT_NOISE || [];
const alarmsOf = (room) => room.map.ALARMS || [];
const sprinklersOf = (room) => room.map.SPRINKLERS || [];

/** 방이 새 임무를 시작할 때 사건 상태를 비운다. */
export function resetEvents(room) {
  room.ambientAt = new Map();     // 소음원 id -> 다음에 울릴 시각
  room.alarmUntil = new Map();    // 경보기 id -> 그칠 시각
  room.alarmPulseAt = new Map();  // 경보기 id -> 다음 펄스 시각
  room.sprinklerAt = new Map();   // 구역 id -> 물이 나올 시각
  room.sprinklerUntil = new Map();// 구역 id -> 멎을 시각
}

/** (x,z) 에 지금 물이 쏟아지고 있는가. */
export function wetAt(room, x, z) {
  if (!room.sprinklerUntil?.size) return false;
  const t = now();
  for (const zone of sprinklersOf(room)) {
    if ((room.sprinklerUntil.get(zone.id) || 0) <= t) continue;
    const a = zone.area;
    if (Math.abs(x - a.x) <= a.w / 2 && Math.abs(z - a.z) <= a.d / 2) return true;
  }
  return false;
}

/** 기계 소리를 NPC 에게 전달한다. 사람이 낸 최근 소리는 건드리지 않는다. */
function emitMachineNoise(room, x, z, level, type, t) {
  const event = { x, z, level, type, by: null, t };
  const colliders = room.doors.colliders();
  for (const npc of room.npcs) {
    if (!npc.alive) continue;
    const heard = npc.lastHeard;
    if (heard && heard.by && t - heard.t < HUMAN_MEMORY_MS) continue;
    deliverNoise(npc, event, colliders);
  }
  return event;
}

/**
 * 주기적 소음원을 한 틱 굴린다.
 *
 *  첫 호출에서는 전부 한 박자 뒤로 미뤄 둔다. 안 그러면 경기 시작 0초에
 *  다섯 개가 동시에 울려서, 그게 곧 "작전 시작" 신호가 되어 버린다.
 */
export function updateAmbient(room, io) {
  const sources = sourcesOf(room);
  if (!sources.length) return;
  const t = now();
  for (const src of sources) {
    let at = room.ambientAt.get(src.id);
    if (at === undefined) {
      room.ambientAt.set(src.id, t + src.everyMs * (0.3 + Math.random() * 0.7));
      continue;
    }
    if (t < at) continue;
    room.ambientAt.set(src.id, t + src.everyMs + (Math.random() - 0.5) * 2 * (src.jitterMs || 0));
    emitMachineNoise(room, src.x, src.z, src.level, src.type, t);
    // 화면과 소리는 들릴 만한 것만 보낸다. 공조기 웅웅거림까지 매번 쏘면
    // 대역폭만 먹고 아무도 눈치 못 챈다.
    if (src.level >= 0.25) {
      io.to(room.code).emit('mapSound', {
        type: src.type, x: +src.x.toFixed(2), z: +src.z.toFixed(2),
        level: src.level, label: src.label,
      });
    }
  }
}

/** 화재경보기를 당겼다. */
export function pullAlarm(room, alarmId, byId, io) {
  const alarm = alarmsOf(room).find((a) => a.id === alarmId);
  if (!alarm) return false;
  const t = now();
  if ((room.alarmUntil.get(alarmId) || 0) > t) return false;
  room.alarmUntil.set(alarmId, t + ALARM_RING_MS);
  room.alarmPulseAt.set(alarmId, t);
  // 같은 손잡이에 스프링클러가 물려 있다. 이미 돌고 있으면 다시 예약하지 않는다.
  const zone = sprinklersOf(room).find((s) => s.id === alarm.zone);
  if (zone && (room.sprinklerUntil.get(zone.id) || 0) <= t && !room.sprinklerAt.has(zone.id)) {
    room.sprinklerAt.set(zone.id, t + SPRINKLER_DELAY_MS);
  }
  io.to(room.code).emit('alarmStarted', {
    id: alarm.id, x: alarm.x, z: alarm.z, label: alarm.label,
    seconds: ALARM_RING_MS / 1000, by: byId,
  });
  io.to(room.code).emit('radio', {
    text: zone
      ? `무전: ${alarm.label} 작동. 잠시 뒤 ${zone.label} 스프링클러가 돈다.`
      : `무전: ${alarm.label} 작동. 소리 나는 쪽으로 사람이 몰린다.`,
  });
  return true;
}

/**
 * 그 자리를 덮는 방화구역을 스스로 돌린다.
 *
 *  경보기 손잡이를 당겨야만 물이 나오게 해 두었더니, 벽에 붙은 작은 손잡이를
 *  아무도 못 찾아서 사옥의 절반짜리 장치가 한 판도 안 쓰였다. "어떻게 쓰는지
 *  모르겠다" 는 말이 그 증상이다.
 *
 *  그래서 회수와 해체에도 물렸다. 증거를 뽑거나 소각 장치를 끄면 그 구역이
 *  젖는다 - 한 판에 최소 몇 번은 물이 도는 것을 보게 되고, 그러고 나면
 *  경보기 손잡이가 무엇인지도 알게 된다.
 *
 *  공짜는 아니다. 물이 도는 동안은 내 눈도 나빠지고, 직원들은 흩어진다.
 *  이미 돌고 있거나 예약된 구역은 다시 켜지 않는다.
 *
 *  @returns 실제로 예약했으면 구역, 아니면 null
 */
export function tripSprinklerAt(room, x, z, io, reason = '') {
  const t = now();
  const zone = sprinklersOf(room).find((s) => {
    const a = s.area;
    return Math.abs(x - a.x) <= a.w / 2 && Math.abs(z - a.z) <= a.d / 2;
  });
  if (!zone) return null;
  if ((room.sprinklerUntil.get(zone.id) || 0) > t || room.sprinklerAt.has(zone.id)) return null;
  room.sprinklerAt.set(zone.id, t + SPRINKLER_DELAY_MS);
  io.to(room.code).emit('radio', {
    text: `무전: ${reason ? `${reason} — ` : ''}${zone.label} 소화 설비가 작동했다. 잠시 뒤 시야가 나빠진다.`,
  });
  return zone;
}

/**
 * 스프링클러를 한 틱 굴린다.
 *
 *  물이 도는 동안 NPC 쪽에서 달라지는 것은 두 가지뿐이고(밝기·소리), 둘 다
 *  다른 파일이 wetAt 으로 물어본다. 여기서 하는 일은 켜고 끄고 알리는 것이다.
 */
export function updateSprinklers(room, io) {
  if (!room.sprinklerAt?.size && !room.sprinklerUntil?.size) return;
  const t = now();
  for (const zone of sprinklersOf(room)) {
    const due = room.sprinklerAt.get(zone.id);
    if (due !== undefined && t >= due) {
      room.sprinklerAt.delete(zone.id);
      room.sprinklerUntil.set(zone.id, t + SPRINKLER_MS);
      io.to(room.code).emit('sprinklerStarted', {
        id: zone.id, label: zone.label, area: zone.area,
        heads: zone.heads || [], seconds: SPRINKLER_MS / 1000,
      });
      /* 물벼락. 직원들은 놀라서 흩어지고, 무장 인원도 조금 흔들린다 -
       * 시야가 나빠진다는 것을 저쪽도 안다. */
      for (const npc of room.npcs) {
        if (!npc.alive) continue;
        const a = zone.area;
        if (Math.abs(npc.x - a.x) > a.w / 2 || Math.abs(npc.z - a.z) > a.d / 2) continue;
        if (npc.kind === 'civilian') npc.panic = Math.min(1, (npc.panic || 0) + 0.5);
        else npc.morale = Math.max(0, npc.morale - 0.08);
      }
      continue;
    }
    const until = room.sprinklerUntil.get(zone.id);
    if (until !== undefined && t >= until) {
      room.sprinklerUntil.delete(zone.id);
      io.to(room.code).emit('sprinklerStopped', { id: zone.id });
    }
  }
}

/** 울고 있는 경보기를 한 틱 굴린다. */
export function updateAlarms(room, io) {
  if (!room.alarmUntil.size) return;
  const t = now();
  for (const alarm of alarmsOf(room)) {
    const until = room.alarmUntil.get(alarm.id) || 0;
    if (!until) continue;
    if (t >= until) {
      room.alarmUntil.delete(alarm.id);
      room.alarmPulseAt.delete(alarm.id);
      io.to(room.code).emit('alarmStopped', { id: alarm.id });
      continue;
    }
    if (t < (room.alarmPulseAt.get(alarm.id) || 0)) continue;
    room.alarmPulseAt.set(alarm.id, t + ALARM_PULSE_MS);
    /* 경보음은 사람이 낸 소리를 덮어써도 된다 - 그게 이 도구의 쓸모다.
     * 그래서 emitMachineNoise 가 아니라 직접 전달한다. */
    const event = { x: alarm.x, z: alarm.z, level: ALARM_LEVEL, type: 'alarm', by: null, t };
    const colliders = room.doors.colliders();
    for (const npc of room.npcs) {
      if (npc.alive) deliverNoise(npc, event, colliders);
    }
  }
}
