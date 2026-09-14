// Increment when map geometry or network entity/action payloads become incompatible.
export const GAME_PROTOCOL = 'ravenwood-entry-1';
export const UPDATE_MESSAGE = '게임 서버 업데이트가 아직 완료되지 않았습니다. 잠시 후 다시 접속해 주세요.';

export function compatibleMatch(data, myId) {
  return data?.protocol === GAME_PROTOCOL &&
    Array.isArray(data.npcs) && Array.isArray(data.doors) &&
    Array.isArray(data.players) && data.players.some(p =>
      p.id === myId && Number.isFinite(p.x) && Number.isFinite(p.z));
}
