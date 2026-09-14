/* =============================================================================
 *  scoring.js  -  임무 평가 (순수 함수, 서버/클라이언트/테스트 공용)
 *
 *  성공/실패만 알려 주면 배울 것이 없다. 무엇을 잘했고 무엇이 감점인지 항목별로
 *  보여 주고 S~F 등급을 매긴다. 체포와 구조가 사살보다 높게 평가된다.
 * ========================================================================== */

export const SCORE = {
  phaseCleared: 120,       // 완료한 단계당
  civilianRescued: 90,
  suspectArrested: 70,
  suspectNeutralised: 25,
  evidence: 45,
  deviceDefused: 80,
  hostageSaved: 140,
  missionComplete: 200,

  civilianCasualty: -220,
  hostageLost: -260,
  teamCasualty: -110,
  roeViolation: -160,      // 항복자 / 비무장자 사격
  objectiveMissed: -70,
};

const GRADES = [
  { grade: 'S', min: 1200, label: '완벽한 처리' },
  { grade: 'A', min: 950, label: '성공 · 손실 거의 없음' },
  { grade: 'B', min: 700, label: '주요 목표 달성 · 실수 있음' },
  { grade: 'C', min: 460, label: '달성했으나 피해와 누락이 많음' },
  { grade: 'D', min: 220, label: '간신히 완료' },
  { grade: 'F', min: -Infinity, label: '임무 실패 또는 치명적 결과' },
];

/**
 * @param {object} stats
 *   phasesCleared, civiliansRescued, civiliansLost, suspectsArrested,
 *   suspectsNeutralised, evidenceCollected, devicesDefused,
 *   hostageSaved(bool), hostageLost(bool), teamLost, roeViolations,
 *   objectivesMissed, completed(bool)
 */
export function scoreMission(stats) {
  const s = {
    phasesCleared: 0, civiliansRescued: 0, civiliansLost: 0, suspectsArrested: 0,
    suspectsNeutralised: 0, evidenceCollected: 0, devicesDefused: 0,
    hostageSaved: false, hostageLost: false, teamLost: 0, roeViolations: 0,
    objectivesMissed: 0, completed: false, ...stats,
  };

  const lines = [
    ['완료 단계', s.phasesCleared, SCORE.phaseCleared],
    ['민간인 구조', s.civiliansRescued, SCORE.civilianRescued],
    ['용의자 체포', s.suspectsArrested, SCORE.suspectArrested],
    ['용의자 무력화', s.suspectsNeutralised, SCORE.suspectNeutralised],
    ['증거 회수', s.evidenceCollected, SCORE.evidence],
    ['장치 해체', s.devicesDefused, SCORE.deviceDefused],
    ['인질 생존', s.hostageSaved ? 1 : 0, SCORE.hostageSaved],
    ['작전 완수', s.completed ? 1 : 0, SCORE.missionComplete],
    ['민간인 사상', s.civiliansLost, SCORE.civilianCasualty],
    ['인질 사망', s.hostageLost ? 1 : 0, SCORE.hostageLost],
    ['대원 전사', s.teamLost, SCORE.teamCasualty],
    ['교전 규칙 위반', s.roeViolations, SCORE.roeViolation],
    ['미완료 목표', s.objectivesMissed, SCORE.objectiveMissed],
  ].filter(([, count]) => count > 0)
    .map(([label, count, per]) => ({ label, count, points: count * per }));

  const total = lines.reduce((sum, line) => sum + line.points, 0);

  // 치명적 결과는 점수가 높아도 등급을 제한한다.
  let grade = GRADES.find((g) => total >= g.min);
  const fatal = s.civiliansLost > 0 || s.hostageLost || s.roeViolations > 0;
  if (!s.completed) grade = GRADES.find((g) => g.grade === 'F');
  else if (fatal && 'SAB'.includes(grade.grade)) grade = GRADES.find((g) => g.grade === 'C');

  return { total, grade: grade.grade, gradeLabel: grade.label, lines };
}

/** 다음 등급까지 무엇이 부족한지 한 줄로 알려 준다. */
export function gradeAdvice(result, stats) {
  if (!stats.completed) return '작전을 끝까지 완수하면 등급이 매겨진다.';
  if (stats.hostageLost) return '인질이 사망했다. 농성 중인 방은 섬광탄 없이 들어가지 않는다.';
  if (stats.civiliansLost) return '민간인 피해가 발생했다. 손을 든 대상과 비무장자를 먼저 식별해라.';
  if (stats.roeViolations) return '교전 규칙 위반이 기록됐다. 항복한 대상에게는 사격하지 않는다.';
  if (result.grade === 'S') return '더 잘할 수 있는 부분이 없다.';
  if (stats.suspectsNeutralised > stats.suspectsArrested) return '체포가 사살보다 높게 평가된다. 사기가 꺾인 상대는 항복시킬 수 있다.';
  if (stats.objectivesMissed) return '남긴 목표가 있다. 증거와 잔여 구역을 끝까지 확인해라.';
  return '대원 피해를 줄이면 등급이 올라간다.';
}
