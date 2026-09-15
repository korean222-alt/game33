/* =============================================================================
 *  character-animation.js  -  첨부한 Mixamo 동작 묶음을 캐릭터에 입힌다
 *
 *  character-animated.glb 안의 클립 이름(import-animations.mjs 의 CLIPS 와 동일):
 *    idle aim crouchIdle crouchWalk crouchWalkAim run sprint
 *    strafeLeft strafeRight walkBack runBack fire reload jump hit death
 *
 *  이동 방향과 속도, 자세, 사격/재장전/피격/사망을 보고 알맞은 클립을 골라
 *  교차 페이드한다. 항복 자세는 별도 클립이 없으므로 앉은 자세 위에 팔만
 *  들어 올려서 만든다.
 * ========================================================================== */

import * as THREE from 'three';
import { placeWrist } from './restraints.js';

const UP = new THREE.Vector3(0, 1, 0);
/* 두 손 사이가 이 범위를 벗어나면 총을 잡은 자세가 아니다(달리기/포복/사망 클립). */
const GRIP_SPAN_MIN = 0.13;
const GRIP_SPAN_MAX = 0.82;
/* 총을 잡지 않은 자세에서 쓰는 "내린 총" 방향(몸 기준, -Z 가 정면). */
const LOW_READY = new THREE.Vector3(0, -0.42, -1).normalize();
/* 뼈대가 없는 placeholder 에 총을 들릴 때 쓰는 손 위치(몸 기준). */
const FALLBACK_HAND = new THREE.Vector3(0.19, 1.24, -0.12);
const WALK_SCALE = 0.62;          // 달리기 클립을 늦춰서 걷기로 쓴다
const SPRINT_SPEED = 4.6;
const RUN_SPEED = 2.1;
const MOVE_SPEED = 0.3;

/** 한 번만 재생하고 원래 자세로 돌아오는 동작. */
const ONE_SHOT = {
  fire: { fade: 0.05, timeScale: 1 },
  reload: { fade: 0.14, timeScale: 1 },
  hit: { fade: 0.1, timeScale: 1.5 },
  jump: { fade: 0.12, timeScale: 1.1 },
};

export class CharacterRig {
  /**
   * @param root   SkeletonUtils.clone 으로 복제한 캐릭터
   * @param clips  AnimationClip 배열 (AssetManager 가 넘겨준다)
   */
  constructor(root, clips = []) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = new Map();
    for (const clip of clips) {
      const action = this.mixer.clipAction(clip);
      action.clampWhenFinished = false;
      this.actions.set(clip.name, action);
    }
    this.base = null;
    this.oneShot = null;
    this.oneShotUntil = 0;
    this.time = 0;

    this.bones = {
      leftHand: root.getObjectByName('mixamorigLeftHand'),
      rightHand: root.getObjectByName('mixamorigRightHand'),
      leftArm: root.getObjectByName('mixamorigLeftArm'),
      rightArm: root.getObjectByName('mixamorigRightArm'),
      leftForeArm: root.getObjectByName('mixamorigLeftForeArm'),
      rightForeArm: root.getObjectByName('mixamorigRightForeArm'),
      spine: root.getObjectByName('mixamorigSpine1'),
    };
    this.rest = new Map();
    for (const [name, bone] of Object.entries(this.bones)) {
      if (bone) this.rest.set(name, bone.quaternion.clone());
    }
    this.handsUp = 0;
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    // 총기 정렬용. 매 프레임 새로 만들지 않는다.
    this._muzzle = null;
    this._axisX = new THREE.Vector3();
    this._axisY = new THREE.Vector3();
    this._axisZ = new THREE.Vector3();
    this._anchor = new THREE.Vector3();
    this._basis = new THREE.Matrix4();
  }

  get ready() { return this.actions.size > 0; }

  /** 기본(루프) 동작 전환. */
  play(name, { fade = 0.24, timeScale = 1 } = {}) {
    const action = this.actions.get(name);
    if (!action) return false;
    if (this.base === action) { action.timeScale = timeScale; return true; }
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.timeScale = timeScale;
    action.enabled = true;
    action.fadeIn(fade).play();
    if (this.base) this.base.fadeOut(fade);
    this.base = action;
    this.baseName = name;
    return true;
  }

  /** 한 번 재생하는 동작(사격/재장전/피격). */
  trigger(name) {
    const spec = ONE_SHOT[name];
    const action = this.actions.get(name);
    if (!spec || !action) return false;
    // 같은 동작이 이미 돌고 있으면 처음부터 다시
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.timeScale = spec.timeScale;
    action.enabled = true;
    action.fadeIn(spec.fade).play();
    if (this.base) this.base.fadeOut(spec.fade);
    if (this.oneShot && this.oneShot !== action) this.oneShot.fadeOut(spec.fade);
    this.oneShot = action;
    this.oneShotName = name;
    this.oneShotUntil = this.time + (action.getClip().duration / spec.timeScale) * 1000;
    return true;
  }

  /** 사망 동작. 마지막 자세에서 멈춘다. */
  die() {
    const action = this.actions.get('death');
    if (!action || this.dead) return;
    this.dead = true;
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.fadeIn(0.12).play();
    if (this.base) this.base.fadeOut(0.12);
    if (this.oneShot) this.oneShot.fadeOut(0.12);
    this.base = action;
    this.baseName = 'death';
    this.oneShot = null;
  }

  revive() {
    if (!this.dead) return;
    const action = this.actions.get('death');
    action?.stop();
    this.dead = false;
    this.base = null;
    this.baseName = null;
  }

  /**
   * @param state.speed     수평 속도 (m/s)
   * @param state.forward   전진 성분 (-1~1, 바라보는 방향 기준)
   * @param state.strafe    측면 성분 (-1~1, +는 오른쪽)
   * @param state.crouch    웅크림
   * @param state.aiming    무기를 들어 겨누는 중
   * @param state.hands     손을 든 상태(항복/체포)
   */
  update(dt, state = {}) {
    this.time += dt * 1000;
    if (!this.ready) return;

    if (state.dead) this.die();
    else {
      if (this.dead) this.revive();
      this._chooseBase(state);
      if (this.oneShot && this.time > this.oneShotUntil) {
        this.oneShot.fadeOut(0.16);
        this.oneShot = null;
        if (this.base) this.base.fadeIn(0.16);
      }
    }

    this.mixer.update(dt);

    // 항복 자세: 클립이 없으므로 어깨/팔꿈치만 들어 올린다.
    const wantHands = state.hands && !state.cuffed ? 1 : 0;
    this.handsUp += (wantHands - this.handsUp) * Math.min(1, dt * 6);
    if (this.handsUp > 0.01 && !state.dead) this._raiseHands(this.handsUp);
    this.cuffedAmount = THREE.MathUtils.damp(this.cuffedAmount || 0, state.cuffed && !state.dead ? 1 : 0, 10, dt);
    if (this.cuffedAmount > .01 && !state.dead) {
      const frame = this.root.parent || this.root;
      const chest = this.bones.spine?.getWorldPosition(new THREE.Vector3());
      if (chest) {
        frame.worldToLocal(chest);
        for (const [side, sign] of [['left', 1], ['right', -1]]) {
          const target = frame.localToWorld(new THREE.Vector3(sign * .085, chest.y - .22, chest.z - .34));
          placeWrist(this.bones[side + 'Arm'], this.bones[side + 'ForeArm'], this.bones[side + 'Hand'], target, this.cuffedAmount);
        }
      }
    }
  }

  _chooseBase(state) {
    const { speed = 0, forward = 0, strafe = 0, crouch = false, aiming = false } = state;
    if (crouch) {
      if (speed > MOVE_SPEED) this.play(aiming ? 'crouchWalkAim' : 'crouchWalk', { timeScale: 1 });
      else this.play('crouchIdle');
      return;
    }
    if (speed <= MOVE_SPEED) { this.play(aiming ? 'aim' : 'idle'); return; }

    if (forward < -0.35) {
      this.play(speed > RUN_SPEED ? 'runBack' : 'walkBack', { timeScale: speed > RUN_SPEED ? 1 : 1 });
      return;
    }
    if (Math.abs(strafe) > Math.abs(forward) + 0.15) {
      this.play(strafe > 0 ? 'strafeRight' : 'strafeLeft', { timeScale: Math.max(0.7, speed / 1.6) });
      return;
    }
    if (speed > SPRINT_SPEED) { this.play('sprint', { timeScale: 1 }); return; }
    if (speed > RUN_SPEED) { this.play('run', { timeScale: 1 }); return; }
    this.play('run', { timeScale: WALK_SCALE });
  }

  /**
   * 항복 자세. 전용 클립이 없으므로 어깨와 팔꿈치를 "위쪽"으로 겨눠서 만든다.
   * 뼈의 로컬 축을 가정하지 않고, 자식 뼈가 향하는 방향을 원하는 방향으로
   * 돌리는 회전을 매 프레임 계산하므로 어떤 동작 위에 얹어도 안전하다.
   */
  _raiseHands(amount) {
    const up = new THREE.Vector3(0, 1, 0);
    const point = (jointName, childName, outward) => {
      const joint = this.bones[jointName], child = this.bones[childName];
      if (!joint || !child) return;
      const origin = joint.getWorldPosition(this._tmpA);
      const current = child.getWorldPosition(this._tmpB).sub(origin);
      if (current.lengthSq() < 1e-8) return;
      current.normalize();
      // 팔이 놓인 평면을 유지한 채 위로 올린다 (아바타가 어느 쪽을 보고 있어도 된다).
      const horizontal = new THREE.Vector3(current.x, 0, current.z);
      if (horizontal.lengthSq() < 1e-6) horizontal.set(current.x || 1, 0, current.z);
      horizontal.normalize().multiplyScalar(outward);
      const wanted = horizontal.add(up).normalize();
      const blended = current.clone().lerp(wanted, amount).normalize();
      const world = new THREE.Quaternion()
        .setFromUnitVectors(current, blended)
        .multiply(joint.getWorldQuaternion(new THREE.Quaternion()));
      joint.quaternion.copy(
        joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world),
      );
      joint.updateMatrixWorld(true);
    };
    point('rightArm', 'rightForeArm', 0.55);
    point('leftArm', 'leftForeArm', 0.55);
    point('rightForeArm', 'rightHand', 0.12);
    point('leftForeArm', 'leftHand', 0.12);
    this.root.updateMatrixWorld(true);
  }

  /**
   * 총기를 손에 맞춰 놓는다.
   *
   *  이전 방식은 "오른손 -> 왼손" 방향만 총구에 맞췄다. 그러면 두 가지가 깨진다.
   *    1) 축 하나만 맞추므로 총이 총열을 축으로 제멋대로 굴러 옆으로 눕거나
   *       뒤집혀 보인다.
   *    2) 달리기·측면이동·앉기·사망처럼 소총을 들지 않은 클립에서는 두 손이
   *       총을 잡은 모양이 아니어서 총구가 엉뚱한 데를 가리킨다.
   *
   *  그래서 총구 축과 "총 윗면" 축을 같이 세워 회전을 완전히 고정하고,
   *  두 손이 총을 잡은 모양일 때만 손 방향을 쓴다. 아닐 때는 몸을 기준으로
   *  총을 내린 자세로 붙인다.
   *
   * @param weapon      아바타 그룹의 자식인 총기 오브젝트
   * @param group       아바타 그룹
   * @param gripOffset  손에서 총구 쪽으로 밀어 줄 거리(총 길이의 절반쯤)
   * @param dt          프레임 간격(초). 방향 전환을 부드럽게 하는 데 쓴다
   */
  alignWeapon(weapon, group, gripOffset = 0.1, dt = 0) {
    if (!weapon || !group) return false;
    const { rightHand, leftHand } = this.bones;
    const inverse = group.getWorldQuaternion(this._tmpQ).invert();

    // --- 총을 쥔 위치 (그룹 로컬) ---
    if (rightHand) group.worldToLocal(this._anchor.copy(rightHand.getWorldPosition(this._tmpA)));
    else this._anchor.copy(FALLBACK_HAND);

    // --- 총구 방향 (그룹 로컬) ---
    let aimed = null;
    if (rightHand && leftHand) {
      const span = leftHand.getWorldPosition(this._tmpB)
        .sub(rightHand.getWorldPosition(this._tmpC));
      const length = span.length();
      if (length > GRIP_SPAN_MIN && length < GRIP_SPAN_MAX) {
        const local = span.divideScalar(length).applyQuaternion(inverse);
        // 왼손이 몸 뒤에 있으면 총을 받친 것이 아니다(팔을 흔드는 중).
        if (local.z < 0.2) aimed = local;
      }
    }
    const wanted = aimed || LOW_READY;

    if (!this._muzzle) this._muzzle = wanted.clone();
    else this._muzzle.lerp(wanted, dt > 0 ? Math.min(1, dt * 14) : 1);
    if (this._muzzle.lengthSq() < 1e-8) this._muzzle.copy(wanted);
    this._muzzle.normalize();

    // --- 총구(+X)와 총 윗면(+Y)을 같이 세워 굴림을 없앤다 ---
    const x = this._axisX.copy(this._muzzle);
    const z = this._axisZ.crossVectors(x, UP);
    if (z.lengthSq() < 1e-6) z.set(1, 0, 0);   // 총구가 정확히 수직일 때
    z.normalize();
    const y = this._axisY.crossVectors(z, x).normalize();
    weapon.quaternion.setFromRotationMatrix(this._basis.makeBasis(x, y, z));
    // 손은 손잡이를 쥔다 -> 총 몸통은 손보다 조금 위, 총구 쪽으로 나가 있다.
    weapon.position.copy(this._anchor).addScaledVector(x, gripOffset).addScaledVector(y, 0.045);
    return true;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}

