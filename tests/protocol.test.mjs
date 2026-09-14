import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_PROTOCOL, compatibleMatch } from '../public/js/protocol.js';

const valid = () => ({
  protocol: GAME_PROTOCOL, npcs: [], doors: [],
  players: [{ id: 'me', x: -2.2, z: 30.4 }],
});
test('legacy indoor/bots payload cannot start a tactical-entry client', () => {
  assert.equal(compatibleMatch({ bots: [{}], players: [{ id: 'me', x: -2, z: 15 }] }, 'me'), false);
});
test('matching protocol still requires NPC, door and local player data', () => {
  assert.equal(compatibleMatch(valid(), 'me'), true);
  for (const key of ['npcs', 'doors', 'players']) {
    const data = valid(); delete data[key];
    assert.equal(compatibleMatch(data, 'me'), false);
  }
  assert.equal(compatibleMatch(valid(), 'someone-else'), false);
  const data = valid(); data.players[0].x = NaN;
  assert.equal(compatibleMatch(data, 'me'), false);
});
