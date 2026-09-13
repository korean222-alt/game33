/* =============================================================================
 *  entities.js  -  팀원 / 적 봇 캐릭터
 *
 *  캐릭터 모델(PSX SWAT)은 "스킨" 이 아니라 뼈대에 부품이 통째로 매달린 구조다.
 *  (head_02 뼈 밑에 머리 메시, left_arm_03 밑에 팔 메시 …)
 *  덕분에 뼈 각도만 돌려주면 애니메이션이 된다 - 스키닝 비용 0, 모바일에 최고.
 *
 *  원본에 애니메이션 클립이 없으므로 걷기/조준/사망을 전부 코드로 만든다.
 *
 *  뼈 이름 (build-assets.mjs 가 보존해준 것)
 *    hips_00 - spine_01 - head_02
 *             ├ left_arm_03  - left_forearm_04  - left_wrist_05
 *             └ right_arm_06 - right_forearm_07 - right_wrist_08
 *    hips_00  ├ left_leg_09  - left_knee_010  - left_foot_011
 *             └ right_leg_012 - right_knee_013 - right_foot_014
 *
 *  ※ 다른 캐릭터 GLB 로 바꿨는데 팔다리가 안 움직이면,
 *    아래 BONES 의 이름만 새 모델의 뼈 이름으로 바꿔주면 된다.
 * ========================================================================== */

import * as THREE from 'three';
import { PLAYER } from './config.js';

const BONES = {
  hips:   'hips_00',
  spine:  'spine_01',
  head:   'head_02',
  armL:   'left_arm_03',
  foreL:  'left_forearm_04',
  wristL: 'left_wrist_05',
  armR:   'right_arm_06',
  foreR:  'right_forearm_07',
  wristR: 'right_wrist_08',
  legL:   'left_leg_09',
  kneeL:  'left_knee_010',
  footL:  'left_foot_011',
  legR:   'right_leg_012',
  kneeR:  'right_knee_013',
  footR:  'right_foot_014',
};

/* 팀원 구분 색 (슬롯 순서) */
const TEAM_COLORS = [0x5b8fd6, 0x4fd1a1, 0xd6b45b, 0xc06fd6];
const ENEMY_COLOR = 0x8c4038;

/* ========================================================================== *
 *  캐릭터 1명
 * ========================================================================== */
export class Character {
  /**
   * @param {import('./assets.js').AssetManager} assets
   * @param {object} opt  { enemy, color, name, weapon }
   */
  constructor(assets, opt = {}) {
    this.assets = assets;
    this.enemy = !!opt.enemy;

    this.group = new THREE.Group();
    // 레이캐스트가 "사람에 맞았는지" 를 부모를 타고 올라가며 확인한다
    this.group.userData.isCharacterRoot = true;
    this.group.userData.character = this;
    this.model = assets.instance('character', { skinned: true });
    this.group.add(this.model);

    /* --- 뼈 찾아두기 --- */
    this.bones = {};
    this.rest = {};                 // 원래 각도 (여기에 더해서 애니메이션한다)
    const byName = new Map();
    this.model.traverse((o) => byName.set(o.name, o));
    for (const [key, boneName] of Object.entries(BONES)) {
      const b = byName.get(boneName);
      if (!b) continue;
      this.bones[key] = b;
      this.rest[key] = b.quaternion.clone();
    }
    this.hasRig = !!(this.bones.legL && this.bones.armR);

    /* --- 색 입히기 (원본 텍스처를 살리면서 팀색만 섞는다) --- */
    this._tint(opt.color ?? (this.enemy ? ENEMY_COLOR : TEAM_COLORS[0]));

    /* --- 손에 총 들리기 --- */
    this.weaponKey = opt.weapon || 'rifle';
    this._attachWeapon(this.weaponKey);

    /* --- 이름표 / 체력바 --- */
    this.label = null;
    if (opt.name) this._makeLabel(opt.name, this.enemy);

    /* --- 상태 --- */
    this.alive = true;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.aimAmount = 0;        // 0 = 내린 총, 1 = 겨눔
    this.pitch = 0;
    this.deathT = 0;
    this.lastStepPhase = 0;
    this.onStep = null;        // 발소리 콜백

    /* --- 네트워크 보간용 버퍼 --- */
    this.buffer = [];          // { t, x, z, yaw, moving, sprint, crouch }
    this.renderPos = new THREE.Vector3();
  }

  /* -------------------------------------------------------------------- */
  _tint(color) {
    const c = new THREE.Color(color);
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      // 원본 머티리얼을 공유하면 다른 캐릭터까지 같이 물든다 -> 반드시 복제
      const src = Array.isArray(o.material) ? o.material : [o.material];
      o.material = src.map((m) => {
        const n = m.clone();
        n.color = n.color ? n.color.clone().lerp(c, 0.55) : c.clone();
        n.roughness = Math.min(1, (n.roughness ?? 0.8) + 0.1);
        n.metalness = Math.min(0.3, n.metalness ?? 0);
        return n;
      });
      if (o.material.length === 1) o.material = o.material[0];
      o.castShadow = true;
      o.receiveShadow = true;
    });
  }

  _attachWeapon(key) {
    if (this.weapon) {
      this.weapon.parent?.remove(this.weapon);
      this.weapon = null;
    }
    let gun;
    try { gun = this.assets.instance(key); } catch { return; }

    // 오른손목 뼈에 매단다. 뼈가 없으면 몸통에 대충 붙인다.
    const hand = this.bones.wristR || this.bones.armR || this.model;

    const holder = new THREE.Group();
    holder.add(gun);
    // 손 기준 보정: 총을 손바닥 앞으로 빼고 앞쪽(-Z)을 향하게
    holder.position.set(0.02, 0.16, 0.06);
    holder.rotation.set(-Math.PI / 2, 0, 0);
    holder.scale.setScalar(0.9);

    hand.add(holder);
    this.weapon = holder;
    this.weaponKey = key;

    holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  }

  _makeLabel(name, enemy) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 64);
    g.font = 'bold 30px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(name, 128, 32);
    g.fillStyle = enemy ? '#ff8b86' : '#9fe8c8';
    g.fillText(name, 128, 32);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: true, opacity: 0.95,
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.9, 0.225, 1);
    sp.position.y = PLAYER.height + 0.24;
    sp.raycast = () => {};      // 이름표에 총알이 맞으면 안 된다
    this.group.add(sp);
    this.label = sp;
  }

  /* ======================================================================= *
   *  네트워크 스냅샷 넣기 (보간용)
   * ==================================================================== */
  pushSnapshot(s, serverTime) {
    this.buffer.push({
      t: serverTime,
      x: s.x, z: s.z, yaw: s.yaw, pitch: s.pitch ?? 0,
      moving: s.moving, sprint: s.sprint, crouch: s.crouch,
    });
    // 1초보다 오래된 건 버린다
    while (this.buffer.length > 2 && this.buffer[1].t < serverTime - 1000) this.buffer.shift();
  }

  /**
   * 보간해서 실제로 그릴 위치를 정한다.
   * renderTime = 지금 서버시각 - interpDelayMs  (조금 과거를 보여주면 부드럽다)
   */
  interpolate(renderTime) {
    const buf = this.buffer;
    if (buf.length === 0) return false;
    if (buf.length === 1) {
      this._apply(buf[0]);
      return true;
    }

    // renderTime 을 감싸는 두 스냅샷 찾기
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= renderTime && buf[i + 1].t >= renderTime) {
        a = buf[i]; b = buf[i + 1];
        break;
      }
    }
    const span = b.t - a.t;
    const k = span > 0 ? Math.max(0, Math.min(1, (renderTime - a.t) / span)) : 1;

    this._apply({
      x: a.x + (b.x - a.x) * k,
      z: a.z + (b.z - a.z) * k,
      yaw: a.yaw + shortestAngle(a.yaw, b.yaw) * k,
      pitch: a.pitch + (b.pitch - a.pitch) * k,
      moving: b.moving, sprint: b.sprint, crouch: b.crouch,
    });

    // 오래된 건 정리
    while (buf.length > 3 && buf[1].t < renderTime) buf.shift();
    return true;
  }

  _apply(s) {
    this.group.position.x = s.x;
    this.group.position.z = s.z;
    this.group.rotation.y = s.yaw;
    this.pitch = s.pitch || 0;
    this.moving = !!s.moving;
    this.sprint = !!s.sprint;
    this.crouch = !!s.crouch;
    this.renderPos.set(s.x, 0, s.z);
  }

  /** 봇처럼 서버가 x/z/yaw 만 주는 경우 즉시 세팅 */
  setTransform(x, z, yaw) {
    this.group.position.x = x;
    this.group.position.z = z;
    this.group.rotation.y = yaw;
    this.renderPos.set(x, 0, z);
  }

  /* ======================================================================= *
   *  절차적 애니메이션
   * ==================================================================== */
  update(dt, t) {
    if (!this.hasRig) return;

    if (!this.alive) { this._animateDeath(dt); return; }

    /* --- 걷기 주기 --- */
    const speed = this.sprint ? 1.75 : this.moving ? 1.0 : 0;
    const stride = this.crouch ? 5.2 : this.sprint ? 11.5 : 7.6;
    if (speed > 0) this.walkPhase += dt * stride;

    // 발이 바닥에 닿는 순간에 발소리 콜백
    const stepMark = Math.floor(this.walkPhase / Math.PI);
    if (speed > 0 && stepMark !== this.lastStepPhase) {
      this.lastStepPhase = stepMark;
      this.onStep?.(this.group.position, this.sprint);
    }

    const p = this.walkPhase;
    const amp = speed === 0 ? 0 : (this.crouch ? 0.32 : this.sprint ? 1.0 : 0.68);

    /* --- 다리: 앞뒤로 스윙 + 무릎 접기 --- */
    const swing = Math.sin(p) * 0.62 * amp;
    this._rot('legL',  swing,  0, 0);
    this._rot('legR', -swing,  0, 0);
    // 무릎은 뒤로만 접힌다 (앞으로 꺾이면 괴물이 된다)
    this._rot('kneeL', Math.max(0, -Math.sin(p) * 0.9) * amp, 0, 0);
    this._rot('kneeR', Math.max(0, Math.sin(p) * 0.9) * amp, 0, 0);
    this._rot('footL', Math.sin(p + 0.6) * 0.22 * amp, 0, 0);
    this._rot('footR', Math.sin(p + Math.PI + 0.6) * 0.22 * amp, 0, 0);

    /* --- 몸통: 걸을 때 위아래로 통통 + 좌우 흔들 --- */
    const bobY = Math.abs(Math.sin(p)) * 0.045 * amp;
    const crouchDrop = this.crouch ? 0.42 : 0;
    if (this.bones.hips) {
      this.bones.hips.position.y = this._hipsRestY ?? (this._hipsRestY = this.bones.hips.position.y);
    }
    this.group.position.y = bobY - crouchDrop;

    this._rot('hips', 0, Math.sin(p) * 0.08 * amp, Math.sin(p * 0.5) * 0.05 * amp);
    this._rot('spine', this.crouch ? 0.30 : 0.06, 0, -Math.sin(p) * 0.05 * amp);

    /* --- 머리: 위아래 조준각을 따라간다 --- */
    this._rot('head', -this.pitch * 0.75, 0, 0);

    /* --- 팔: 총을 겨누면 앞으로 든다 --- */
    // 달릴 때는 총을 내린다 (레디오어낫 느낌)
    const wantAim = this.sprint ? 0 : 1;
    this.aimAmount += (wantAim - this.aimAmount) * Math.min(1, dt * 7);
    const A = this.aimAmount;

    // 겨눔 자세: 양팔을 앞으로 (팔 로컬 X 회전이 앞뒤)
    const aimPitch = -this.pitch * 0.8;
    this._rot('armR', -1.35 * A + aimPitch * A + (1 - A) * Math.sin(p) * 0.35 * amp,
                       0.18 * A, -0.22 * A);
    this._rot('foreR', -0.42 * A, 0, 0);
    this._rot('armL', -1.20 * A + aimPitch * A + (1 - A) * -Math.sin(p) * 0.35 * amp,
                      -0.55 * A, 0.30 * A);
    this._rot('foreL', -0.95 * A, 0, 0);

    // 이름표는 항상 카메라를 보게 (Sprite 라 자동)
  }

  _animateDeath(dt) {
    this.deathT = Math.min(1, this.deathT + dt * 2.4);
    const k = easeOutCubic(this.deathT);
    // 앞으로 고꾸라진다
    this.group.rotation.x = -k * (Math.PI / 2) * 0.92;
    this.group.position.y = -k * 0.28;
    this._rot('spine', 0.5 * k, 0, 0.3 * k);
    this._rot('armR', 0.9 * k, 0, -0.5 * k);
    this._rot('armL', 0.9 * k, 0, 0.5 * k);
    this._rot('legL', 0.3 * k, 0, 0);
    this._rot('legR', -0.2 * k, 0, 0);
    if (this.label) this.label.material.opacity = 0.92 * (1 - k);
  }

  /** rest 자세에 오일러 각을 더해서 적용 */
  _rot(key, x, y, z) {
    const b = this.bones[key];
    if (!b) return;
    _q.setFromEuler(_e.set(x, y, z));
    b.quaternion.copy(this.rest[key]).multiply(_q);
  }

  /* -------------------------------------------------------------------- */
  die() {
    if (!this.alive) return;
    this.alive = false;
    this.deathT = 0;
  }

  revive() {
    this.alive = true;
    this.deathT = 0;
    this.group.rotation.x = 0;
    this.group.position.y = 0;
    if (this.label) this.label.material.opacity = 0.92;
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { m?.map?.dispose?.(); m?.dispose?.(); }
      }
    });
    this.group.parent?.remove(this.group);
  }
}

/* ========================================================================== *
 *  캐릭터 무리 관리 (팀원 + 봇)
 * ========================================================================== */
export class EntityManager {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.players = new Map();   // id -> Character
    this.bots = new Map();      // id -> Character
    this.onStep = null;
  }

  addPlayer(info) {
    if (this.players.has(info.id)) return this.players.get(info.id);
    const ch = new Character(this.assets, {
      enemy: false,
      color: TEAM_COLORS[(info.slot ?? 0) % TEAM_COLORS.length],
      name: info.name,
      weapon: info.weapon,
    });
    ch.onStep = (pos, run) => this.onStep?.(pos, run);
    this.scene.add(ch.group);
    this.players.set(info.id, ch);
    return ch;
  }

  addBot(info) {
    if (this.bots.has(info.id)) return this.bots.get(info.id);
    const ch = new Character(this.assets, {
      enemy: true,
      color: ENEMY_COLOR,
      weapon: 'rifle',
    });
    ch.onStep = (pos, run) => this.onStep?.(pos, run);
    this.scene.add(ch.group);
    this.bots.set(info.id, ch);
    return ch;
  }

  removePlayer(id) {
    const ch = this.players.get(id);
    if (ch) { ch.dispose(); this.players.delete(id); }
  }

  /** 서버 스냅샷 반영 */
  applySnapshot(snap, myId, serverTime) {
    for (const p of snap.players) {
      if (p.id === myId) continue;
      const ch = this.players.get(p.id);
      if (!ch) continue;
      ch.pushSnapshot(p, serverTime);
      if (!p.alive && ch.alive) ch.die();
      if (p.alive && !ch.alive) ch.revive();
    }

    for (const b of snap.bots) {
      let ch = this.bots.get(b.id);
      if (!ch) ch = this.addBot(b);
      ch.pushSnapshot({ ...b, pitch: 0 }, serverTime);
      if (!b.alive && ch.alive) ch.die();
      if (b.alive && !ch.alive) ch.revive();
      ch.hp = b.hp;
    }
  }

  /** 매 프레임 */
  update(dt, t, renderTime) {
    for (const ch of this.players.values()) {
      ch.interpolate(renderTime);
      ch.update(dt, t);
    }
    for (const ch of this.bots.values()) {
      ch.interpolate(renderTime);
      ch.update(dt, t);
    }
  }

  /** 가장 가까운 살아있는 봇 (조준 보조/디버그용) */
  nearestBot(x, z) {
    let best = null, bd = Infinity;
    for (const ch of this.bots.values()) {
      if (!ch.alive) continue;
      const d = Math.hypot(ch.group.position.x - x, ch.group.position.z - z);
      if (d < bd) { bd = d; best = ch; }
    }
    return best;
  }

  clear() {
    for (const ch of this.players.values()) ch.dispose();
    for (const ch of this.bots.values()) ch.dispose();
    this.players.clear();
    this.bots.clear();
  }
}

/* ========================================================================== *
 *  헬퍼
 * ========================================================================== */
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** a 에서 b 로 가는 가장 짧은 각도 차 (-PI ~ PI) */
export function shortestAngle(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

export { TEAM_COLORS };
