/* =============================================================================
 *  doors.js  -  문 상태 기계 (서버/클라이언트 공용)
 *
 *  방이 "다 뚫려" 있지 않게 만드는 핵심 장치다. 닫힌 문은 사람과 시야와 총알을
 *  모두 막으므로, 방 안에 적이 있는지 없는지는 열어 보기 전에는 알 수 없다.
 *
 *  상태
 *    open        열림        - 막지 않음
 *    closed      닫힘        - 막음. 조용히 열 수 있다
 *    locked      잠김        - 막음. 해정(느림/조용) 또는 강제 개방(빠름/시끄러움)
 *    barricaded  바리케이드  - 막음. 강제 개방만 가능하고 시간이 더 걸린다
 *    destroyed   파괴        - 막지 않음. 다시 닫을 수 없다
 * ========================================================================== */

import { DOORWAYS, COLLIDERS, MAP } from './map-data.js';

export const DOOR = {
  OPEN: 'open', CLOSED: 'closed', LOCKED: 'locked',
  BARRICADED: 'barricaded', DESTROYED: 'destroyed',
};

const BLOCKING = new Set([DOOR.CLOSED, DOOR.LOCKED, DOOR.BARRICADED]);
export const isBlocking = (state) => BLOCKING.has(state);
export const isPassable = (state) => !BLOCKING.has(state);

/** 문 동작별 소요 시간(초)과 소음(0~1). */
export const DOOR_ACTIONS = {
  open: { seconds: 0.35, noise: 0.32 },
  close: { seconds: 0.35, noise: 0.28 },
  peek: { seconds: 0.7, noise: 0.06 },
  unlock: { seconds: 4.2, noise: 0.1 },
  kick: { seconds: 0.55, noise: 0.86 },
  breach: { seconds: 1.5, noise: 1.0 },
};

export const DOOR_REACH = 1.9;
const LEAF = 0.16;

/* ========================================================================== *
 *  문짝의 생김새
 *
 *  그리는 쪽(world.js)과 검사하는 쪽(tests/door-clearance)이 같은 값을 써야
 *  "보이는 문"과 "실제로 도는 문"이 어긋나지 않는다. 그래서 숫자를 여기 둔다.
 *
 *  각도가 90도를 넘으면 안 된다. 예전에는 0.52π(93.6도)까지 돌렸는데, 그러면
 *  문짝의 바깥쪽 모서리가 경첩 축을 지나 옆벽 안으로 파고든다 - 폭 3.2m 짜리
 *  정문에서는 20cm 가 벽을 뚫고 들어가 문틈으로 보면 벽이 깨져 보였다.
 *
 *  경첩도 문틀 안쪽으로 5cm 들여 놓는다. 문짝 두께(7cm)가 경첩 축을 중심으로
 *  반씩 나뉘어 있어서, 축이 문틀 모서리에 딱 붙어 있으면 활짝 열었을 때
 *  두께의 절반이 벽 속에 들어간다.
 * ========================================================================== */
export const DOOR_OPEN_ANGLE = Math.PI * 0.48;
export const DOOR_LEAF_THICKNESS = 0.07;
/** 이 폭부터는 두 짝짜리로 단다. 3.2m 문짝 한 장은 열면 방을 가로지른다. */
export const DOUBLE_LEAF_SPAN = 2.2;
const LEAF_INSET = 0.05;

/**
 * 문 한 짝의 치수.
 * @returns [{ hinge, offset, width }]
 *   hinge  +1/-1 - 경첩에서 문짝이 뻗는 방향 (문 축 기준)
 *   offset 문 중심에서 경첩까지의 거리 (문 축 기준)
 *   width  문짝 폭
 */
export function doorLeaves(door) {
  const half = door.span / 2;
  if (door.span >= DOUBLE_LEAF_SPAN) {
    const width = half - 0.06;
    return [
      { hinge: 1, offset: -(half - LEAF_INSET), width },
      { hinge: -1, offset: half - LEAF_INSET, width },
    ];
  }
  const hinge = door.hinge ?? 1;
  return [{ hinge, offset: -hinge * (half - LEAF_INSET), width: door.span - 0.06 }];
}

/**
 * 문틈으로 볼 때 눈이 서는 거리 (문 면에서 내 쪽으로).
 *
 *  벽 두께의 절반보다 확실히 멀어야 한다. 그러지 않으면 눈이 벽 속에 들어가고,
 *  카메라 근평면(5cm)이 벽을 잘라 내면서 반대편이 그냥 뚫려 보인다. 사무실
 *  외벽은 45cm 라 예전의 고정값 26cm 로는 눈이 벽 안쪽 3.5cm 지점에 섰다.
 */
export const peekOffset = (door) => Math.max(0.26, (door.thickness || 0.3) / 2 + 0.16);

/**
 * (x,z) 에서 문까지의 거리.
 *
 * 문 중심까지의 직선 거리로 재면 넓은 정문(폭 2.4m)에서는 문 앞에 바짝 서
 * 있어도 중심이 멀어서 손이 닿지 않는다고 나온다. 그래서 "문틀 선분"까지의
 * 거리로 잰다. 문 폭 안에 서 있으면 벽에서 떨어진 거리만 본다.
 *
 * 화면(안내 표시)과 서버(검증)가 같은 함수를 쓰므로, 안내가 떴는데 눌리지
 * 않는 상황이 생기지 않는다.
 */
export function doorDistance(door, x, z) {
  const alongAxis = door.axis === 'x' ? 'z' : 'x';
  const acrossAxis = door.axis === 'x' ? 'x' : 'z';
  const point = { x, z };
  const along = Math.max(0, Math.abs(point[alongAxis] - door[alongAxis]) - door.span / 2);
  const across = Math.abs(point[acrossAxis] - door[acrossAxis]);
  return Math.hypot(along, across);
}

/** 닫힌 문 한 장의 콜라이더. */
export function doorCollider(door) {
  const base = { x: door.x, z: door.z, y: 0, h: MAP.doorHeight, kind: 'door', id: door.id };
  return door.axis === 'x'
    ? { ...base, w: Math.max(door.thickness, LEAF), d: door.span }
    : { ...base, w: door.span, d: Math.max(door.thickness, LEAF) };
}

/**
 * 임무 시작 때 문 상태를 일부 무작위로 정한다.
 * 잠긴 문과 바리케이드는 "다른 길을 찾거나 시끄럽게 뚫어라"는 선택을 만든다.
 */
export function rollDoorStates(random = Math.random) {
  return DOORWAYS.map((door) => {
    let state = DOOR.CLOSED;
    if (door.kind === 'entry') {
      // 진입구 중 최소 하나는 조용히 열리도록 아래에서 보정한다.
      const roll = random();
      state = roll < 0.34 ? DOOR.LOCKED : roll < 0.42 ? DOOR.BARRICADED : DOOR.CLOSED;
    } else {
      const roll = random();
      state = roll < 0.18 ? DOOR.OPEN : roll < 0.3 ? DOOR.LOCKED : DOOR.CLOSED;
    }
    return { ...door, state };
  });
}

/** 저택 안으로 조용히 들어갈 방법이 하나도 없으면 한 곳을 열어 준다. */
export function ensureQuietEntry(doors, random = Math.random) {
  const entries = doors.filter((d) => d.kind === 'entry');
  if (entries.some((d) => d.state === DOOR.CLOSED || d.state === DOOR.OPEN)) return doors;
  entries[Math.floor(random() * entries.length) % entries.length].state = DOOR.CLOSED;
  return doors;
}

/* ========================================================================== *
 *  DoorSet - 문 묶음 하나와 그에 맞는 콜라이더 배열
 *
 *  콜라이더 배열은 상태가 바뀔 때만 새로 만든다. 배열의 동일성이 유지되어야
 *  map-data 의 브로드페이즈 격자 캐시가 재사용된다.
 * ========================================================================== */
export class DoorSet {
  constructor(doors = rollDoorStates(() => 0.9)) {
    this.doors = doors;
    this.byId = new Map(doors.map((d) => [d.id, d]));
    this._signature = null;
    this._colliders = COLLIDERS;
    this.version = 0;
  }

  get(id) { return this.byId.get(id) || null; }

  /** 상태를 바꾸고 실제로 바뀌었는지 알려 준다. */
  setState(id, state) {
    const door = this.byId.get(id);
    if (!door || door.state === state) return false;
    door.state = state;
    this.version++;
    return true;
  }

  /** 지금 막혀 있는 문을 포함한 충돌/시야용 콜라이더 목록. */
  colliders() {
    const signature = this.doors.map((d) => (isBlocking(d.state) ? '1' : '0')).join('');
    if (signature !== this._signature) {
      this._signature = signature;
      const blocked = this.doors.filter((d) => isBlocking(d.state));
      this._colliders = blocked.length ? COLLIDERS.concat(blocked.map(doorCollider)) : COLLIDERS;
    }
    return this._colliders;
  }

  /** (x,z) 에서 손이 닿는 가장 가까운 문. */
  nearest(x, z, reach = DOOR_REACH) {
    let best = null, bestD = reach;
    for (const door of this.doors) {
      const d = doorDistance(door, x, z);
      if (d < bestD) { best = door; bestD = d; }
    }
    return best && { door: best, distance: bestD };
  }

  /** 두 점을 잇는 선이 이 문틀을 지나가는가 (봇이 문을 열어야 하는지 판단). */
  blockingBetween(from, to) {
    for (const door of this.doors) {
      if (!isBlocking(door.state)) continue;
      const along = door.axis === 'x' ? 'x' : 'z';
      const across = door.axis === 'x' ? 'z' : 'x';
      const a = from[along] - door[along], b = to[along] - door[along];
      if (a === b || (a > 0) === (b > 0)) continue;              // 문의 면을 넘지 않았다
      const k = a / (a - b);
      const cross = from[across] + (to[across] - from[across]) * k;
      if (Math.abs(cross - door[across]) <= door.span / 2 + 0.45) return door;
    }
    return null;
  }

  /** 어떤 동작이 가능한지. HUD 표시와 서버 검증이 같은 규칙을 쓴다. */
  available(door) {
    switch (door.state) {
      case DOOR.OPEN: return ['close'];
      case DOOR.CLOSED: return ['open', 'peek', 'kick'];
      case DOOR.LOCKED: return ['peek', 'unlock', 'kick'];
      case DOOR.BARRICADED: return ['peek', 'kick'];
      default: return [];
    }
  }

  /** 동작의 결과 상태. 불가능하면 null. */
  resultOf(door, action) {
    if (!this.available(door).includes(action)) return null;
    switch (action) {
      case 'open': return DOOR.OPEN;
      case 'close': return DOOR.CLOSED;
      case 'unlock': return DOOR.CLOSED;
      case 'kick': return door.state === DOOR.BARRICADED ? DOOR.DESTROYED : DOOR.OPEN;
      case 'peek': return door.state;
      default: return null;
    }
  }

  snapshot() { return this.doors.map((d) => ({ id: d.id, state: d.state })); }

  apply(snapshot) {
    for (const { id, state } of snapshot) this.setState(id, state);
  }
}

/** 문의 두 연결 구역 중 (x,z) 반대편 구역 이름. */
export function otherSide(door, x, z) {
  if (door.link.length < 2) return null;
  const near = door.axis === 'x' ? x < door.x : z < door.z;
  return near ? door.link[1] : door.link[0];
}

/** 문 기준 "안쪽"으로 1.2m 들어간 지점 (돌입 목표점). */
export function throughPoint(door, fromX, fromZ, distance = 1.4) {
  if (door.axis === 'x') {
    const sign = fromX < door.x ? 1 : -1;
    return { x: door.x + sign * distance, z: door.z };
  }
  const sign = fromZ < door.z ? 1 : -1;
  return { x: door.x, z: door.z + sign * distance };
}
