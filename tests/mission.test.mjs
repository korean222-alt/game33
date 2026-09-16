/* =============================================================================
 *  mission.test.mjs  -  단계 전환과 채점
 *
 *  여기까지는 "판을 끝까지 돌려 보는" 서버 통합 테스트로만 확인하고 있었다.
 *  그러면 단계가 안 넘어가는 버그가 나왔을 때 어느 목표가 막힌 건지 알 수 없다.
 *  목표 하나하나의 판정, 단계 전환 규칙, 등급 계산을 따로 확인한다.
 * ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, OBJECTIVES, MISSION, phaseIndex, phaseOf } from '../public/js/mission-story.js';
import {
  objectiveState, objectiveReport, phaseComplete, missedObjectives, neutralised, STALL_MS,
} from '../public/js/objectives.js';
import { scoreMission, gradeAdvice, SCORE } from '../public/js/scoring.js';
import { EXTRACTION } from '../public/js/map-data.js';

/** 서버의 Room 이 목표 판정에 쓰는 만큼만 흉내 낸 방. */
function room(overrides = {}) {
  const base = {
    phase: 0,
    objectiveDone: new Set(),
    npcs: [],
    sites: [{ id: 'A', defused: false }, { id: 'B', defused: false }],
    evidence: [{ id: 'e1', taken: false }, { id: 'e2', taken: false }, { id: 'e3', taken: false }],
    flags: { breached: false },
    stats: { civiliansLost: 0, hostageLost: false, suspectsArrested: 0, suspectsNeutralised: 0 },
    players: [],
    ...overrides,
  };
  return {
    ...base,
    get suspects() { return base.npcs.filter((n) => n.kind !== 'civilian'); },
    get civilians() { return base.npcs.filter((n) => n.kind === 'civilian'); },
    get standingPlayers() { return base.players.filter((p) => p.alive && !p.downed); },
  };
}

const suspect = (extra = {}) => ({ id: 's', kind: 'suspect', alive: true, state: 'guard', ...extra });
const civilian = (extra = {}) => ({ id: 'c', kind: 'civilian', alive: true, secured: false, ...extra });
const standing = (extra = {}) => ({ id: 'p', alive: true, downed: false, x: 0, z: 0, ...extra });

/* ========================================================================== *
 *  1. 단계 데이터 자체가 성립하는가
 * ========================================================================== */
test('모든 단계의 목표 id 는 실제로 정의돼 있고, 필수 목표는 화면에도 뜬다', () => {
  const ids = new Set();
  for (const phase of PHASES) {
    assert.ok(!ids.has(phase.id), `단계 id 가 겹친다: ${phase.id}`);
    ids.add(phase.id);
    assert.ok(phase.require.length > 0, `${phase.id}: 필수 목표가 없으면 영원히 안 넘어간다`);
    for (const id of [...phase.require, ...phase.show]) {
      assert.ok(OBJECTIVES[id], `${phase.id}: 정의되지 않은 목표 ${id}`);
    }
    for (const id of phase.require) {
      assert.ok(phase.show.includes(id),
        `${phase.id}: 필수 목표 ${id} 가 화면에 뜨지 않으면 무엇을 해야 할지 알 수 없다`);
    }
    assert.ok(phase.radio && phase.hint, `${phase.id}: 무전과 안내가 있어야 한다`);
  }
  assert.equal(PHASES[PHASES.length - 1].id, 'extract', '마지막 단계는 철수다');
});

test('phaseIndex 는 모르는 이름을 첫 단계로 되돌린다', () => {
  assert.equal(phaseIndex('approach'), 0);
  assert.equal(phaseIndex('extract'), PHASES.length - 1);
  assert.equal(phaseIndex('없는단계'), 0);
  assert.equal(phaseOf('hvt').id, 'hvt');
  assert.ok(MISSION.pages.length >= 5, '브리핑이 최소 다섯 장이어야 한다');
});

/* ========================================================================== *
 *  2. 목표 하나하나의 판정
 * ========================================================================== */
test('외곽 목표는 야외 인원이 전부 정리돼야 끝난다', () => {
  const r = room({
    npcs: [
      suspect({ id: 'o1', origin: 'outdoor' }),
      suspect({ id: 'o2', origin: 'outdoor' }),
      suspect({ id: 'i1', origin: 'indoor' }),
    ],
  });
  let state = objectiveState(r, 'perimeter');
  assert.equal(state.done, false);
  assert.deepEqual([state.have, state.need], [0, 2]);

  r.npcs[0].alive = false;                  // 사살
  assert.equal(objectiveState(r, 'perimeter').have, 1);
  r.npcs[1].state = 'surrender';            // 항복도 정리로 친다
  assert.equal(objectiveState(r, 'perimeter').done, true);
  // 실내 인원이 남아 있어도 외곽 목표에는 영향이 없다.
  assert.equal(r.npcs[2].alive, true);
});

test('체포와 항복과 사살은 모두 "정리"로 센다', () => {
  assert.equal(neutralised(suspect({ alive: false })), true);
  assert.equal(neutralised(suspect({ arrested: true })), true);
  assert.equal(neutralised(suspect({ state: 'surrender' })), true);
  assert.equal(neutralised(suspect()), false);
});

test('민간인 목표는 인질을 빼고 세고, 한 명도 없으면 끝나지 않는다', () => {
  const empty = room({ npcs: [civilian({ id: 'h', hostage: true })] });
  assert.equal(objectiveState(empty, 'civilians').done, false, '인질만 있으면 셀 대상이 없다');

  const r = room({
    npcs: [civilian({ id: 'c1' }), civilian({ id: 'c2' }), civilian({ id: 'h', hostage: true })],
  });
  assert.equal(objectiveState(r, 'civilians').need, 2);
  r.npcs[0].secured = true;
  assert.equal(objectiveState(r, 'civilians').done, false);
  r.npcs[1].secured = true;
  assert.equal(objectiveState(r, 'civilians').done, true);
});

test('인질 목표는 살아 있으면 달성, 죽으면 실패로 표시된다', () => {
  const alive = room({ npcs: [civilian({ id: 'hostage', hostage: true })] });
  assert.deepEqual(
    { done: objectiveState(alive, 'hostage').done, failed: !!objectiveState(alive, 'hostage').failed },
    { done: true, failed: false },
  );
  const dead = room({ npcs: [civilian({ id: 'hostage', hostage: true, alive: false })] });
  assert.equal(objectiveState(dead, 'hostage').done, false);
  assert.equal(objectiveState(dead, 'hostage').failed, true);
});

test('잔여 인원 목표에서 증원 병력은 제외된다', () => {
  const r = room({
    npcs: [suspect({ id: 's1', alive: false }), suspect({ id: 'rf_0', reinforcement: true })],
  });
  // 증원은 철수 단계에서 새로 들어온다. 이들 때문에 목표가 되돌아가면 안 된다.
  assert.equal(objectiveState(r, 'suspects').done, true);
  assert.equal(objectiveState(r, 'suspects').need, 1);
});

test('철수 목표는 서 있는 대원 전원이 철수 지점 안에 있어야 끝난다', () => {
  const inside = { x: EXTRACTION.x, z: EXTRACTION.z };
  const outside = { x: EXTRACTION.x, z: EXTRACTION.z + EXTRACTION.radius + 4 };
  const r = room({ players: [standing({ id: 'a', ...inside }), standing({ id: 'b', ...outside })] });
  assert.equal(objectiveState(r, 'extract').done, false);
  assert.deepEqual([objectiveState(r, 'extract').have, objectiveState(r, 'extract').need], [1, 2]);

  // 쓰러진 대원은 "서 있는 대원" 이 아니다. 남은 한 명이 들어오면 끝난다.
  r.players[1].downed = true;
  assert.equal(objectiveState(r, 'extract').done, true);

  // 아무도 서 있지 않으면 철수가 끝난 것이 아니다.
  r.players[0].downed = true;
  assert.equal(objectiveState(r, 'extract').done, false);
});

test('해체 · 증거 · 무피해 · 체포 우선 목표', () => {
  const r = room();
  assert.equal(objectiveState(r, 'devices').done, false);
  r.sites.forEach((s) => { s.defused = true; });
  assert.equal(objectiveState(r, 'devices').done, true);

  assert.equal(objectiveState(r, 'evidence').done, false);
  r.evidence.forEach((e) => { e.taken = true; });
  assert.equal(objectiveState(r, 'evidence').done, true);

  assert.equal(objectiveState(r, 'quiet').done, true);
  r.stats.civiliansLost = 1;
  assert.equal(objectiveState(r, 'quiet').done, false);

  r.stats.suspectsNeutralised = 3;
  assert.equal(objectiveState(r, 'arrests').done, false);
  r.stats.suspectsArrested = 3;
  assert.equal(objectiveState(r, 'arrests').done, true);
});

test('모르는 목표 id 는 끝난 것으로 처리되지 않는다', () => {
  assert.equal(objectiveState(room(), '없는목표').done, false);
});

/* ---- 마지막 한둘을 못 찾아 판이 멎는 일 ---------------------------------- */
test('남은 인원이 셋 이하로 줄면 어느 구역에 있는지 목표에 적힌다', () => {
  const many = room({
    npcs: [1, 2, 3, 4].map((i) => suspect({ id: `s${i}`, x: 0, z: 0 })),
  });
  assert.equal(objectiveState(many, 'suspects').detail, '',
    '수색할 게 많이 남은 동안에는 위치를 알려 주지 않는다');

  const few = room({ npcs: [suspect({ id: 's1', x: 0, z: 0 })] });
  const detail = objectiveState(few, 'suspects').detail;
  assert.match(detail, /남은 1명/, `위치가 안 적혔다: ${detail}`);
});

test('사람을 세는 목표는 시한이 지나면 "산개" 로 보고 넘어간다', () => {
  const stuck = () => room({
    phase: phaseIndex('clear'),
    phaseEnteredAt: Date.now() - STALL_MS - 1000,
    npcs: [suspect({ id: 's1', x: 0, z: 0 })],
  });

  const r = stuck();
  assert.equal(objectiveState(r, 'suspects').stalled, true);
  assert.equal(objectiveState(r, 'suspects').done, true, '시한이 지나면 다음 단계로 넘어간다');
  assert.deepEqual([objectiveState(r, 'suspects').have, objectiveState(r, 'suspects').need], [0, 1],
    '넘어가더라도 숫자는 사실대로 적는다');
  assert.equal(phaseComplete(r), true);

  // 방금 들어온 단계는 아직 멎은 것이 아니다.
  const fresh = stuck();
  fresh.phaseEnteredAt = Date.now();
  assert.equal(objectiveState(fresh, 'suspects').done, false);

  // 지금 단계가 붙잡고 있지 않은 목표는 시한을 타지 않는다. 그러지 않으면
  // 아직 오지도 않은 단계의 목표까지 시간으로 끝난 것이 되어 점수가 거짓이 된다.
  const early = stuck();
  early.phase = phaseIndex('approach');
  assert.equal(objectiveState(early, 'suspects').done, false);
  assert.ok(missedObjectives(early) > 0, '못 끝낸 목표는 점수에 그대로 남는다');

  // 구석에 숨어 버린 직원 한 명도 마찬가지다 (2단계).
  const hidden = room({
    phase: phaseIndex('sweep'),
    phaseEnteredAt: Date.now() - STALL_MS - 1000,
    npcs: [civilian({ id: 'c1', x: 0, z: 0 })],
  });
  assert.equal(objectiveState(hidden, 'civilians').done, true);
  // 시한과 무관하게, 셀 대상이 없으면 여전히 끝난 것이 아니다.
  hidden.npcs.length = 0;
  assert.equal(objectiveState(hidden, 'civilians').done, false);
});

/* ========================================================================== *
 *  3. 단계 전환
 * ========================================================================== */
test('1단계는 외곽 정리와 진입이 모두 끝나야 넘어간다', () => {
  const r = room({ npcs: [suspect({ id: 'o1', origin: 'outdoor' })] });
  assert.equal(phaseComplete(r), false, '아직 야외 인원이 살아 있다');

  r.npcs[0].arrested = true;
  assert.equal(phaseComplete(r), false, '진입을 아직 안 했다');

  r.flags.breached = true;
  assert.equal(phaseComplete(r), true);
});

test('한 번 끝난 목표는 되돌아가지 않는다', () => {
  const r = room({ npcs: [suspect({ id: 'o1', origin: 'outdoor', alive: false })] });
  r.flags.breached = true;
  assert.equal(phaseComplete(r), true);
  assert.ok(r.objectiveDone.has('perimeter'));

  // 철수 단계에서 증원이 들어와 야외 인원이 다시 생겨도 1단계는 다시 안 열린다.
  r.npcs.push(suspect({ id: 'rf_0', origin: 'outdoor', reinforcement: true }));
  assert.equal(objectiveState(r, 'perimeter').done, false);
  assert.equal(phaseComplete(r), true, '완료 기록이 남아 있어야 한다');
});

test('objectiveReport 는 지금 단계에서 봐야 할 것만 내보낸다', () => {
  const r = room({ npcs: [suspect({ id: 'o1', origin: 'outdoor' })] });
  const report = objectiveReport(r);
  assert.equal(report.phase, 0);
  assert.equal(report.id, 'approach');
  assert.deepEqual(report.list.map((o) => o.id), PHASES[0].show);
  for (const item of report.list) {
    assert.ok(item.label, `${item.id}: 문구가 비어 있다`);
    assert.ok(['primary', 'bonus'].includes(item.kind));
  }
  assert.equal(report.list.find((o) => o.id === 'breach').done, false);
  r.flags.breached = true;
  assert.equal(objectiveReport(r).list.find((o) => o.id === 'breach').done, true);
});

test('남긴 목표 수는 남은 단계의 필수 목표와 회수 못 한 증거를 합친 값이다', () => {
  // 1단계에서 아무것도 못 하고 끝난 판: 남은 필수 목표 전부 + 증거 3개
  const empty = room({
    npcs: [
      suspect({ id: 'o1', origin: 'outdoor' }),
      suspect({ id: 'hvt', kind: 'hvt' }),
      civilian({ id: 'hostage', hostage: true, alive: false }),
      civilian({ id: 'c1' }),
    ],
  });
  const requiredTotal = PHASES.reduce((sum, p) => sum + p.require.length, 0);
  assert.equal(missedObjectives(empty), requiredTotal + 3);

  // 방에 주요 용의자가 아예 없으면 그 목표는 판정상 달성으로 친다.
  const noHvt = room({ npcs: [suspect({ id: 'o1', origin: 'outdoor' })] });
  assert.equal(missedObjectives(noHvt), requiredTotal + 3 - 1);

  // 전부 끝낸 판
  const done = room({
    phase: PHASES.length - 1,
    npcs: [civilian({ id: 'hostage', hostage: true }), civilian({ id: 'c1', secured: true })],
    players: [standing({ x: EXTRACTION.x, z: EXTRACTION.z })],
  });
  done.evidence.forEach((e) => { e.taken = true; });
  assert.equal(missedObjectives(done), 0);
});

/* ========================================================================== *
 *  4. 채점
 * ========================================================================== */
test('체포가 사살보다 높게 평가된다', () => {
  const arrest = scoreMission({ completed: true, suspectsArrested: 5 });
  const kill = scoreMission({ completed: true, suspectsNeutralised: 5 });
  assert.ok(arrest.total > kill.total);
  assert.equal(SCORE.suspectArrested > SCORE.suspectNeutralised, true);
});

test('작전을 끝내지 못하면 점수와 무관하게 F 다', () => {
  const result = scoreMission({
    completed: false, phasesCleared: 4, civiliansRescued: 8, evidenceCollected: 3,
  });
  assert.ok(result.total > 900, '점수 자체는 높다');
  assert.equal(result.grade, 'F');
  assert.equal(gradeAdvice(result, { completed: false }), '작전을 끝까지 완수하면 등급이 매겨진다.');
});

test('민간인 피해 · 인질 사망 · 교전 규칙 위반은 등급 상한을 C 로 내린다', () => {
  const clean = scoreMission({
    completed: true, phasesCleared: 5, civiliansRescued: 8, suspectsArrested: 6,
    evidenceCollected: 3, devicesDefused: 2, hostageSaved: true,
  });
  assert.ok('SA'.includes(clean.grade), `깨끗한 판은 S 나 A 여야 한다: ${clean.grade}`);

  for (const fatal of [{ civiliansLost: 1 }, { hostageLost: true }, { roeViolations: 1 }]) {
    const stats = {
      completed: true, phasesCleared: 5, civiliansRescued: 8, suspectsArrested: 6,
      evidenceCollected: 3, devicesDefused: 2, hostageSaved: true, ...fatal,
    };
    const result = scoreMission(stats);
    assert.ok(!'SAB'.includes(result.grade), `${JSON.stringify(fatal)} 인데 ${result.grade} 가 나왔다`);
    assert.notEqual(gradeAdvice(result, stats), '더 잘할 수 있는 부분이 없다.');
  }
});

test('등급 경계는 점수 순서를 지킨다', () => {
  const grades = [];
  for (const phasesCleared of [0, 1, 2, 3, 4, 5]) {
    grades.push(scoreMission({ completed: true, phasesCleared, civiliansRescued: phasesCleared }).total);
  }
  for (let i = 1; i < grades.length; i++) {
    assert.ok(grades[i] > grades[i - 1], '단계를 더 끝낼수록 점수가 높아야 한다');
  }
});

test('채점 내역에는 0 인 항목이 나오지 않는다', () => {
  const result = scoreMission({ completed: true, phasesCleared: 5, civiliansRescued: 2 });
  for (const line of result.lines) {
    assert.ok(line.count > 0, `${line.label} 이 0 인데 표시된다`);
    assert.equal(typeof line.points, 'number');
  }
  assert.ok(result.lines.some((l) => l.label === '작전 완수'));
  assert.ok(!result.lines.some((l) => l.label === '민간인 사상'));
});

test('조언은 지금 가장 큰 문제를 먼저 짚는다', () => {
  const advice = (stats) => gradeAdvice(scoreMission(stats), stats);
  const base = { completed: true, phasesCleared: 5 };
  assert.match(advice({ ...base, hostageLost: true, civiliansLost: 1 }), /인질/);
  assert.match(advice({ ...base, civiliansLost: 1, roeViolations: 1 }), /민간인/);
  assert.match(advice({ ...base, roeViolations: 1 }), /교전 규칙/);
  assert.match(advice({ ...base, suspectsNeutralised: 4, suspectsArrested: 1 }), /체포/);
  assert.match(advice({ ...base, suspectsArrested: 4, objectivesMissed: 2 }), /목표/);
});

/* ========================================================================== *
 *  미션표가 실제로 채워지는가
 *
 *  "외곽 경비를 다 잡았는데 표가 그대로다" 는 판정이 아니라 전달의 문제였다.
 *  목표 하나가 끝날 때마다 보고서가 달라져야 서버가 그것을 보낼 수 있다.
 * ========================================================================== */
test('경비를 하나씩 처리하면 보고서의 수치와 내용이 그때그때 달라진다', () => {
  const guards = [
    suspect({ id: 'g1', origin: 'outdoor' }),
    suspect({ id: 'g2', origin: 'outdoor' }),
    suspect({ id: 'g3', origin: 'indoor' }),
  ];
  const r = room({ npcs: guards });
  const signature = () => JSON.stringify(objectiveReport(r).list);

  const before = signature();
  let state = objectiveState(r, 'perimeter');
  assert.deepEqual([state.have, state.need, state.done], [0, 2, false]);

  guards[0].alive = false;
  assert.notEqual(signature(), before, '한 명 잡으면 보고서가 바뀐다 (화면도 바뀐다)');
  state = objectiveState(r, 'perimeter');
  assert.deepEqual([state.have, state.need, state.done], [1, 2, false]);

  guards[1].state = 'surrender';           // 항복시켜도 처리된 것이다
  state = objectiveState(r, 'perimeter');
  assert.deepEqual([state.have, state.need, state.done], [2, 2, true]);

  // 실내 인원이 남아 있어도 "외곽"은 끝난 것으로 본다.
  assert.equal(objectiveState(r, 'suspects').done, false);
});

test('증거와 장치 목표는 무엇이 어느 방에 남았는지 알려 준다', () => {
  const r = room({
    evidence: [
      { id: 'ledger', label: '거래 장부', room: 'LIBRARY', taken: false },
      { id: 'drive', label: '암호 드라이브', room: 'GALLERY', taken: true },
    ],
    sites: [
      { id: 'A', label: '서재 A', room: 'LIBRARY', defused: false },
      { id: 'B', label: '온실 B', room: 'CONSERVATORY', defused: true },
    ],
  });
  const evidence = objectiveState(r, 'evidence');
  assert.equal(evidence.have, 1);
  assert.match(evidence.detail, /거래 장부/);
  assert.match(evidence.detail, /서재/, '방 이름을 한글로 알려 준다');
  assert.doesNotMatch(evidence.detail, /암호 드라이브/, '이미 회수한 것은 빼고 보여 준다');

  const devices = objectiveState(r, 'devices');
  assert.match(devices.detail, /서재 A/);
  assert.doesNotMatch(devices.detail, /온실 B/);

  // 다 끝난 목표에는 안내가 남지 않는다.
  r.evidence.forEach((e) => { e.taken = true; });
  const report = objectiveReport(r).list.find((o) => o.id === 'evidence');
  assert.equal(report.done, true);
  assert.equal(report.detail, '');
});
