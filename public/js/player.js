/* =============================================================================
 *  player.js  -  내 캐릭터 (이동 예측 / 카메라 / 총 뷰모델 / 반동)
 *
 *  이동은 클라이언트가 먼저 계산하고(예측), 서버는 map-data 의 같은 충돌 함수로
 *  한 번 더 보정한다. 둘 다 resolveCircle 을 쓰므로 결과가 거의 같아서
 *  되돌아가는(rubber-band) 현상이 잘 생기지 않는다.
 * ========================================================================== */

import * as THREE from 'three';
import { PLAYER, COMBAT, VIEWMODEL } from './config.js';
import { moveBody, COLLIDERS, overlaps } from './map-data.js';

export class LocalPlayer {
  constructor(camera, scene, assets, settings) {
    this.camera = camera;
    this.scene = scene;
    this.assets = assets;
    this.settings = settings;

    this.pos = new THREE.Vector3(0, 0, 4.6);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;

    this.alive = true;
    this.crouching = false;
    this.sprinting = false;
    this.adsAmount = 0;      // 0=허리, 1=정조준
    this.moving = false;

    this.spread = COMBAT.spread.idle;
    this.recoil = { x: 0, y: 0 };
    this.bobPhase = 0;
    this._sent = [];         // 서버로 보낸 최근 위치들 (reconcile 판단용)

    this.weapon = 'rifle';
    this.viewmodel = null;
    this._vmGroup = new THREE.Group();
    this.camera.add(this._vmGroup);
    this.muzzleUntil = 0;

    this.camera.rotation.order = 'YXZ';
  }

  /* ---- 스폰 / 무기 ------------------------------------------------------ */
  spawn(x, z, yaw) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw || 0;
    this.pitch = 0;
    this.alive = true;
    this.onGround = true;
    this.crouching = false;
    this.recoil.x = this.recoil.y = 0;
    this.sprinting = this.moving = false;
    this.adsAmount = this.bobPhase = this._sprintK = 0;
    this._eye = PLAYER.eyeHeight;
    this.muzzleUntil = 0;
    this.spread = COMBAT.spread.idle;
    this._sent.length = 0;
  }

  setWeapon(key) {
    this.weapon = key;
    // 이전 뷰모델 정리
    while (this._vmGroup.children.length) this._vmGroup.remove(this._vmGroup.children[0]);
    try {
      this.viewmodel = this.assets.instance(key);
    } catch {
      this.viewmodel = null;
      return;
    }
    // 1인칭 총은 벽에 파묻히면 안 되므로 항상 맨 위에 그린다
    this.viewmodel.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.layers.set(1);
    });
    this._vmGroup.add(this.viewmodel);

    this.muzzle = new THREE.PointLight(0xffd08a, 0, 3.5, 2);
    this.muzzle.layers.enable(1);
    this._vmGroup.add(this.muzzle);
  }

  /* ---- 시점 ------------------------------------------------------------- */
  look(dx, dy) {
    this.yaw -= dx;
    this.pitch -= dy;
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    // yaw 는 -PI~PI 로 감아둔다 (서버로 보낼 때 값이 무한정 커지지 않게)
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /* ---- 이동 ------------------------------------------------------------- */
  update(dt, input) {
    if (!this.alive) { this._applyCamera(dt); return; }

    const wantSprint = input.sprint && input.move.y > 0.3 && !input.ads && !input.crouch;
    // Do not stand up into a table/shelf after entering a low opening.
    this.crouching = !!input.crouch || (this.crouching && COLLIDERS.some(c =>
      (c.y || 0) > this.pos.y && (c.y || 0) < this.pos.y + PLAYER.height &&
      overlaps(this.pos.x, this.pos.z, PLAYER.radius, c)));
    this.sprinting = wantSprint;

    // 목표 속도 (yaw 기준 전/후/좌/우)
    let speed = PLAYER.walkSpeed;
    if (this.crouching) speed = PLAYER.crouchSpeed;
    else if (wantSprint) speed = PLAYER.sprintSpeed;
    if (input.ads) speed *= PLAYER.adsSpeedMul;

    // yaw=0 은 -Z 를 본다 (서버 map-data 규약과 동일)
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const rgtX = Math.cos(this.yaw),  rgtZ = -Math.sin(this.yaw);

    const wishX = fwdX * input.move.y + rgtX * input.move.x;
    const wishZ = fwdZ * input.move.y + rgtZ * input.move.x;
    const wishLen = Math.hypot(wishX, wishZ);
    const targetX = wishX / Math.max(1, wishLen) * speed;
    const targetZ = wishZ / Math.max(1, wishLen) * speed;

    // 가속 / 마찰 (관성)
    const rate = wishLen > 0 ? PLAYER.accel : PLAYER.friction;
    const k = 1 - Math.exp(-rate * dt);
    this.vel.x += (targetX - this.vel.x) * k;
    this.vel.z += (targetZ - this.vel.z) * k;

    this.moving = Math.hypot(this.vel.x, this.vel.z) > 0.35;

    // 점프 / 중력
    if (input.consumeJump() && this.onGround && !this.crouching) {
      this.vel.y = PLAYER.jumpSpeed;
      this.onGround = false;
    }
    const body = moveBody(this.pos, this.vel, Math.min(dt, .1), {
      radius: PLAYER.radius, height: this.crouching ? 1.3 : PLAYER.height,
      grounded: this.onGround, gravity: PLAYER.gravity,
    });
    this.pos.set(body.pos.x, body.pos.y, body.pos.z);
    this.vel.set(body.vel.x, body.vel.y, body.vel.z);
    this.onGround = body.onGround;

    // 조준 상태 보간
    const adsTarget = input.ads ? 1 : 0;
    this.adsAmount += (adsTarget - this.adsAmount) * (1 - Math.exp(-14 * dt));

    this._updateSpread(dt, input);
    this._updateRecoil(dt);
    this._applyCamera(dt);
    this._applyViewmodel(dt);
  }

  /* ---- 탄퍼짐 ----------------------------------------------------------- */
  _updateSpread(dt, input) {
    const S = COMBAT.spread;
    let base = S.idle;
    if (this.sprinting) base = S.sprint;
    else if (this.moving) base = S.move;
    else if (this.crouching) base = S.crouch;
    if (this.adsAmount > 0.6) base = Math.min(base, S.ads);

    // 쏘면 늘고, 안 쏘면 서서히 회복
    this.spread = Math.max(base, this.spread - S.recover * dt);
    this.spread = Math.min(this.spread, S.max);
  }

  addShotSpread() {
    this.spread = Math.min(COMBAT.spread.max, this.spread + COMBAT.spread.perShot);
  }

  /* ---- 반동 ------------------------------------------------------------- */
  kick() {
    const R = COMBAT.recoil;
    this.recoil.y += R.vertical * (0.8 + Math.random() * 0.4);
    this.recoil.x += (Math.random() - 0.5) * 2 * R.horizontal;
    this.muzzleUntil = performance.now() + COMBAT.muzzleFlashMs;
  }

  _updateRecoil(dt) {
    const k = 1 - Math.exp(-COMBAT.recoil.recover * dt);
    this.recoil.x -= this.recoil.x * k;
    this.recoil.y -= this.recoil.y * k;
  }

  /* ---- 카메라 ----------------------------------------------------------- */
  _applyCamera(dt) {
    const eyeTarget = this.crouching ? PLAYER.crouchEye : PLAYER.eyeHeight;
    this._eye = this._eye ?? eyeTarget;
    this._eye += (eyeTarget - this._eye) * (1 - Math.exp(-12 * dt));

    // 걸을 때 위아래 흔들림 (조준 중엔 거의 없앤다)
    let bobY = 0, bobX = 0;
    if (this.moving && this.onGround) {
      this.bobPhase += dt * PLAYER.bobSpeed * (this.sprinting ? 1.35 : 1);
      const amt = PLAYER.bobAmount * (this.sprinting ? 1.5 : 1) * (1 - this.adsAmount * 0.85);
      bobY = Math.sin(this.bobPhase * 2) * amt;
      bobX = Math.cos(this.bobPhase) * amt * 0.6;
    }

    this.camera.position.set(this.pos.x + bobX, this.pos.y + this._eye + bobY, this.pos.z);
    this.camera.rotation.y = this.yaw + this.recoil.x;
    this.camera.rotation.x = this.pitch + this.recoil.y;

    // 조준하면 화각을 좁혀 확대 효과
    const fov = lerp(this.settings.fov, this.settings.adsFov, this.adsAmount);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /* ---- 1인칭 총 --------------------------------------------------------- */
  _applyViewmodel(dt) {
    if (!this.viewmodel) return;
    const vm = VIEWMODEL[this.weapon] || VIEWMODEL.rifle;

    const p = vm.pos, ap = vm.adsPos || p;
    const r = vm.rot, ar = vm.adsRot || r;
    const a = this.adsAmount;

    // 달릴 때는 총을 내린다
    const sprintDrop = this.sprinting ? 1 : 0;
    this._sprintK = this._sprintK ?? 0;
    this._sprintK += (sprintDrop - this._sprintK) * (1 - Math.exp(-10 * dt));

    const sway = this.moving ? Math.sin(this.bobPhase) * 0.008 * (1 - a) : 0;

    this.viewmodel.position.set(
      lerp(p[0], ap[0], a) + sway,
      lerp(p[1], ap[1], a) - this._sprintK * 0.10 + Math.sin(this.bobPhase * 2) * 0.004 * (1 - a),
      lerp(p[2], ap[2], a),
    );
    this.viewmodel.rotation.set(
      lerp(r[0], ar[0], a) + this._sprintK * 0.35,
      lerp(r[1], ar[1], a),
      lerp(r[2], ar[2], a) + this._sprintK * 0.30,
    );
    const sc = vm.scale ?? 1;
    this.viewmodel.scale.setScalar(sc);

    if (this.muzzle) {
      const on = performance.now() < this.muzzleUntil;
      this.muzzle.intensity = on ? 9 : 0;
      this.muzzle.position.set(0.1, -0.05, -0.7);
    }
  }

  /* ---- 사격 방향 (탄퍼짐 적용) ------------------------------------------ */
  aimDirection() {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const s = this.spread;
    if (s > 0) {
      // 카메라 기준 직교축으로 흩뿌린다
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * s;
      dir.addScaledVector(right, Math.cos(ang) * rad);
      dir.addScaledVector(up, Math.sin(ang) * rad);
      dir.normalize();
    }
    return dir;
  }

  /** 총구 위치 (예광탄 시작점) */
  muzzlePosition() {
    const eye = this.pos.y + (this._eye ?? PLAYER.eyeHeight);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    return {
      x: this.pos.x + fwd.x * 0.45 + right.x * 0.12,
      y: eye - 0.1 + fwd.y * 0.45,
      z: this.pos.z + fwd.z * 0.45 + right.z * 0.12,
    };
  }

  /** 서버로 보낼 입력 상태 */
  netState() {
    // 보낸 위치를 기억해 둔다. 서버 스냅샷이 이 중 하나와 일치하면
    // "서버가 내 예측을 그대로 받아들였다"는 뜻이라 보정할 필요가 없다.
    this._sent.push({ x: this.pos.x, z: this.pos.z });
    if (this._sent.length > SENT_HISTORY) this._sent.shift();

    return {
      x: +this.pos.x.toFixed(3),
      y: +this.pos.y.toFixed(3),
      z: +this.pos.z.toFixed(3),
      yaw: +this.yaw.toFixed(3),
      pitch: +this.pitch.toFixed(3),
      moving: this.moving ? 1 : 0,
      sprint: this.sprinting ? 1 : 0,
      crouch: this.crouching ? 1 : 0,
    };
  }

  /**
   * 서버가 보정한 위치를 반영.
   *
   * 주의: 스냅샷(20Hz)은 렌더 프레임보다 훨씬 자주 올 수 있다. 그때 "현재 예측 위치"와
   * 서버 위치를 비교해 매번 끌어당기면, 아직 서버에 닿지 않은 내 최신 이동이 계속
   * 지워져서 제자리걸음이 된다. 그래서 최근에 "보낸" 위치들과 먼저 대조한다.
   */
  reconcile(sx, sz) {
    // 서버 위치가 내가 보낸 위치 중 하나와 같다면 서버는 내 예측을 그대로 받았다.
    // 지금 내가 그보다 앞서 있는 건 정상(서버가 아직 못 받은 이동)이므로 건드리지 않는다.
    for (const p of this._sent) {
      if (Math.hypot(sx - p.x, sz - p.z) < 0.12) return;
    }

    // 여기까지 왔으면 서버가 실제로 다른 위치로 보정한 것 (벽 뚫기 방지 등)
    const d = Math.hypot(sx - this.pos.x, sz - this.pos.z);
    if (d > 1.2) {          // 순간이동 수준으로 어긋남 -> 즉시 맞춘다
      this.pos.x = sx; this.pos.z = sz;
      this.vel.x = this.vel.z = 0;
      this._sent.length = 0;
    } else if (d > 0.18) {  // 살짝 어긋남 -> 티 안 나게 끌어당긴다
      this.pos.x += (sx - this.pos.x) * 0.18;
      this.pos.z += (sz - this.pos.z) * 0.18;
    }
  }
}

const lerp = (a, b, k) => a + (b - a) * k;

// 보낸 위치를 몇 개까지 기억할지 (20Hz 기준 약 0.75초)
const SENT_HISTORY = 15;
