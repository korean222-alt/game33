import { isIndoors } from './map-data.js';

export const POWER_CUT_DELAY_MS = 5000;
export function resetPower(room) {
  room.power = true;
  room.powerCutAt = null;
  room.powerCutDone = false;
  room.generatorStarted = false;
}
// Arm once on actual player entry, independent of mission phase or surviving guards.
export function powerCutDue(room, time) {
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
