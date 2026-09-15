/* =============================================================================
 *  reload-motion.js  -  1인칭 재장전 동작 (three 없이 숫자만 낸다)
 *
 *  탄이 떨어지면 화면에는 "재장전…" 이라는 글씨만 뜨고 총은 가만히 있었다.
 *  2~3초 동안 아무 일도 일어나지 않으니, 장전이 끝났는지 안 끝났는지를 숫자를
 *  읽어서 알아야 했다. 손에서 벌어지는 일이 보여야 한다.
 *
 *  audio.js 의 reload() 가 찍는 네 박자에 동작을 맞춘다.
 *    0.00~0.16  탄창 해제 걸쇠 - 총을 안쪽으로 눕히며 내린다
 *    0.16~0.52  빈 탄창 낙하   - 가장 낮은 자리에서 총구가 살짝 들린다
 *    0.52~0.80  새 탄창 삽입   - 올라오면서 삽입 순간에 한 번 쿵
 *    0.80~1.00  노리쇠 전진    - 짧게 뒤로 채였다가 제자리
 *
 *  좌표는 뷰모델 로컬 기준이다(총은 +X 를 향하고, 카메라 -Z 가 앞).
 *  x = 총열 방향, y = 위, z = 오른쪽.
 * ========================================================================== */

/** 구간 [a, b] 안에서의 0~1 진행도. */
const span = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
/** 0 에서 1 로 갔다가 0 으로 돌아오는 부드러운 혹. */
const bump = (u) => Math.sin(Math.min(1, Math.max(0, u)) * Math.PI);
const ease = (u) => u * u * (3 - 2 * u);

export const RELOAD_BEATS = { release: 0.16, drop: 0.52, insert: 0.80, charge: 1 };

/**
 * 재장전 진행도 t(0~1) 에서의 뷰모델 보정값.
 *
 * @returns {{pos:[number,number,number], rot:[number,number,number]}}
 *          기본 자세에 더할 위치(m)와 회전(rad).
 */
export function reloadPose(t) {
  if (!(t > 0) || t >= 1) return { pos: [0, 0, 0], rot: [0, 0, 0] };

  const B = RELOAD_BEATS;
  // 총을 내리는 정도. 걸쇠에서 빠르게 내려가고, 삽입이 끝나면 올라온다.
  const down = t < B.insert
    ? ease(span(t, 0, B.release))
    : 1 - ease(span(t, B.insert, 1));

  // 탄창을 갈아 끼우려면 총을 몸쪽으로 눕혀 탄창구를 본다.
  const tilt = down;
  // 빈 탄창이 떨어지는 동안 총구가 살짝 들린다.
  const muzzleUp = bump(span(t, B.release, B.drop)) * 0.5;
  // 새 탄창이 들어가 걸리는 순간의 반동 한 번.
  const seat = bump(span(t, B.insert - 0.10, B.insert + 0.04));
  // 노리쇠 전진 - 총이 짧고 날카롭게 뒤로 채인다.
  const charge = bump(span(t, B.insert + 0.02, 1)) ** 2;

  return {
    pos: [
      -0.055 * charge,                        // 노리쇠를 당긴 만큼 뒤로
      -0.13 * down - 0.02 * seat,             // 아래로 내림 + 삽입 충격
      0.05 * down,                            // 몸쪽(오른쪽)으로 당김
    ],
    rot: [
      0.34 * tilt,                            // 탄창구가 보이도록 눕힘
      0.10 * down,
      -0.42 * tilt + 0.26 * muzzleUp - 0.10 * charge,
    ],
  };
}
