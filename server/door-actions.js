/* =============================================================================
 *  server/door-actions.js  -  문 여닫기 (클라이언트의 public/js/doors.js 와 다르다)
 *
 *  doors.js 가 "문이 어떤 상태일 수 있는가" 를 갖고 있고, 이 파일은 그 상태를
 *  방에 반영하고 소리를 내고 예약된 동작을 시간 맞춰 처리한다.
 * ========================================================================== */
import { now, emitNoise } from './util.js';

export function setDoorState(room, id, state, io) {
  if (!room.doors.setState(id, state)) return false;
  room.doorsDirty = true;
  io.to(room.code).emit('doorState', { id, state });
  return true;
}

/** 문 동작은 시간이 걸린다. 소리는 즉시 나고 상태는 나중에 바뀐다. */
export function queueDoorAction(room, door, action, spec, state, byId, io) {
  emitNoise(room, door.x, door.z, spec.noise, `door-${action}`, byId);
  io.to(room.code).emit('doorAction', { id: door.id, action, by: byId, seconds: spec.seconds });
  room.doorQueue.push({ id: door.id, state, at: now() + spec.seconds * 1000 });
}

export function updateDoorQueue(room, io) {
  const t = now();
  for (let i = room.doorQueue.length - 1; i >= 0; i--) {
    if (t < room.doorQueue[i].at) continue;
    const entry = room.doorQueue.splice(i, 1)[0];
    setDoorState(room, entry.id, entry.state, io);
  }
}
