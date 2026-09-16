/* =============================================================================
 *  map-data.js  -  맵 레지스트리 (서버/클라이언트 공용)
 *
 *  예전에는 이 파일이 라벤우드 저택 그 자체였다. WALLS, ROOMS, POSTS… 전부
 *  모듈 최상위 `export const` 로 박혀 있었고, 서버와 클라이언트 열한 개 파일이
 *  그걸 직접 가져다 썼다. 맵을 하나 더 만들려면 파일을 추가하는 게 아니라 그
 *  전역 구조를 통째로 뜯어야 했다.
 *
 *  지금 이 파일이 하는 일은 셋뿐이다.
 *    1) maps/ 아래의 맵들을 등록한다
 *    2) 그중 하나를 "지금 켜진 맵" 으로 삼는다 (setActiveMap)
 *    3) 켜진 맵의 데이터를 예전과 똑같은 이름으로 다시 내보낸다
 *
 *  3번이 요점이다. `export let` 은 ES 모듈에서 살아 있는 연결(live binding)이라,
 *  여기서 값을 바꾸면 이미 import 해 간 쪽의 WALLS 도 같이 바뀐다. 덕분에
 *  가져다 쓰는 파일 열한 개를 한 줄도 고치지 않고 맵을 갈아 끼울 수 있다.
 *
 *  ⚠ 주의: 한 프로세스가 동시에 여러 맵을 돌릴 수는 없다. 서버는 방마다
 *  room.mapId 를 들고 있고, 그 방을 건드리기 직전에 setActiveMap(room.mapId)
 *  을 부른다 (server/room.js 의 useRoomMap). tickRoom 도 소켓 핸들러도 전부
 *  동기 코드라 그 사이에 다른 방이 끼어들 수 없다.
 * ========================================================================== */
import { MANSION } from './maps/mansion.js';
import { OFFICE } from './maps/office.js';
import { useGeometry } from './map-geometry.js';

export {
  nearbyColliders, overlaps, resolveCircle, moveBody, groundHeight,
  segmentHitsBox, hasLineOfSight, rayWallDistance, rayObstacleDistance,
  obstaclesBetween, outOfBounds,
} from './map-geometry.js';

/** 고를 수 있는 맵. 로비의 맵 선택이 이 순서대로 나온다. */
export const MAPS = [MANSION, OFFICE];
export const DEFAULT_MAP_ID = MANSION.id;

const byId = new Map(MAPS.map((m) => [m.id, m]));

export function getMap(id) { return byId.get(id) || MANSION; }
export function hasMap(id) { return byId.has(id); }
/** 로비 화면에 뿌릴 목록 (데이터 덩어리 전체를 보내지 않는다). */
export const mapChoices = () => MAPS.map((m) => ({ id: m.id, label: m.label, blurb: m.blurb }));

/* ========================================================================== *
 *  지금 켜진 맵
 * ========================================================================== */
export let CURRENT_MAP = MANSION;

export let MAP = MANSION.MAP;
export let BACKUP_GENERATOR = MANSION.BACKUP_GENERATOR;
export let WALLS = MANSION.WALLS;
export let DOORWAYS = MANSION.DOORWAYS;
export let ARCHES = MANSION.ARCHES;
export let ROOMS = MANSION.ROOMS;
export let CORRIDORS = MANSION.CORRIDORS;
export let AREAS = MANSION.AREAS;
export let FURNITURE = MANSION.FURNITURE;
export let PROPS = MANSION.PROPS;
export let LIGHTS = MANSION.LIGHTS;
export let SPAWNS = MANSION.SPAWNS;
export let EXTRACTION = MANSION.EXTRACTION;
export let BOMB_SITES = MANSION.BOMB_SITES;
export let EVIDENCE_SPOTS = MANSION.EVIDENCE_SPOTS;
export let POSTS = MANSION.POSTS;
export let CIVILIAN_SPOTS = MANSION.CIVILIAN_SPOTS;
export let HVT_ROOMS = MANSION.HVT_ROOMS;
export let COLLIDERS = MANSION.COLLIDERS;
export let COVER_POINTS = MANSION.COVER_POINTS;
export let BOT_SPAWNS = MANSION.BOT_SPAWNS;
export let PATROL_NODES = MANSION.PATROL_NODES;
/** 이 맵만의 볼거리와 사건. 없는 맵도 있다. */
export let EVENTS = MANSION.EVENTS || [];

/**
 * 맵을 갈아 끼운다. 같은 맵이면 아무것도 하지 않는다(길찾기 격자를 지키려고).
 * @returns {boolean} 실제로 바뀌었는가
 */
export function setActiveMap(id) {
  const next = getMap(id);
  if (next === CURRENT_MAP) return false;
  CURRENT_MAP = next;
  MAP = next.MAP;
  BACKUP_GENERATOR = next.BACKUP_GENERATOR;
  WALLS = next.WALLS;
  DOORWAYS = next.DOORWAYS;
  ARCHES = next.ARCHES;
  ROOMS = next.ROOMS;
  CORRIDORS = next.CORRIDORS;
  AREAS = next.AREAS;
  FURNITURE = next.FURNITURE;
  PROPS = next.PROPS;
  LIGHTS = next.LIGHTS;
  SPAWNS = next.SPAWNS;
  EXTRACTION = next.EXTRACTION;
  BOMB_SITES = next.BOMB_SITES;
  EVIDENCE_SPOTS = next.EVIDENCE_SPOTS;
  POSTS = next.POSTS;
  CIVILIAN_SPOTS = next.CIVILIAN_SPOTS;
  HVT_ROOMS = next.HVT_ROOMS;
  COLLIDERS = next.COLLIDERS;
  COVER_POINTS = next.COVER_POINTS;
  BOT_SPAWNS = next.BOT_SPAWNS;
  PATROL_NODES = next.PATROL_NODES;
  EVENTS = next.EVENTS || [];
  useGeometry(next);
  return true;
}

/* 첫 켜기. 여기까지 오지 않으면 map-geometry 의 기본 콜라이더가 비어 있다. */
useGeometry(MANSION);

/* ========================================================================== *
 *  켜진 맵에 물어보는 것
 * ========================================================================== */
/** 좌표가 속한 구역 이름. 실내 우선. */
export function zoneAt(x, z) { return CURRENT_MAP.zoneAt(x, z); }
export const isIndoors = (x, z) => CURRENT_MAP.isIndoors(x, z);
/** start 에서 goal 까지의 경유점 목록. 길이 0 이면 경로가 없다. */
export function findRoute(start, goal) { return CURRENT_MAP.nav.findRoute(start, goal); }
/** 격자 위에서 서로 닿을 수 있는지 (경로 존재 여부만 빠르게 확인). */
export function isReachable(from, to) { return CURRENT_MAP.nav.isReachable(from, to); }
