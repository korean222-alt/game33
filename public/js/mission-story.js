/* =============================================================================
 *  mission-story.js  -  작전 "긴 밤" 의 브리핑 · 단계 · 무전 · 후기
 *
 *  원작의 이름과 사건을 쓰지 않는 독자 설정이다. 한 판이 짧게 끝나지 않도록
 *  다섯 단계로 나누고, 단계마다 목표와 무전이 바뀐다.
 *
 *  아래 글은 저택을 전제로 쓰여 있다. 맵마다 다른 문구는 파일 끝의
 *  objectiveLabel / phaseText / missionLine 을 거쳐 나간다.
 * ========================================================================== */
import { CURRENT_MAP, getMap } from './map-data.js';

/** 목표 정의. server.js 가 상태를 계산하고 HUD 가 이 문구를 보여 준다. */
export const OBJECTIVES = {
  perimeter: { label: '담장 안 외곽의 무장 인원 무력화', kind: 'primary' },
  breach: { label: '저택 내부 진입', kind: 'primary' },
  civilians: { label: '민간인 전원 확보', kind: 'primary' },
  devices: { label: '기록 소각 장치 해체', kind: 'primary' },
  hvt: { label: '주요 용의자 체포 또는 제압', kind: 'primary' },
  hostage: { label: '인질 생존', kind: 'primary' },
  suspects: { label: '저택 내 무장 인원 정리', kind: 'primary' },
  extract: { label: '전원 정문으로 철수', kind: 'primary' },
  evidence: { label: '증거 회수', kind: 'bonus' },
  generator: { label: '예비 발전기 가동', kind: 'bonus' },
  quiet: { label: '민간인 피해 0명', kind: 'bonus' },
  arrests: { label: '체포 우선 처리', kind: 'bonus' },
};

export const PHASES = [
  {
    id: 'approach',
    name: '1단계 · 외곽',
    title: '담장 안으로',
    hint: '앞마당과 측면 통로의 경비를 먼저 처리한다. 총성은 저택 안까지 전달된다.',
    require: ['perimeter', 'breach'],
    show: ['perimeter', 'breach', 'evidence'],
    radio: '지휘부: 담장 안으로 진입해라. 초소와 진입로부터 확인하고, 가능하면 조용히 처리해라.',
  },
  {
    id: 'sweep',
    name: '2단계 · 수색',
    title: '어둠 속의 방들',
    hint: '정전되면 손전등으로 수색하고, 북동쪽 작업실의 예비 발전기로 전력을 복구할 수 있다.',
    require: ['civilians', 'devices'],
    show: ['civilians', 'devices', 'evidence', 'quiet'],
    radio: '지휘부: 안쪽은 방이 많다. 문틈으로 먼저 확인해라. 민간인이 섞여 있다.',
    // 정전은 서버의 최초 진입 후 5초 타이머가 처리한다.
  },
  {
    id: 'hvt',
    name: '3단계 · 주요 용의자',
    title: '농성 중인 방',
    hint: '주요 용의자는 인질을 붙잡고 있다. 인질이 죽으면 작전은 실패로 기록된다.',
    require: ['hvt', 'hostage'],
    show: ['hvt', 'hostage', 'evidence', 'arrests'],
    radio: '지휘부: 도면 확인됐다. 주요 용의자가 인질과 함께 한 방에 있다. 인질을 먼저 생각해라.',
  },
  {
    id: 'clear',
    name: '4단계 · 확보',
    title: '남은 저항',
    hint: '흩어진 잔여 인원이 방을 옮겨 다니며 매복한다. 서두르면 뒤를 내준다.',
    require: ['suspects'],
    show: ['suspects', 'evidence', 'quiet', 'arrests'],
    radio: '지휘부: 잔여 인원이 남아 있다. 구역을 하나씩 확보해라.',
  },
  {
    id: 'extract',
    name: '5단계 · 철수',
    title: '정문으로',
    hint: '증원 차량이 정문으로 들어온다. 확보한 기록을 들고 빠져나가라.',
    require: ['extract'],
    show: ['extract', 'evidence', 'quiet'],
    radio: '지휘부: 외부 증원이 접근 중이다. 회수한 것을 들고 정문으로 나와라.',
  },
];

export const MISSION = {
  id: 'ravenwood-longnight',
  title: '작전명: 긴 밤',
  location: '라벤우드 저택 구역',
  time: '02:10 · 담장 밖 집결',
  pages: [
    {
      label: '01 / 사건 개요', title: '끊긴 통화',
      body: '01시 42분, 라벤우드 저택에서 짧은 신고가 들어왔다. 통화는 "사람들이 지하로 옮겨지고 있다"는 말과 함께 끊겼다. 열화상 정찰 결과 담장 안에 최소 다섯 명의 무장 인원과 그보다 많은 비무장 인원이 확인됐다.',
      detail: '저택은 15년째 명의만 남은 건물이다. 등기상 소유자는 3년 전 사망 처리되어 있다.',
    },
    {
      label: '02 / 현장 구조', title: '밖에서 시작한다',
      body: '팀은 담장 정문 밖에 집결해 있다. 앞마당에는 경비 초소와 차량 두 대가 있고, 저택으로 들어가는 길은 정면 현관, 서측 보조문, 동측 온실문, 그리고 후원 쪽 두 곳이다. 어느 문이 잠겨 있는지는 매번 다르다.',
      detail: '진입구는 열어 보기 전까지 상태를 알 수 없다. 잠긴 문은 해정에 시간이 걸리고, 발로 차면 저택 절반이 그 소리를 듣는다.',
    },
    {
      label: '03 / 내부', title: '다 뚫려 있지 않다',
      body: '1층은 중앙 대홀과 양쪽 날개의 여섯 개 방으로 나뉜다. 방과 방 사이는 모두 문으로 막혀 있다. 어느 방에 사람이 있는지는 정찰로 확인되지 않았다. 비어 있는 방도 분명히 있다.',
      detail: '문틈 확인은 소리를 거의 내지 않는다. 대신 얻는 정보도 적다. 인원이 있다는 것만 알 수 있고, 몇 명인지 어디에 서 있는지는 알 수 없다.',
    },
    {
      label: '04 / 교전 규칙', title: '쏘기 전에 판단한다',
      body: '무기를 들고 우리를 향하는 대상에게만 사격이 허용된다. 손을 든 사람, 무기를 버린 사람, 민간인에게 발사하면 규칙 위반으로 기록된다. 저항을 포기한 대상은 체포한다.',
      detail: '체포와 구조는 사살보다 높게 평가된다. 최종 등급은 목표 달성, 체포, 구조, 증거, 아군 피해, 규칙 위반을 모두 합산해 S부터 F까지 매긴다.',
    },
    {
      label: '05 / 장비', title: '섬광탄을 아껴 쓰지 마라',
      body: '문을 겨누고 엄폐한 상대를 정면으로 상대하면 손해를 본다. 섬광탄으로 눈을 가리고 들어가거나, 가스로 자리를 뺏은 뒤 진입하는 것이 정석이다. 파편탄은 민간인이 없다고 확인된 구역에서만 쓴다.',
      detail: '섬광탄 2 · 가스탄 2 · 파편탄 1 로 시작한다. 벽 뒤에서 터진 섬광탄은 아무 효과가 없다. 문을 먼저 열어야 한다.',
    },
    {
      label: '06 / 진입 명령', title: '레드 팀, 준비 상태 보고',
      body: '지휘부: "다섯 단계로 간다. 외곽 확보, 방 수색과 민간인 구조, 주요 용의자, 잔여 인원, 그리고 철수. 서두르지 마라. 오늘 밤의 목적은 안에 있는 사람들을 데리고 나오는 것이다."',
      detail: '전원이 진입 준비를 마치면 작전이 시작된다. 총 제한 시간 22분. 브리핑 중에는 시간이 흐르지 않는다.',
    },
  ],
  entry: '지휘부: 레드 팀, 진입 승인. 담장 안에서 움직이는 것은 전부 확인 대상이다.',
  siteA: '지휘부: 저장고 장치 정지 확인. 기록이 남았다.',
  siteB: '지휘부: 하인 구역 장치 정지 확인. 통신 기록을 확보했다.',
  civilianRescued: '지휘부: 민간인 확보 보고 접수. 계속 진행해라.',
  hvtFound: '지휘부: 주요 용의자 확인. 인질 상태 우선 보고해라.',
  hvtDown: '지휘부: 주요 용의자 무력화. 인질 상태 확인해라.',
  reinforcements: '지휘부: 경고. 외부 차량 두 대가 정문으로 들어왔다. 무장 인원이 내리고 있다.',
  powerCut: '지휘부: 전력이 끊겼다. 손전등으로 북동쪽 작업실의 예비 발전기를 찾아 차단기를 올려라.',
  powerRestored: '지휘부: 예비 발전기 가동 확인. 저택 전력이 복구됐다.',
  won: '문을 하나씩 열어 확인하는 동안 밤이 다 갔다. 저택 안에 있던 사람들은 담장 밖으로 나왔고, 소각되기 직전의 기록도 함께 나왔다. 장부에 적힌 이름들은 이 저택보다 훨씬 넓은 곳까지 이어져 있었다. 오늘 밤의 일은 그 첫 장에 지나지 않는다.',
  lost: '작전은 중단됐다. 지휘부는 구역을 다시 봉쇄하고 열화상 기록을 다시 돌려 본다. 무엇을 놓쳤는지는 기록에 남는다. 대기실에서 장비와 진입 순서를 다시 정하라.',
};

/** 단계 id -> 인덱스 */
export const phaseIndex = (id) => Math.max(0, PHASES.findIndex((p) => p.id === id));
export const phaseOf = (id) => PHASES[phaseIndex(id)];

/* ========================================================================== *
 *  맵마다 다른 문구
 *
 *  위의 글은 전부 저택을 전제로 쓰여 있다. "저택 내부 진입", "북동쪽 작업실의
 *  예비 발전기". 사무실 맵에서 그대로 띄우면 화면에는 사옥이 보이는데 목표에는
 *  저택이라고 적혀 있다 - 실제로 그런 화면이 나와서 이 장치를 넣었다.
 *
 *  맵 파일이 STORY 를 들고 있으면 그것으로 덮어쓰고, 없으면 저택 문구를 쓴다.
 *  단계 구조(무엇을 끝내야 다음으로 넘어가는가)는 덮어쓰지 않는다 - 그건 규칙이지
 *  문구가 아니다.
 * ========================================================================== */
const storyOf = () => CURRENT_MAP?.STORY || {};

/** 목표 한 줄의 이름. */
export const objectiveLabel = (id) => storyOf().objectives?.[id] ?? OBJECTIVES[id]?.label ?? id;
/** 단계 하나의 제목·안내·무전. 덮어쓴 것만 갈아 끼운다. */
export const phaseText = (phase) => {
  const override = storyOf().phases?.[phase.id];
  return override ? { ...phase, ...override } : phase;
};
/** 무전 한 줄 (MISSION 의 열쇠). */
export const missionLine = (key) => storyOf().mission?.[key] ?? MISSION[key];
/**
 * 브리핑에 쓰는 한 벌.
 *
 *  로비에서는 아직 맵을 켜지 않았다 (씬을 다시 짓는 것은 경기가 시작될 때다).
 *  그래서 켜진 맵이 아니라 "지금 고른 맵 id" 로 묻는다.
 */
export const missionOf = (mapId) => ({ ...MISSION, ...(getMap(mapId)?.STORY?.mission || {}) });

