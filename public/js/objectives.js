/* =============================================================================
 *  objectives.js  -  단계 목표 판정 (순수 함수, 서버/테스트 공용)
 *
 *  "이 목표가 끝났는가" 를 서버 틱 안에 묻어 두면 단계 전환을 확인할 방법이
 *  실제 판을 끝까지 돌리는 것밖에 없다. 방 상태만 받아 판정하는 순수 함수로
 *  빼 두면, 서버는 그대로 쓰고 테스트는 원하는 상황을 직접 만들어 볼 수 있다.
 *
 *  room 은 다음만 있으면 된다.
 *    suspects, civilians, npcs, sites, evidence,
 *    flags, stats, standingPlayers, phase, objectiveDone
 * ========================================================================== */

import { EXTRACTION, AREAS, zoneAt } from './map-data.js';
import { OBJECTIVES, PHASES, objectiveLabel, phaseText } from './mission-story.js';

const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/* ========================================================================== *
 *  사람을 세는 목표가 판을 멎게 하지 않도록
 *
 *  방이 열여덟 칸인 사옥에서 실제로 일어난 일이다. 마지막 한 명이 어느 방으로
 *  옮겨 갔는지 알 방법이 없어서, 나머지를 다 끝내 놓고도 4단계에서 22분을 다
 *  썼다. 증거 하나도 마찬가지였다.
 *
 *  두 가지를 같이 넣는다.
 *    1) 몇 명이 어느 구역에 남았는지 목표 줄에 적는다. 남은 수가 적을 때만
 *       적는다 - 처음부터 전원의 방을 알려 주면 수색이라는 게 없어진다.
 *    2) 그래도 못 찾으면 STALL_MS 뒤에 "산개" 로 보고 다음 단계로 넘긴다.
 *       남은 인원이 사라지지는 않는다. 철수하는 길에 마주치면 여전히 쏜다.
 *
 *  시한은 "지금 단계를 붙잡고 있는 목표" 에만 적용한다. 아직 오지 않은 단계의
 *  목표까지 시간으로 끝난 것으로 쳐 주면 점수(missedObjectives)가 거짓이 된다.
 * ========================================================================== */
export const STALL_MS = 100000;
/** 남은 인원이 이 수 이하로 줄면 어느 구역에 있는지 적어 준다. */
export const REVEAL_AT = 3;

const stalling = (room, id) => Number.isFinite(room.phaseEnteredAt)
  && !!PHASES[room.phase]?.require.includes(id)
  && Date.now() - room.phaseEnteredAt > STALL_MS;

/* 구역 이름 -> 사람이 읽는 이름 ('LIBRARY' -> '서재').
 *
 * 맵마다 구역이 다르므로 표를 모듈 최상위에서 한 번 만들어 두면 안 된다 -
 * 저택에서 만든 표를 사무실에서 쓰면 방 이름이 전부 영문 원문으로 나온다.
 * 배열 자체를 열쇠로 캐시하므로 맵을 오가도 다시 만들지 않는다. */
const zoneLabelCache = new WeakMap();
function zoneLabel(name) {
  if (!name) return '위치 확인 필요';
  let table = zoneLabelCache.get(AREAS);
  if (!table) {
    table = new Map(AREAS.map((a) => [a.name, a.label]));
    zoneLabelCache.set(AREAS, table);
  }
  return table.get(name) || name;
}
/**
 * "거래 장부 · 서재" 처럼 무엇이 어디에 남았는지 한 줄로.
 * 화면의 목표 패널은 좁다. 두 곳까지만 적고 나머지는 개수로 줄인다.
 */
const WHERE_SHOWN = 2;
function whereLeft(list) {
  const named = list
    .map((e) => [e.label, e.room ? zoneLabel(e.room) : null].filter(Boolean).join(' · '))
    .filter(Boolean);
  if (named.length <= WHERE_SHOWN) return named.join(' / ');
  return `${named.slice(0, WHERE_SHOWN).join(' / ')} 외 ${named.length - WHERE_SHOWN}곳`;
}

/**
 * 아직 남은 사람들이 어느 구역에 있는가. 같은 구역은 한 번만 적는다.
 *
 * 자리에 적힌 방(npc.room)이 아니라 지금 서 있는 좌표로 묻는다 - 순찰로 방을
 * 옮겨 다니므로, 배치 때의 방을 적으면 이미 떠난 방으로 보내게 된다.
 */
function wherePeople(list) {
  const zones = [...new Set(list.map((n) => zoneLabel(zoneAt(n.x, n.z) || n.room)))];
  if (zones.length <= WHERE_SHOWN) return zones.join(' / ');
  return `${zones.slice(0, WHERE_SHOWN).join(' / ')} 외 ${zones.length - WHERE_SHOWN}곳`;
}

/** 더 이상 위협이 아닌 상태: 쓰러졌거나, 체포됐거나, 손을 들었다. */
export const neutralised = (s) => !s.alive || s.arrested || s.state === 'surrender';

/**
 * 사람을 세는 목표 한 줄. 남은 수가 적으면 어디에 있는지까지 적는다.
 *
 * @param handled   무엇을 "처리됨" 으로 볼 것인가 (용의자는 무력화, 민간인은 확보)
 * @param countable 셀 대상이 아예 없을 때도 끝난 것으로 볼 것인가
 */
function peopleState(room, id, list, handled = neutralised, countable = true) {
  const left = list.filter((n) => !handled(n));
  const stalled = countable && left.length > 0 && stalling(room, id);
  return {
    done: countable && (left.length === 0 || stalled),
    have: list.length - left.length,
    need: list.length,
    stalled,
    detail: left.length && left.length <= REVEAL_AT ? `남은 ${left.length}명 · ${wherePeople(left)}` : '',
  };
}

export function objectiveState(room, id) {
  const suspects = room.suspects;
  switch (id) {
    case 'perimeter':
      return peopleState(room, id, suspects.filter((s) => s.origin === 'outdoor'));
    case 'breach':
      return { done: room.flags.breached, have: room.flags.breached ? 1 : 0, need: 1 };
    case 'civilians': {
      // 구석에 숨어 버린 직원 한 명 때문에 2단계가 멎는 것도 같은 고장이다.
      const list = room.civilians.filter((c) => !c.hostage);
      return peopleState(room, id, list, (c) => c.secured || !c.alive, list.length > 0);
    }
    case 'devices': {
      const left = room.sites.filter((s) => !s.defused);
      const done = room.sites.length - left.length;
      return {
        done: left.length === 0, have: done, need: room.sites.length,
        detail: whereLeft(left),
      };
    }
    case 'hvt': {
      const hvt = room.npcs.find((n) => n.kind === 'hvt');
      const done = !hvt || neutralised(hvt);
      return { done, have: done ? 1 : 0, need: 1 };
    }
    case 'hostage': {
      const hostage = room.npcs.find((n) => n.id === 'hostage');
      const done = !!hostage && hostage.alive;
      return { done, have: done ? 1 : 0, need: 1, failed: !!hostage && !hostage.alive };
    }
    case 'suspects':
      return peopleState(room, id, suspects.filter((s) => !s.reinforcement));
    case 'extract': {
      const standing = room.standingPlayers;
      const inZone = standing.filter((p) => dist2D(p, EXTRACTION) <= EXTRACTION.radius);
      const done = standing.length > 0 && inZone.length === standing.length;
      return { done, have: inZone.length, need: Math.max(1, standing.length) };
    }
    case 'evidence': {
      const left = room.evidence.filter((e) => !e.taken);
      const taken = room.evidence.length - left.length;
      // 어느 방에 무엇이 남았는지 적어 준다. "증거 회수" 라고만 쓰여 있으면
      // 저택 전체를 다시 돌아야 한다.
      return {
        done: left.length === 0, have: taken, need: room.evidence.length,
        detail: whereLeft(left),
      };
    }
    case 'generator':
      return { done: !!room.generatorStarted, have: room.generatorStarted ? 1 : 0, need: 1, detail: '북동쪽 작업실 · 가까이서 E / 사용 길게 누르기' };
    case 'quiet':
      return { done: room.stats.civiliansLost === 0 && !room.stats.hostageLost, have: 0, need: 0 };
    case 'arrests':
      return { done: room.stats.suspectsArrested >= room.stats.suspectsNeutralised, have: room.stats.suspectsArrested, need: 0 };
    default:
      return { done: false, have: 0, need: 1 };
  }
}

export function objectiveReport(room) {
  const phase = phaseText(PHASES[room.phase]);
  return {
    phase: room.phase,
    id: phase.id,
    name: phase.name,
    title: phase.title,
    hint: phase.hint,
    list: [...phase.show, ...(room.powerCutDone ? ['generator'] : [])].map((id) => {
      const state = objectiveState(room, id);
      const done = state.done || room.objectiveDone.has(id);
      return {
        id, label: objectiveLabel(id), kind: OBJECTIVES[id]?.kind || 'primary',
        done, have: state.have, need: state.need, failed: !!state.failed,
        detail: done ? '' : (state.detail || ''),
      };
    }),
  };
}

/** 지금 단계의 필수 목표가 전부 끝났는가. 끝난 목표는 되돌아가지 않는다. */
export function phaseComplete(room) {
  const phase = PHASES[room.phase];
  const states = phase.require.map((id) => ({ id, ...objectiveState(room, id) }));
  for (const s of states) if (s.done) room.objectiveDone.add(s.id);
  return states.every((s) => s.done || room.objectiveDone.has(s.id));
}

/** 남은 단계에서 끝내지 못한 필수 목표 수 + 회수하지 못한 증거 수. */
export function missedObjectives(room) {
  let missed = 0;
  for (let i = room.phase; i < PHASES.length; i++) {
    for (const id of PHASES[i].require) {
      if (!room.objectiveDone.has(id) && !objectiveState(room, id).done) missed++;
    }
  }
  return missed + room.evidence.filter((e) => !e.taken).length;
}

