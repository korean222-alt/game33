/* =============================================================================
 *  player.js  -  내 캐릭터 (이동 예측 / 카메라 / 총 뷰모델 / 반동)
 *
 *  이동은 클라이언트가 먼저 계산하고(예측), 서버는 map-data 의 같은 충돌 함수로
 *  한 번 더 보정한다. 서버가 확인한 입력 번호로 전송 당시의 위치와 비교해
 *  네트워크 지연으로 최신 이동이 지워지는 현상을 방지한다.
 * ========================================================================== */

import * as THREE from 'three';
import { PLAYER, COMBAT, VIEWMODEL } from './config.js';
import { moveBody, COLLIDERS, overlaps, resolveCircle } from './map-data.js';

import { PredictionHistory } from './prediction-history.js';

import { createWeaponOptic, disposeOptic } from './weapon-optic.js';
import { sightPosition } from './viewmodel-layout.js';

export class LocalPlayer {
  /**
   * @param colliders  문 상태가 반영된 콜라이더 배열을 돌려주는 함수.
   *                   닫힌 문이 사람을 막아야 하므로 매 프레임 물어본다.
   */
  constructor(camera, scene, assets, settings, colliders = () => COLLIDERS) {
    this.camera = camera;
    this.scene = scene;
    this.assets = assets;
    this.settings = settings;
    this.colliders = colliders;
    this.holdingUse = false;
    this.frozen = false;      // 문틈 확인 중에는 이동을 멈춘다

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
    this._prediction = new PredictionHistory();

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
    this._prediction.reset();
  }

  setWeapon(key) {
    this.weapon = key;
    disposeOptic(this._optic);
    this._optic = null;
    // 이전 뷰모델 정리
    while (this._vmGroup.children.length) this._vmGroup.remove(this._vmGroup.children[0]);
    try {
      this.viewmodel = this.assets.instance(key);
    } catch {
      this.viewmodel = null;
      return;
    }
    const { optic, anchor } = createWeaponOptic(this.viewmodel, key);
    this._optic = optic;
    this._sightAnchor = anchor;
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

    const colliders = this.colliders();
    this.holdingUse = !!input.use;
    // 문틈에 눈을 대고 있는 동안에는 제자리에 선다. 입력은 그대로 두고
    // 여기서만 무시하므로, 손을 떼면 키를 다시 누르지 않아도 바로 움직인다.
    const move = this.frozen ? FROZEN_MOVE : input.move;
    const wantSprint = !this.frozen && input.sprint && move.y > 0.3 && !input.ads && !input.crouch;
    // 낮은 틈으로 들어간 뒤 테이블/선반 안에서 일어서지 않게 한다.
    this.crouching = !!input.crouch || (this.crouching && colliders.some(c =>
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

    const wishX = fwdX * move.y + rgtX * move.x;
    const wishZ = fwdZ * move.y + rgtZ * move.x;
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
    if (input.consumeJump() && this.onGround && !this.crouching && !this.frozen) {
      this.vel.y = PLAYER.jumpSpeed;
      this.onGround = false;
    }
    const body = moveBody(this.pos, this.vel, Math.min(dt, .1), {
      radius: PLAYER.radius, height: this.crouching ? 1.3 : PLAYER.height,
      grounded: this.onGround, gravity: PLAYER.gravity,
    }, colliders);
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
    const adsFov = VIEWMODEL[this.weapon]?.scopeFov ?? this.settings.adsFov;
    const fov = lerp(this.settings.fov, adsFov, this.adsAmount);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /* ---- 1인칭 총 --------------------------------------------------------- */
  _applyViewmodel(dt) {
    if (!this.viewmodel) return;
    const vm = VIEWMODEL[this.weapon] || VIEWMODEL.rifle;

    const p = vm.pos;
    const ap = sightPosition(this._sightAnchor, vm.scale, vm.sightDistance);
    const r = vm.rot, ar = [0, Math.PI / 2, 0];
    const a = this.adsAmount;
    this.viewmodel.visible = this.weapon !== 'sniper' || a < .95;

    // 달릴 때는 총을 내린다
    const sprintDrop = this.sprinting ? 1 : 0;
    this._sprintK = this._sprintK ?? 0;
    this._sprintK += (sprintDrop - this._sprintK) * (1 - Math.exp(-10 * dt));

    const sway = this.moving ? Math.sin(this.bobPhase) * 0.008 * (1 - a) : 0;

    this.viewmodel.position.set(
      lerp(p[0], ap[0], a) + sway,
      lerp(p[1], ap[1], a) - this._sprintK * 0.10 * (1 - a) + Math.sin(this.bobPhase * 2) * 0.004 * (1 - a),
      lerp(p[2], ap[2], a),
    );
    this.viewmodel.rotation.set(
      lerp(r[0], ar[0], a) + this._sprintK * 0.35 * (1 - a),
      lerp(r[1], ar[1], a),
      lerp(r[2], ar[2], a) + this._sprintK * 0.30 * (1 - a),
    );
    const sc = vm.scale ?? 1;
    this.viewmodel.scale.setScalar(sc);

    if (this.muzzle) {
      const on = performance.now() < this.muzzleUntil;
      this.muzzle.intensity = on ? 9 : 0;
      this.viewmodel.updateMatrixWorld(true);
      const length = this.weapon === 'sniper' ? 1.2 : this.weapon === 'smg' ? .65 : .9;
      const muzzle = this.viewmodel.localToWorld(new THREE.Vector3(length / 2, .05, 0));
      this.muzzle.position.copy(this._vmGroup.worldToLocal(muzzle));
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
    if (this.viewmodel) {
      const [x, y] = this.weapon === 'sniper' ? [.6, .02] : this.weapon === 'smg' ? [.325, .095] : [.45, .05];
      return this.viewmodel.localToWorld(new THREE.Vector3(x, y, 0));
    }
    const eye = this.pos.y + (this._eye ?? PLAYER.eyeHeight);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    return {
      x: this.pos.x + fwd.x * 0.45 + right.x * 0.12,
      y: eye - 0.1 + fwd.y * 0.45,
      z: this.pos.z + fwd.z * 0.45 + right.z * 0.12,
    };
  }

  /** 서버로 보낼 입력 상태: 전송 좌표와 이동 번호를 함께 기록한다. */
  netState() {
    return {
      ...this._prediction.record(this.pos),
      yaw: +this.yaw.toFixed(3),
      pitch: +this.pitch.toFixed(3),
      moving: this.moving ? 1 : 0,
      sprint: this.sprinting ? 1 : 0,
      crouch: this.crouching ? 1 : 0,
      use: this.holdingUse ? 1 : 0,
    };
  }

  /** 서버가 확인한 입력의 오차만 적용하고 이후의 이동은 보존한다. */
  reconcile(sx, sz, sy, inputSeq) {
    const delta = this._prediction.acknowledge(inputSeq, { x: sx, y: sy, z: sz });
    if (!delta || (!delta.x && !delta.y && !delta.z)) return;
    const height = this.crouching ? 1.3 : PLAYER.height;
    this.pos.y = Math.max(0, this.pos.y + delta.y);
    const fixed = resolveCircle(this.pos.x + delta.x, this.pos.z + delta.z,
      PLAYER.radius, this.colliders(), this.pos.y, height);
    this.pos.x = fixed.x;
    this.pos.z = fixed.z;
    if (delta.x) this.vel.x = 0;
    if (delta.z) this.vel.z = 0;
    if (delta.y) { this.vel.y = 0; this.onGround = false; }
  }
}

const lerp = (a, b, k) => a + (b - a) * k;
/** 문틈을 보는 동안 쓰는 "입력 없음". 입력 객체를 건드리지 않기 위해 따로 둔다. */
const FROZEN_MOVE = Object.freeze({ x: 0, y: 0 });
