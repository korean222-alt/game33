/* =============================================================================
 *  maps/build.js  -  맵 한 채를 짓는 데 쓰는 연장
 *
 *  벽 한 줄을 문 구멍만 비워 두고 채우는 run(), 구역 판정, 그리고 다 지은
 *  데이터를 콜라이더·엄폐지점·길찾기 격자가 붙은 완성품으로 마무리하는
 *  finishMap(). 저택도 사무실도 이 세 가지를 똑같이 쓴다.
 *
 *  이 파일이 생기기 전에는 저 논리가 map-data.js 안에 저택 데이터와 한 덩어리로
 *  섞여 있었다. 그래서 맵을 하나 더 넣으려면 파일을 추가하는 게 아니라 전역
 *  상수 구조를 통째로 뜯어야 했다.
 * ========================================================================== */
import { createNav, buildCoverPoints, useGeometry } from '../map-geometry.js';

/**
 * 벽 한 줄을 세운다. 구멍(gap)만 비우고, 구멍 위에는 상인방을 올려서 문을
 * 넘겨다볼 수 없게 한다.
 *
 * @param out       { WALLS, DOORWAYS, ARCHES } - 결과를 밀어 넣을 자리
 * @param axis      'x' 면 x=at 에 서서 z 로 뻗는 벽, 'z' 면 z=at 에 서서 x 로 뻗는 벽
 * @param gaps      [{ at, span, door }] - door 가 있으면 문으로 등록된다.
 *                  door 없이 arch: true 면 문짝 없는 아치(상인방만 올린다).
 *                  둘 다 없으면 천장까지 뚫린 구멍(담장 정문, 복도 입구).
 */
export function makeRun(out, doorHeight) {
  return function run(axis, at, from, to, thickness, height, gaps = []) {
    const place = (a, b, y = 0, h = height) => {
      if (b - a < 0.001 || h < 0.001) return;
      const mid = (a + b) / 2, len = b - a;
      out.WALLS.push(axis === 'x'
        ? { x: at, z: mid, w: thickness, d: len, h, y }
        : { x: mid, z: at, w: len, d: thickness, h, y });
    };

    const sorted = [...gaps].sort((a, b) => a.at - b.at);
    let cursor = from;
    for (const gap of sorted) {
      place(cursor, gap.at - gap.span / 2);
      cursor = gap.at + gap.span / 2;
      if (!gap.door && !gap.arch) continue;
      // 문(아치) 위쪽 벽. 없으면 옆방을 넘겨다볼 수 있다.
      place(gap.at - gap.span / 2, cursor, doorHeight, height - doorHeight);
      if (!gap.door) {
        out.ARCHES.push({
          axis, span: gap.span, thickness,
          x: axis === 'x' ? at : gap.at,
          z: axis === 'x' ? gap.at : at,
          link: gap.link || [],
        });
        continue;
      }
      out.DOORWAYS.push({
        id: gap.door, axis, span: gap.span, thickness,
        x: axis === 'x' ? at : gap.at,
        z: axis === 'x' ? gap.at : at,
        hinge: gap.hinge ?? 1,
        kind: gap.kind || 'interior',
        link: gap.link || [],
      });
    }
    place(cursor, to);
  };
}

/** 가구 한 덩이를 밀어 넣는 손잡이. 맵 파일마다 하나씩 만들어 쓴다. */
export function makePart(FURNITURE) {
  return (x, z, w, d, h, y = 0, material = 'wood', ry = 0) =>
    FURNITURE.push({ x, z, w, d, h, y, material, ry });
}

/**
 * 다 지은 맵 데이터에 파생물을 붙여 완성한다.
 *
 *  COLLIDERS 는 벽 + 가구 + 소품을 합친 것이고, 엄폐 지점과 길찾기 격자는 그
 *  콜라이더에서 나온다. 맵마다 손으로 다시 쓰면 반드시 어긋나므로 여기 한 곳에
 *  둔다.
 */
export function finishMap(map) {
  map.COLLIDERS = [
    ...map.WALLS.map((w) => ({ ...w, kind: 'wall' })),
    /* 보이지 않지만 막는 것. 지금은 건물 지붕뿐이다.
     *
     *  지붕에 콜라이더가 없으면 밖에서 높은 데 올라선 사람 - 초소의 저격수 -
     *  이 건물 위로 총알을 넘겨 반대편 마당까지 쏜다. 화면에는 지붕이 보이는데
     *  총알만 통과하는 것이다. 그래서 껍데기도 콜라이더로 세운다. */
    ...(map.SHELL || []).map((s) => ({ ...s, kind: 'shell' })),
    ...map.FURNITURE.map((f) => ({ ...f, kind: 'prop' })),
    ...map.PROPS.map((p) => ({
      x: p.x, z: p.z, y: p.yOff || 0, ...p.col, ry: p.ry || 0, kind: 'prop',
      // 통(cylinder)이냐 상자냐. 맵 파일이 MODELS 의 placeholder 모양에서
      // 뽑아 넣는다 - 서버랙을 원통으로 막으면 모서리로 총알이 샌다.
      shape: p.shape || 'box',
    })),
  ];

  map.AREAS = [
    ...map.OUTDOOR_AREAS,
    ...map.ROOMS.map((r) => ({ ...r, outdoor: false })),
    ...map.CORRIDORS.map((r) => ({ ...r, outdoor: false })),
  ];

  /** 좌표가 속한 구역 이름. 실내 우선. */
  map.zoneAt = (x, z) => {
    for (const a of map.AREAS) {
      if (Math.abs(x - a.x) <= a.w / 2 && Math.abs(z - a.z) <= a.d / 2) return a.name;
    }
    return map.defaultZone;
  };
  map.isIndoors = (x, z) => {
    const i = map.MAP.interior;
    return x > i.minX && x < i.maxX && z > i.minZ && z < i.maxZ;
  };

  /* 엄폐 지점은 resolveCircle 을 쓰는데, 그 기본 콜라이더는 "지금 켜져 있는 맵"
   * 이다. 아직 아무 맵도 안 켠 첫 호출에서 저택 콜라이더로 계산해 버리지 않도록
   * 이 맵을 잠깐 켜 두고 센다. 어차피 map-data.js 가 곧 제대로 켠다. */
  useGeometry(map);
  map.COVER_POINTS = buildCoverPoints(
    map.COLLIDERS, map.MAP.width / 2, map.MAP.depth / 2, map.zoneAt);

  map.BOT_SPAWNS = map.POSTS.map((p) => ({ x: p.x, z: p.z }));
  map.PATROL_NODES = map.POSTS.map((p) => ({ x: p.x, z: p.z }));
  map.nav = createNav(map);
  return map;
}
