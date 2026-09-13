/* =============================================================================
 *  config.js  -  여기만 고치면 되는 설정 파일
 *
 *  ★ GLB 모델을 바꾸고 싶으면 아래 MODELS 의 url 만 바꾸면 된다.
 *    파일은 전부  public/assets/models/  안에 넣는다.
 *    파일이 없거나 로딩에 실패하면 자동으로 박스/원기둥 placeholder 로 대체된다.
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 *  1. 3D 모델 경로
 *
 *  url        : GLB/GLTF 경로
 *  scale      : 불러온 뒤 곱할 배율 (모델이 너무 크거나 작을 때 조절)
 *  rotY       : Y축 회전 보정 (모델이 엉뚱한 방향을 보고 있을 때)
 *  placeholder: 파일이 없을 때 대신 그릴 기본 도형
 * -------------------------------------------------------------------------- */
export const MODELS = {
  // --- 맵 소품 ---
  stallTarp:  { url: '/assets/models/stall-tarp.glb',  scale: 1, rotY: 0,
                placeholder: { type: 'stall', w: 2.83, h: 1.84, d: 2.23, color: 0x6b5c45 } },
  stallWood:  { url: '/assets/models/stall-wood.glb',  scale: 1, rotY: 0,
                placeholder: { type: 'stall', w: 5.13, h: 2.73, d: 2.86, color: 0x7a6647 } },
  crate:      { url: '/assets/models/crate.glb',       scale: 1, rotY: 0,
                placeholder: { type: 'box', w: 0.75, h: 0.75, d: 0.75, color: 0x8a6b3f } },
  barrel:     { url: '/assets/models/barrel.glb',      scale: 1, rotY: 0,
                placeholder: { type: 'cylinder', r: 0.44, h: 0.99, color: 0x5a4630 } },
  vase:       { url: '/assets/models/vase.glb',        scale: 1, rotY: 0,
                placeholder: { type: 'cylinder', r: 0.5, h: 1.53, color: 0x6d5a48 } },
  well:       { url: '/assets/models/well.glb',        scale: 1, rotY: 0,
                placeholder: { type: 'cylinder', r: 1.05, h: 2.35, color: 0x555049 } },

  // --- 캐릭터 (팀원 + 적 봇이 같은 모델을 쓰고 색만 바꾼다) ---
  character:  { url: '/assets/models/character.glb',   scale: 1, rotY: 0,
                placeholder: { type: 'humanoid', h: 1.8, color: 0x7f8a74 } },

  // --- 총기 (1인칭 뷰모델 + 다른 플레이어 손에 들리는 모델) ---
  rifle:      { url: '/assets/models/weapon-rifle.glb',  scale: 1, rotY: 0,
                placeholder: { type: 'gun', len: 0.9, color: 0x2b2b2e } },
  smg:        { url: '/assets/models/weapon-smg.glb',    scale: 1, rotY: 0,
                placeholder: { type: 'gun', len: 0.65, color: 0x2b2b2e } },
  sniper:     { url: '/assets/models/weapon-sniper.glb', scale: 1, rotY: 0,
                placeholder: { type: 'gun', len: 1.2, color: 0x2b2b2e } },
};

/* -----------------------------------------------------------------------------
 *  2. 1인칭 총 위치 (★ 총이 이상하게 보이면 여기를 만진다)
 *
 *  게임 안에서 키보드 V (PC) 를 누르면 슬라이더가 나와서 실시간으로 맞출 수 있고,
 *  "값 복사" 버튼을 누르면 아래에 그대로 붙여넣을 수 있는 숫자가 복사된다.
 *
 *  pos      : 카메라 기준 위치 [오른쪽, 위, 앞(-가 앞)]
 *  rot      : 회전 [X, Y, Z] (라디안)
 *  scale    : 크기
 *  adsPos   : 정조준(ADS) 했을 때 위치 - 보통 화면 중앙으로 당긴다
 * -------------------------------------------------------------------------- */
export const VIEWMODEL = {
  rifle:  { pos: [0.22, -0.20, -0.42], rot: [0, Math.PI / 2, 0], scale: 1.0,
            adsPos: [0.0, -0.115, -0.30], adsRot: [0, Math.PI / 2, 0] },
  smg:    { pos: [0.20, -0.18, -0.38], rot: [0, Math.PI / 2, 0], scale: 1.0,
            adsPos: [0.0, -0.105, -0.28], adsRot: [0, Math.PI / 2, 0] },
  sniper: { pos: [0.24, -0.20, -0.50], rot: [0, Math.PI / 2, 0], scale: 1.0,
            adsPos: [0.0, -0.10,  -0.34], adsRot: [0, Math.PI / 2, 0] },
};
/*  총이 뒤를 보고 있으면 rot 의 Y 값을 -Math.PI/2 로 바꾸고,
 *  총이 뒤집혀 있으면 rot 의 Z 값에 Math.PI 를 넣으면 된다.            */

/* -----------------------------------------------------------------------------
 *  3. 그래픽 품질 프리셋
 *
 *  아이폰 13 Pro 기준 기본값은 'high'.
 *  프레임이 45 아래로 3초 이상 유지되면 자동으로 한 단계 내려간다(autoScale).
 * -------------------------------------------------------------------------- */
export const QUALITY = {
  low: {
    label: '낮음',
    pixelRatio: 1.0,
    shadows: false,
    shadowMapSize: 512,
    drawDistance: 24,
    fogDensity: 0.070,
    anisotropy: 1,
    pointLights: 3,        // 천장 전구를 몇 개까지 켤지
    antialias: false,
    shadowRadius: 1,
  },
  medium: {
    label: '보통',
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    drawDistance: 32,
    fogDensity: 0.050,
    anisotropy: 2,
    pointLights: 5,
    antialias: false,
    shadowRadius: 2,
  },
  high: {
    label: '높음 (iPhone 13 Pro 기본)',
    pixelRatio: 1.5,       // 13 Pro 의 DPR 은 3 이지만 1.5 면 충분히 선명하고 2배 빠르다
    shadows: true,
    shadowMapSize: 2048,
    drawDistance: 45,
    fogDensity: 0.038,
    anisotropy: 4,
    pointLights: 8,
    antialias: false,      // 모바일에서는 MSAA 대신 해상도 스케일이 더 효율적
    shadowRadius: 3,
  },
  ultra: {
    label: '최고 (PC 전용)',
    pixelRatio: 2.0,
    shadows: true,
    shadowMapSize: 4096,
    drawDistance: 70,
    fogDensity: 0.028,
    anisotropy: 8,
    pointLights: 8,
    antialias: true,
    shadowRadius: 4,
  },
};

export const SETTINGS_DEFAULT = {
  quality: 'high',
  autoScale: true,        // FPS 보고 자동으로 품질 낮추기
  sensitivity: 1.0,       // 터치 시점 감도
  fov: 74,                // 좁은 실내 긴장감을 위해 살짝 좁게
  adsFov: 46,
  invertY: false,
  showFps: false,
  leftHanded: false,      // 조이스틱/발사 버튼 좌우 반전
};

/* -----------------------------------------------------------------------------
 *  4. 플레이어 물리 / 전투
 * -------------------------------------------------------------------------- */
export const PLAYER = {
  radius: 0.35,
  height: 1.8,
  eyeHeight: 1.62,
  crouchEye: 1.17,
  walkSpeed: 2.5,         // 리얼리즘 - 기본은 느리게
  sprintSpeed: 4.3,
  crouchSpeed: 1.35,
  adsSpeedMul: 0.55,
  accel: 14,              // 가속 (관성 느낌)
  friction: 11,
  jumpSpeed: 5.4,
  gravity: -18,
  bobAmount: 0.028,
  bobSpeed: 9.5,
};

export const COMBAT = {
  // 무기별 스펙은 서버(WEAPONS)와 맞춰져 있다. 여기 값은 연출용.
  spread: {
    idle: 0.004,          // 라디안
    move: 0.017,
    sprint: 0.05,
    crouch: 0.0022,
    ads: 0.0012,
    perShot: 0.006,       // 연사할수록 누적
    recover: 0.05,        // 초당 회복
    max: 0.075,
  },
  recoil: {
    vertical: 0.016,      // 라디안/발
    horizontal: 0.006,
    recover: 7.5,
  },
  tracerSpeed: 220,
  muzzleFlashMs: 45,
};

export const NET = {
  inputHz: 20,            // 서버로 내 위치를 보내는 빈도
  interpDelayMs: 110,     // 남의 캐릭터를 얼마나 늦게 보여줄지 (부드러움 vs 지연)
};

/* -----------------------------------------------------------------------------
 *  5. 저장/불러오기
 * -------------------------------------------------------------------------- */
const LS_KEY = 'market-raid-settings';

export function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...SETTINGS_DEFAULT };
    return { ...SETTINGS_DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { ...SETTINGS_DEFAULT };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* 사파리 프라이빗 모드 */ }
}

/** 기기 보고 기본 품질 추천 */
export function guessQuality() {
  const ua = navigator.userAgent;
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  if (!isMobile) return 'ultra';
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  if (mem <= 3 || cores <= 4) return 'medium';
  return 'high';
}
