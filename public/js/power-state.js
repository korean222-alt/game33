import { isIndoors, BLACKOUT } from './map-data.js';

export const POWER_CUT_DELAY_MS = 5000;
export function resetPower(room) {
  room.power = true;
  room.powerCutAt = null;
  room.powerCutDone = false;
  room.generatorStarted = false;
}
/*
 * 정전.
 *
 *  맵이 정하는 일이다. 저택은 두꺼비집이 내려가고 예비 발전기로 복구하지만,
 *  사옥은 정전되지 않는다 - 그쪽은 형광등이 계속 켜져 있는 대신 화재경보기와
 *  스프링클러가 시야를 흐린다. 그래서 여기서는 "이 맵에 정전이 있는가"만 묻고,
 *  없으면 타이머 자체를 걸지 않는다.
 */
// Arm once on actual player entry, independent of mission phase or surviving guards.
export function powerCutDue(room, time) {
  if (!BLACKOUT) return false;
  if (room.powerCutDone || room.generatorStarted) return false;
  if (room.powerCutAt === null && room.standingPlayers.some(p => isIndoors(p.x, p.z))) {
    room.powerCutAt = time + POWER_CUT_DELAY_MS;
  }
  if (room.powerCutAt === null || time < room.powerCutAt) return false;
  room.powerCutDone = true;
  return true;
}
export function restorePower(room) {
  if (room.power || !room.powerCutDone || room.generatorStarted) return false;
  room.generatorStarted = true;
  room.power = true;
  return true;
}
