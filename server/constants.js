/* =============================================================================
 *  server/constants.js  -  숫자만 모아 둔 곳
 *
 *  값을 만지러 오는 사람이 제일 먼저 여는 파일. 로직은 한 줄도 없다.
 * ========================================================================== */
import { LIGHTS } from '../public/js/map-data.js';

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;

export const PLAYER_RADIUS = 0.32;
export const PLAYER_MAX_HP = 100;
export const PLAYER_EYE = 1.62;

export const SUSPECT_MAX_HP = 100;
export const SUSPECT_DAMAGE = 13;

export const MISSION_TIME_MS = 22 * 60 * 1000;
export const DEFUSE_SECONDS = 8;
export const DEFUSE_RANGE = 1.8;
export const INTERACT_RANGE = 2.0;
export const ARREST_SECONDS = 2.2;
export const SECURE_SECONDS = 1.6;
export const REVIVE_SECONDS = 4.0;
export const EVIDENCE_SECONDS = 1.4;
export const BLEED_OUT_MS = 75000;
export const SHOUT_COOLDOWN = 1600;
/* 소켓이 끊겨도 자리를 비워 두는 시간.
 *
 *  와이파이 순단이나 Render 무료 인스턴스의 슬립은 몇 초에서 1분까지 간다.
 *  끊기자마자 지워 버리면 22분짜리 작전에서 1초 만에 영구 퇴장이 된다.
 *  90초는 그 둘을 다 덮으면서, 살아 있는 팀에게 "돌아오나" 를 마냥 기다리게
 *  하지는 않는 길이다.
 *
 *  테스트는 90초를 기다릴 수 없으므로 환경변수로 줄일 수 있게 둔다. */
export const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) > 0
  ? Number(process.env.RECONNECT_GRACE_MS)
  : 90000;
export const REINFORCE_DELAY_MS = 14000;
export const REINFORCE_COUNT = 3;

export const WEAPONS = {
  rifle: { name: 'M416', mag: 30, reserve: 150, rpm: 700, damage: 26, headMul: 2.2, range: 60, reload: 2.3 },
  smg: { name: 'UMP9', mag: 25, reserve: 150, rpm: 600, damage: 21, headMul: 2.0, range: 40, reload: 2.0 },
  sniper: { name: 'AWM', mag: 5, reserve: 30, rpm: 45, damage: 95, headMul: 1.5, range: 80, reload: 3.2 },
};

export const DIFFICULTY = {
  easy: { hpMul: 0.75, dmgMul: 0.7, skill: 0.78, reactMul: 1.45, moraleMul: 1.25 },
  normal: { hpMul: 1.0, dmgMul: 1.0, skill: 1.0, reactMul: 1.0, moraleMul: 1.0 },
  hard: { hpMul: 1.25, dmgMul: 1.25, skill: 1.22, reactMul: 0.78, moraleMul: 0.8 },
};

export const OUTDOOR_ZONES = ['COURTYARD', 'WEST YARD', 'EAST YARD', 'GARDEN'];
/* 담장 밖 배선으로 도는 야외등. 저택이 정전돼도 이것만은 남는다. */
export const OUTDOOR_LIGHTS = LIGHTS.filter((L) => L.kind === 'lamp');
