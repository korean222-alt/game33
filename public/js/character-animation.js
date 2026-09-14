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

const X_AXIS = new THREE.Vector3(1, 0, 0);
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
    this._tmpQ = new THREE.Quaternion();
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
    const wantHands = state.hands ? 1 : 0;
    this.handsUp += (wantHands - this.handsUp) * Math.min(1, dt * 6);
    if (this.handsUp > 0.01) this._raiseHands(this.handsUp);
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
   * 총기를 손에 맞춰 놓는다. 오른손에서 왼손 방향이 총구 방향(+X)이 되도록
   * 매 프레임 맞추기 때문에 어떤 동작에서도 손을 벗어나지 않는다.
   * @param weapon  아바타 그룹의 자식인 총기 오브젝트
   * @param group   아바타 그룹
   */
  alignWeapon(weapon, group, gripOffset = 0.1) {
    const { rightHand, leftHand } = this.bones;
    if (!weapon || !rightHand || !leftHand) return false;
    const right = rightHand.getWorldPosition(this._tmpA);
    const left = leftHand.getWorldPosition(this._tmpB);
    const dir = left.clone().sub(right);
    if (dir.lengthSq() < 1e-8) return false;
    dir.normalize();
    const localDir = dir.clone().applyQuaternion(
      group.getWorldQuaternion(this._tmpQ).invert(),
    ).normalize();
    weapon.quaternion.setFromUnitVectors(X_AXIS, localDir);
    const world = right.clone().addScaledVector(dir, gripOffset);
    weapon.position.copy(group.worldToLocal(world));
    return true;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}
