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

import { EXTRACTION, AREAS } from './map-data.js';
import { OBJECTIVES, PHASES } from './mission-story.js';

const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** 구역 이름 -> 사람이 읽는 이름 ('LIBRARY' -> '서재'). */
const ZONE_LABEL = new Map(AREAS.map((a) => [a.name, a.label]));
const zoneLabel = (name) => (name ? ZONE_LABEL.get(name) || name : '위치 확인 필요');
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

/** 더 이상 위협이 아닌 상태: 쓰러졌거나, 체포됐거나, 손을 들었다. */
export const neutralised = (s) => !s.alive || s.arrested || s.state === 'surrender';

export function objectiveState(room, id) {
  const suspects = room.suspects;
  switch (id) {
    case 'perimeter': {
      const outdoor = suspects.filter((s) => s.origin === 'outdoor');
      return { done: outdoor.every(neutralised), have: outdoor.filter(neutralised).length, need: outdoor.length };
    }
    case 'breach':
      return { done: room.flags.breached, have: room.flags.breached ? 1 : 0, need: 1 };
    case 'civilians': {
      const list = room.civilians.filter((c) => !c.hostage);
      const handled = list.filter((c) => c.secured || !c.alive);
      return { done: list.length > 0 && handled.length === list.length, have: handled.length, need: list.length };
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
    case 'suspects': {
      const list = suspects.filter((s) => !s.reinforcement);
      const handled = list.filter(neutralised);
      return { done: handled.length === list.length, have: handled.length, need: list.length };
    }
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
  const phase = PHASES[room.phase];
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
        id, label: OBJECTIVES[id]?.label || id, kind: OBJECTIVES[id]?.kind || 'primary',
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

