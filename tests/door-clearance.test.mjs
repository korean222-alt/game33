/* =============================================================================
 *  door-clearance.test.mjs  -  문짝이 도는 자리가 비어 있는가
 *
 *  문은 이 게임에서 제일 자주 보는 물건이다. 그래서 문 하나가 벽이나 가구를
 *  뚫고 지나가면 그 맵 전체가 허술해 보인다. 여기서 보는 것은 셋이다.
 *
 *    1) 열린 문짝이 지나가는 부채꼴 안에 아무것도 없다
 *    2) 문짝은 90도를 넘게 돌지 않는다 (넘으면 바깥 모서리가 옆벽을 판다)
 *    3) 문틈으로 볼 때 눈이 벽 속에 들어가지 않는다
 *
 *  전부 맵 데이터만 보고 판정할 수 있어서, 브라우저를 띄우지 않고도 "사무실
 *  정문을 열면 풍제실 유리를 뚫는다" 같은 것을 잡을 수 있다.
 * ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMap, setActiveMap, overlaps } from '../public/js/map-data.js';
import {
  doorLeaves, peekOffset, DOOR_OPEN_ANGLE, DOOR_LEAF_THICKNESS, DOUBLE_LEAF_SPAN,
} from '../public/js/doors.js';

const MAPS = ['mansion', 'office'];
/** 카메라 근평면. 이보다 가까운 면은 잘려서 그 너머가 그대로 보인다. */
const CAMERA_NEAR = 0.05;

/** 문짝이 각도 a 만큼 돌았을 때 판이 차지하는 점들 (맵 좌표). */
function* leafPoints(door, leaf, a) {
  for (let r = 0; r <= leaf.width + 1e-9; r += 0.06) {
    for (const t of [-DOOR_LEAF_THICKNESS / 2, DOOR_LEAF_THICKNESS / 2]) {
      const along = leaf.offset + (Math.cos(a) * r - Math.sin(a) * t) * leaf.hinge;
      const across = -Math.sin(a) * r - Math.cos(a) * t;
      yield door.axis === 'x'
        ? [door.x + across, door.z + along]
        : [door.x + along, door.z + across];
    }
  }
}

test('문짝은 90도를 넘게 돌지 않는다', () => {
  // 넘어가는 순간 바깥쪽 모서리가 경첩 축 뒤로 넘어가면서 옆벽을 파고든다.
  assert.ok(DOOR_OPEN_ANGLE < Math.PI / 2,
    `열림 각도 ${DOOR_OPEN_ANGLE} 이 직각을 넘는다`);
  assert.ok(DOOR_OPEN_ANGLE > Math.PI * 0.4, '너무 조금 열리면 지나갈 수 없다');
});

test('넓은 문은 두 짝으로 달려서 문 폭 밖으로 안 나온다', () => {
  for (const id of MAPS) {
    for (const door of getMap(id).DOORWAYS) {
      const leaves = doorLeaves(door);
      assert.equal(leaves.length, door.span >= DOUBLE_LEAF_SPAN ? 2 : 1,
        `${id}/${door.id} (폭 ${door.span}) 의 문짝 수가 이상하다`);
      /* 문짝이 도는 동안 문 폭 밖으로 나가면 안 된다. 나가는 순간 그 끝은
       * 옆벽 안이다 - 닫힌 문 옆은 언제나 벽이기 때문이다. */
      for (const leaf of leaves) {
        for (let a = 0; a <= DOOR_OPEN_ANGLE + 1e-9; a += 0.05) {
          for (const [x, z] of leafPoints(door, leaf, a)) {
            const along = door.axis === 'x' ? z - door.z : x - door.x;
            assert.ok(Math.abs(along) <= door.span / 2 + 0.005,
              `${id}/${door.id}: 문짝 끝이 문 폭(${door.span}) 밖 ${along.toFixed(2)} 까지 나간다`);
          }
        }
      }
    }
  }
});

test('열린 문짝이 지나가는 자리에 벽도 가구도 없다', () => {
  for (const id of MAPS) {
    setActiveMap(id);
    const map = getMap(id);
    const doorHeight = map.MAP.doorHeight;
    /* 문 높이보다 위에 있는 것(상인방)과 바닥에 깔린 것은 문짝이 지나가도
     * 부딪히지 않는다. 나머지는 전부 걸리면 안 된다. */
    const solids = map.COLLIDERS.filter(
      (c) => (c.y || 0) < doorHeight - 0.02 && (c.y || 0) + c.h > 0.1);
    const blocked = [];
    for (const door of map.DOORWAYS) {
      for (const leaf of doorLeaves(door)) {
        for (let a = 0; a <= DOOR_OPEN_ANGLE + 1e-9; a += 0.03) {
          for (const [x, z] of leafPoints(door, leaf, a)) {
            const hit = solids.find((c) => overlaps(x, z, 0.001, c));
            if (hit) blocked.push(`${door.id} -> ${hit.kind}${hit.material ? ' ' + hit.material : ''} (${hit.x}, ${hit.z})`);
          }
        }
      }
    }
    assert.deepEqual([...new Set(blocked)], [], `${id}: 문짝이 무언가를 뚫고 지나간다`);
  }
  setActiveMap('mansion');
});

test('문틈으로 보는 눈이 벽 속에 들어가지 않는다', () => {
  for (const id of MAPS) {
    const map = getMap(id);
    for (const door of map.DOORWAYS) {
      const clearance = peekOffset(door) - door.thickness / 2;
      assert.ok(clearance > CAMERA_NEAR + 0.05,
        `${id}/${door.id}: 벽 두께 ${door.thickness} 인데 눈이 ${peekOffset(door)}m 에 선다`);
    }
  }
});
