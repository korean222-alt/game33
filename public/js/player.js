/* =============================================================================
 *  player.js  -  내가 조종하는 1인칭 캐릭터
 *
 *  담당
 *    - 이동 물리(가속/마찰/중력/점프/앉기/달리기) + 벽 충돌
 *    - 카메라 (시점, 반동, 흔들림, 정조준 FOV)
 *    - 1인칭 총 뷰모델 (흔들림, 반동, 재장전, 정조준)
 *    - 사격 판정(연출용 로컬 레이캐스트) + 서버로 전송
 *
 *  ★ 뷰모델은 "별도의 씬 + 별도의 카메라" 로 그린다.
 *    같은 씬에 넣으면 벽에 바짝 붙었을 때 총이 벽을 뚫고 나간다.
 *    메인 씬을 그린 뒤 깊이 버퍼만 지우고 그 위에 덧그리면 절대 안 뚫린다.
 * ========================================================================== */

import * as THREE from 'three';
import { PLAYER, COMBAT, VIEWMODEL, MODELS } from './config.js';
import { COLLIDERS, resolveCircle, BOMB_SITES } from './map-data.js';

const DEFUSE_RANGE = 1.6;

export class LocalPlayer {
  /**
   * @param {THREE.PerspectiveCamera} camera  메인 카메라
   * @param {import('./assets.js').AssetManager} assets
   * @param {import('./effects.js').Effects} fx
   */
  constructor(camera, assets, fx, settings) {
    this.camera = camera;
    this.assets = assets;
    this.fx = fx;
    this.settings = settings;

    /* --- 위치/속도 --- */
    this.pos = new THREE.Vector3(0, 0, 4.5);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;

    /* --- 자세 --- */
    this.crouch = 0;          // 0~1 (부드럽게 변한다)
    this.adsAmount = 0;       // 0~1
    this.eyeHeight = PLAYER.eyeHeight;

    /* --- 전투 --- */
    this.weapon = 'rifle';
    this.spec = null;         // 서버가 준 무기 스펙
    this.ammo = 30;
    this.reserve = 150;
    this.reloading = false;
    this.reloadEndsAt = 0;
    this.lastShotAt = 0;
    this.spread = COMBAT.spread.idle;
    this.recoil = { pitch: 0, yaw: 0 };
    this.alive = true;
    this.hp = 100;

    /* --- 연출 --- */
    this.bobTime = 0;
    this.bobOffset = new THREE.Vector3();
    this.stepDistance = 0;
    this.landKick = 0;

    /* --- 목표 상호작용 --- */
    this.defuseTarget = null;

    /* --- 콜백 --- */
    this.onShoot = null;      // (origin, dir) => void  서버 전송
    this.onReloadStart = null;
    this.onStep = null;
    this.onDryFire = null;

    this._raycaster = new THREE.Raycaster();
    this._raycaster.far = 80;

    this._buildViewmodel();
  }

  /* ======================================================================= *
   *  뷰모델 (별도 씬)
   * ==================================================================== */
  _buildViewmodel() {
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 8);

    // 총에만 닿는 전용 조명 (메인 씬 조명과 무관하게 항상 형태가 보이게)
    const key = new THREE.DirectionalLight(0xffe6c4, 2.3);
    key.position.set(0.6, 1.0, 0.8);
    this.viewScene.add(key);
    const fill = new THREE.DirectionalLight(0x6f86b8, 0.9);
    fill.position.set(-0.8, -0.2, 0.4);
    this.viewScene.add(fill);
    this.viewScene.add(new THREE.AmbientLight(0x404a5c, 1.1));

    // 총이 들어갈 자리 (카메라 흔들림과 분리하기 위해 두 겹)
    this.vmSway = new THREE.Group();     // 관성 흔들림
    this.vmHolder = new THREE.Group();   // 기본 위치 (VIEWMODEL 설정값)
    this.vmSway.add(this.vmHolder);
    this.viewScene.add(this.vmSway);

    this.vmModel = null;
    this.setWeapon('rifle');
  }

  setWeapon(key) {
    this.weapon = key;
    if (this.vmModel) { this.vmHolder.remove(this.vmModel); this.vmModel = null; }

    let obj;
    try { obj = this.assets.instance(key); } catch { return; }

    // assets 가 이미 MODELS[key].rotY 를 적용해서 총구가 -Z 를 보게 해뒀다.
    this.vmModel = obj;
    this.vmHolder.add(obj);

    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;   // 화면 가장자리에서 사라지는 것 방지
    });

    // 총구 화염은 "뷰모델 씬 안" 에 총에 매달아 둔다.
    // 메인 씬에 그리면 뷰모델 카메라와 FOV 가 달라서 총구에서 살짝 어긋난다.
    if (!this.vmFlash) this.vmFlash = this._makeViewFlash();
    this.vmHolder.add(this.vmFlash.group);

    const vm = VIEWMODEL[key] || VIEWMODEL.rifle;
    this.vmBase = {
      pos: new THREE.Vector3(...vm.pos),
      rot: new THREE.Euler(...vm.rot),
      adsPos: new THREE.Vector3(...vm.adsPos),
      adsRot: new THREE.Euler(...(vm.adsRot || [0, 0, 0])),
      scale: vm.scale ?? 1,
    };
    this.vmHolder.scale.setScalar(this.vmBase.scale);

    // 총구 위치: 모델 길이의 절반만큼 앞(-Z)
    const len = MODELS[key]?.placeholder?.len ?? 0.9;
    this.muzzleLocal = new THREE.Vector3(0, 0.012, -len / 2 - 0.02);
    this.vmFlash.group.position.copy(this.muzzleLocal);
  }

  /** 뷰모델 전용 총구 화염 (총에 매달려 있어서 절대 안 어긋난다) */
  _makeViewFlash() {
    const group = new THREE.Group();
    group.visible = false;
    group.renderOrder = 10;

    const mat = new THREE.MeshBasicMaterial({
      map: makeFlareTexture(), transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 2; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.30), mat);
      p.rotation.z = (i * Math.PI) / 2;
      group.add(p);
    }
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff4d2, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), coreMat);
    group.add(core);

    return { group, mat, coreMat, t: 0, on: false };
  }

  _updateViewFlash(dt) {
    const f = this.vmFlash;
    if (!f || !f.on) return;
    f.t += dt * 1000;
    const k = f.t / COMBAT.muzzleFlashMs;
    if (k >= 1) { f.on = false; f.group.visible = false; return; }
    f.mat.opacity = 1 - k;
    f.coreMat.opacity = 1 - k;
  }

  _triggerViewFlash() {
    const f = this.vmFlash;
    if (!f) return;
    f.on = true;
    f.t = 0;
    f.group.visible = true;
    f.group.rotation.z = Math.random() * Math.PI;
    f.group.scale.setScalar(0.75 + Math.random() * 0.5);
  }

  /** 서버가 준 무기 스펙 반영 */
  setSpec(spec) {
    this.spec = spec;
    this.fireIntervalMs = 60000 / spec.rpm;
  }

  /* ======================================================================= *
   *  스폰 / 리셋
   * ==================================================================== */
  spawn(x, z, yaw) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw || 0;
    this.pitch = 0;
    this.crouch = 0;
    this.adsAmount = 0;
    this.recoil.pitch = this.recoil.yaw = 0;
    this.spread = COMBAT.spread.idle;
    this.onGround = true;
    this.alive = true;
    this.hp = 100;
    this.reloading = false;
    this.bobOffset.set(0, 0, 0);
  }

  /* ======================================================================= *
   *  매 프레임
   * ==================================================================== */
  update(dt, input, world, entityManager, now) {
    if (!this.alive) {
      this._updateDeadCamera(dt);
      return;
    }

    this._updateLook(dt, input);
    this._updateMove(dt, input);
    this._updateStance(dt, input);
    this._updateCamera(dt, input);
    this._updateWeapon(dt, input, world, entityManager, now);
    this._updateDefuse();
  }

  /* ---------------------------------------------------------------------- */
  _updateLook(dt, input) {
    const d = input.consumeLook();
    this.yaw -= d.dx;
    this.pitch -= d.dy;

    // 반동 회복
    const rec = COMBAT.recoil.recover * dt;
    this.recoil.pitch += (0 - this.recoil.pitch) * Math.min(1, rec);
    this.recoil.yaw += (0 - this.recoil.yaw) * Math.min(1, rec);

    // 위아래 제한 (완전히 뒤집히지 않게)
    const LIM = Math.PI / 2 - 0.03;
    this.pitch = Math.max(-LIM, Math.min(LIM, this.pitch));
    this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  }

  /* ---------------------------------------------------------------------- */
  _updateMove(dt, input) {
    /* --- 목표 속도 --- */
    const wantSprint = input.sprint && input.move.y > 0.25 && this.crouch < 0.3 && this.adsAmount < 0.4;
    let speed = PLAYER.walkSpeed;
    if (wantSprint) speed = PLAYER.sprintSpeed;
    else if (this.crouch > 0.5) speed = PLAYER.crouchSpeed;
    if (this.adsAmount > 0.5) speed *= PLAYER.adsSpeedMul;
    if (this.reloading) speed *= 0.85;

    // 입력을 월드 방향으로 (yaw 기준)
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // yaw=0 일 때 앞은 -Z
    const fwdX = -sin, fwdZ = -cos;
    const rightX = -fwdZ, rightZ = fwdX;

    let wishX = fwdX * input.move.y + rightX * input.move.x;
    let wishZ = fwdZ * input.move.y + rightZ * input.move.x;
    const wl = Math.hypot(wishX, wishZ);
    if (wl > 1) { wishX /= wl; wishZ /= wl; }

    const targetVX = wishX * speed;
    const targetVZ = wishZ * speed;

    /* --- 가속 / 마찰 (관성이 있어야 묵직하다) --- */
    const accel = (wl > 0.01 ? PLAYER.accel : PLAYER.friction) * (this.onGround ? 1 : 0.22);
    const k = Math.min(1, accel * dt);
    this.vel.x += (targetVX - this.vel.x) * k;
    this.vel.z += (targetVZ - this.vel.z) * k;

    /* --- 점프 / 중력 --- */
    if (input.consumeJump() && this.onGround && this.crouch < 0.4) {
      this.vel.y = PLAYER.jumpSpeed;
      this.onGround = false;
    }
    this.vel.y += PLAYER.gravity * dt;

    /* --- 실제 이동 + 충돌 --- */
    let nx = this.pos.x + this.vel.x * dt;
    let nz = this.pos.z + this.vel.z * dt;
    const fixed = resolveCircle(nx, nz, PLAYER.radius, COLLIDERS);

    // 벽에 부딪힌 방향의 속도를 죽인다 (벽에 붙어서 덜덜 떠는 것 방지)
    if (Math.abs(fixed.x - nx) > 1e-4) this.vel.x *= 0.1;
    if (Math.abs(fixed.z - nz) > 1e-4) this.vel.z *= 0.1;

    this.pos.x = fixed.x;
    this.pos.z = fixed.z;

    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= 0) {
      if (!this.onGround && this.vel.y < -3) this.landKick = Math.min(1, -this.vel.y / 12);
      this.pos.y = 0;
      this.vel.y = 0;
      this.onGround = true;
    }

    /* --- 발소리 --- */
    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && horizSpeed > 0.4) {
      this.stepDistance += horizSpeed * dt;
      const stride = wantSprint ? 1.05 : this.crouch > 0.5 ? 1.5 : 0.82;
      if (this.stepDistance >= stride) {
        this.stepDistance = 0;
        this.onStep?.(this.pos, wantSprint);
      }
    } else {
      this.stepDistance = Math.min(this.stepDistance, 0.4);
    }

    this.isMoving = horizSpeed > 0.35;
    this.isSprinting = wantSprint && horizSpeed > 1.2;
  }

  /* ---------------------------------------------------------------------- */
  _updateStance(dt, input) {
    const wantCrouch = input.crouch ? 1 : 0;
    this.crouch += (wantCrouch - this.crouch) * Math.min(1, dt * 9);

    // 달리는 중엔 정조준 불가 (레디오어낫 리얼리즘)
    const canAds = !this.isSprinting && !this.reloading;
    const wantAds = input.ads && canAds ? 1 : 0;
    this.adsAmount += (wantAds - this.adsAmount) * Math.min(1, dt * 11);
  }

  /* ---------------------------------------------------------------------- */
  _updateCamera(dt, input) {
    /* --- 눈높이 --- */
    const targetEye = PLAYER.eyeHeight + (PLAYER.crouchEye - PLAYER.eyeHeight) * this.crouch;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 12);

    /* --- 걸음 흔들림 --- */
    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);
    const bobStrength = this.onGround
      ? Math.min(1, horizSpeed / PLAYER.walkSpeed) * (1 - this.adsAmount * 0.75)
      : 0;
    this.bobTime += dt * PLAYER.bobSpeed * (this.isSprinting ? 1.35 : 1) * Math.max(0.15, bobStrength);

    const bobAmt = PLAYER.bobAmount * bobStrength;
    this.bobOffset.set(
      Math.sin(this.bobTime) * bobAmt * 1.1,
      Math.abs(Math.cos(this.bobTime)) * bobAmt * -0.9,
      0
    );

    /* --- 착지 충격 --- */
    this.landKick *= Math.max(0, 1 - dt * 7);

    /* --- 카메라 적용 --- */
    this.camera.position.set(
      this.pos.x + this.bobOffset.x,
      this.pos.y + this.eyeHeight + this.bobOffset.y - this.landKick * 0.18,
      this.pos.z + this.bobOffset.z
    );
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw + this.recoil.yaw;
    this.camera.rotation.x = this.pitch + this.recoil.pitch;
    // 좌우 이동 시 살짝 기울이기 (미세하지만 몰입감이 크다)
    const strafe = (this.vel.x * -Math.cos(this.yaw) + this.vel.z * Math.sin(this.yaw));
    this.camera.rotation.z = -strafe * 0.012 * (1 - this.adsAmount);

    /* --- FOV --- */
    const targetFov = this.settings.fov + (this.settings.adsFov - this.settings.fov) * this.adsAmount;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 12);
      this.camera.updateProjectionMatrix();
    }
  }

  _updateDeadCamera(dt) {
    // 쓰러지면서 시점이 바닥으로 내려간다
    this.eyeHeight += (0.32 - this.eyeHeight) * Math.min(1, dt * 3.5);
    this.camera.position.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = Math.max(-0.4, this.pitch - 0.35);
    this.camera.rotation.z += (0.7 - this.camera.rotation.z) * Math.min(1, dt * 3);
  }

  /* ======================================================================= *
   *  무기
   * ==================================================================== */
  _updateWeapon(dt, input, world, entityManager, now) {
    /* --- 재장전 완료 --- */
    if (this.reloading && now >= this.reloadEndsAt) {
      this.reloading = false;
    }

    /* --- 탄 퍼짐 --- */
    let base = COMBAT.spread.idle;
    if (this.isSprinting) base = COMBAT.spread.sprint;
    else if (this.isMoving) base = COMBAT.spread.move;
    if (this.crouch > 0.6 && !this.isMoving) base = COMBAT.spread.crouch;
    if (this.adsAmount > 0.7) base = Math.min(base, COMBAT.spread.ads);

    this.spread += (base - this.spread) * Math.min(1, dt * 6);
    this.spread = Math.max(base, this.spread - COMBAT.spread.recover * dt);
    this.spread = Math.min(COMBAT.spread.max, this.spread);

    /* --- 발사 --- */
    if (input.fire && this.canFire(now)) {
      this._fire(world, entityManager, now);
    }

    /* --- 뷰모델 자세 / 총구 섬광 --- */
    this._updateViewmodel(dt, input);
    this._updateViewFlash(dt);
  }

  canFire(now) {
    if (!this.alive || this.reloading) return false;
    if (this.isSprinting) return false;           // 달리면서 못 쏜다
    if (now - this.lastShotAt < this.fireIntervalMs) return false;
    if (this.ammo <= 0) {
      // 빈 탄창 딸깍 (연타 방지를 위해 간격을 둔다)
      if (now - this.lastShotAt > 350) {
        this.lastShotAt = now;
        this.onDryFire?.();
      }
      return false;
    }
    return true;
  }

  _fire(world, entityManager, now) {
    this.lastShotAt = now;
    this.ammo--;

    /* --- 발사 방향 = 카메라 정면 + 퍼짐 --- */
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);

    // 원뿔 안에서 랜덤하게 틀어준다
    const s = this.spread;
    if (s > 0.0001) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * s;
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(dir, up).normalize();
      const realUp = new THREE.Vector3().crossVectors(right, dir).normalize();
      dir.addScaledVector(right, Math.cos(a) * r);
      dir.addScaledVector(realUp, Math.sin(a) * r);
      dir.normalize();
    }

    const origin = this.camera.position.clone();

    /* --- 총구 연출 ---
     *  섬광 자체는 뷰모델 씬에서(총에 딱 붙게), 주변을 밝히는 빛은 메인 씬에서. */
    const muzzleWorld = this._muzzleWorldPosition();
    this._triggerViewFlash();
    this.fx.flashLightOnly(muzzleWorld);

    /* --- 로컬 레이캐스트 (탄착 이펙트용. 데미지는 서버가 정한다) --- */
    const hit = this._raycast(origin, dir, world, entityManager);
    const dist = hit ? hit.distance : (this.spec?.range ?? 60);

    this.fx.tracer(muzzleWorld, dir, dist, true);
    if (hit) {
      if (hit.isCharacter) this.fx.blood(hit.point);
      else this.fx.impact(hit.point, hit.normal, hit.material);
    }

    /* --- 반동 --- */
    const rMul = (1 - this.adsAmount * 0.42) * (this.crouch > 0.6 ? 0.78 : 1);
    this.recoil.pitch += COMBAT.recoil.vertical * rMul;
    this.recoil.yaw += (Math.random() - 0.5) * 2 * COMBAT.recoil.horizontal * rMul;
    this.spread = Math.min(COMBAT.spread.max, this.spread + COMBAT.spread.perShot);

    // 뷰모델 반동
    this.vmRecoil = Math.min(1.6, (this.vmRecoil || 0) + 1);

    /* --- 서버로 --- */
    this.onShoot?.(origin, dir, hit);
  }

  _muzzleWorldPosition() {
    // 뷰모델은 카메라 로컬 공간에 있으므로, 카메라 변환을 태워서 월드로 옮긴다
    const local = this.vmHolder.localToWorld(this.muzzleLocal.clone()); // viewScene 좌표
    return local.applyQuaternion(this.camera.quaternion).add(this.camera.position);
  }

  /** 연출용 로컬 레이캐스트 */
  _raycast(origin, dir, world, entityManager) {
    this._raycaster.set(origin, dir);
    this._raycaster.far = this.spec?.range ?? 60;
    // ★ 스프라이트(이름표/목표 마커)가 씬에 있으면 three 가 카메라를 요구한다.
    //   안 넣으면 Sprite.raycast 안에서 예외가 터지고, 그 바람에 사격 자체가
    //   서버로 전달되지 않는다(탄약이 안 줄어드는 증상).
    this._raycaster.camera = this.camera;

    const targets = [];
    if (world?.root) targets.push(world.root);
    if (entityManager) {
      for (const c of entityManager.bots.values()) if (c.alive) targets.push(c.group);
      for (const c of entityManager.players.values()) if (c.alive) targets.push(c.group);
    }
    if (!targets.length) return null;

    const hits = this._raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      // 스프라이트(이름표/마커)와 투명한 연출물은 무시
      if (h.object.isSprite) continue;
      if (h.object.material?.depthWrite === false) continue;

      // 어떤 캐릭터에 맞았는지
      let isCharacter = false;
      let o = h.object;
      while (o) {
        if (o.userData?.isCharacterRoot) { isCharacter = true; break; }
        o = o.parent;
      }

      const normal = h.face
        ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
        : dir.clone().negate();

      return {
        point: h.point, normal, distance: h.distance, isCharacter,
        material: this._guessMaterial(h.object),
      };
    }
    return null;
  }

  _guessMaterial(obj) {
    const n = (obj.name || '').toLowerCase();
    const m = (obj.material?.name || '').toLowerCase();
    if (n.includes('metal') || m.includes('metal')) return 'metal';
    if (n.includes('wood') || m.includes('wood') || n.includes('crate')) return 'wood';
    return 'concrete';
  }

  /* ---------------------------------------------------------------------- */
  reload() {
    if (!this.alive || this.reloading || !this.spec) return false;
    if (this.ammo >= this.spec.mag || this.reserve <= 0) return false;
    this.reloading = true;
    this.reloadEndsAt = performance.now() + this.spec.reload * 1000;
    this.reloadStartedAt = performance.now();
    this.onReloadStart?.(this.spec.reload);
    return true;
  }

  /* ---------------------------------------------------------------------- *
   *  뷰모델 자세 계산
   * ------------------------------------------------------------------- */
  _updateViewmodel(dt, input) {
    if (!this.vmModel || !this.vmBase) return;

    const A = this.adsAmount;

    /* --- 기본 위치: 허리 <-> 정조준 사이 보간 --- */
    _v1.copy(this.vmBase.pos).lerp(this.vmBase.adsPos, A);

    /* --- 걸음 흔들림 --- */
    const sway = (1 - A * 0.85);
    const bobX = Math.sin(this.bobTime) * 0.014 * sway;
    const bobY = Math.abs(Math.cos(this.bobTime)) * -0.011 * sway;
    _v1.x += bobX * (this.isMoving ? 1 : 0.2);
    _v1.y += bobY * (this.isMoving ? 1 : 0.2);

    /* --- 달릴 때 총을 내린다 --- */
    const sprintK = this.isSprinting ? 1 : 0;
    this.vmSprint = (this.vmSprint ?? 0) + (sprintK - (this.vmSprint ?? 0)) * Math.min(1, dt * 8);

    /* --- 재장전: 아래로 내렸다가 올라온다 --- */
    let reloadDrop = 0, reloadRoll = 0;
    if (this.reloading && this.spec) {
      const k = Math.min(1, (performance.now() - this.reloadStartedAt) / (this.spec.reload * 1000));
      // 0 -> 1 -> 0 모양의 곡선
      const curve = Math.sin(Math.min(1, k * 1.15) * Math.PI);
      reloadDrop = curve * 0.17;
      reloadRoll = curve * 0.55;
    }

    /* --- 발사 반동 (뒤로 밀리고 총구가 들린다) --- */
    this.vmRecoil = (this.vmRecoil || 0) * Math.max(0, 1 - dt * 13);
    const R = this.vmRecoil;

    /* --- 최종 위치 --- */
    this.vmHolder.position.set(
      _v1.x,
      _v1.y - reloadDrop - this.vmSprint * 0.09 - this.landKick * 0.07,
      _v1.z + R * 0.045
    );

    /* --- 회전 --- */
    _e1.copy(this.vmBase.rot);
    const adsRot = this.vmBase.adsRot;
    this.vmHolder.rotation.set(
      _e1.x + (adsRot.x - _e1.x) * A - R * 0.11 + this.landKick * 0.12,
      _e1.y + (adsRot.y - _e1.y) * A + this.vmSprint * 0.42,
      _e1.z + (adsRot.z - _e1.z) * A + reloadRoll + this.vmSprint * 0.30
    );

    /* --- 관성 흔들림: 시점을 홱 돌리면 총이 살짝 늦게 따라온다 ---
     *  이번 프레임에 시점이 얼마나 움직였는지를 보고 반대로 기울인다.      */
    const dYaw = shortestDelta(this._lastYaw ?? this.yaw, this.yaw);
    const dPitch = this.pitch - (this._lastPitch ?? this.pitch);
    this._lastYaw = this.yaw;
    this._lastPitch = this.pitch;

    const lagY = clampAbs(dYaw * 3.2, 0.16) * (1 - A * 0.7);
    const lagX = clampAbs(-dPitch * 2.6, 0.12) * (1 - A * 0.7);
    this.vmSway.rotation.y += (lagY - this.vmSway.rotation.y) * Math.min(1, dt * 9);
    this.vmSway.rotation.x += (lagX - this.vmSway.rotation.x) * Math.min(1, dt * 9);
    this.vmSway.position.x += (clampAbs(dYaw * 0.28, 0.02) - this.vmSway.position.x) * Math.min(1, dt * 9);
  }

  /* ======================================================================= *
   *  폭발물 해체 대상 찾기
   * ==================================================================== */
  _updateDefuse() {
    let best = null, bd = DEFUSE_RANGE;
    for (const s of BOMB_SITES) {
      const d = Math.hypot(this.pos.x - s.x, this.pos.z - s.z);
      if (d < bd) { bd = d; best = s; }
    }
    this.defuseTarget = best;
    this.defuseDistance = bd;
  }

  /* ======================================================================= *
   *  서버로 보낼 입력 상태
   * ==================================================================== */
  netState() {
    return {
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      yaw: this.yaw, pitch: this.pitch,
      moving: this.isMoving ? 1 : 0,
      sprint: this.isSprinting ? 1 : 0,
      crouch: this.crouch > 0.5 ? 1 : 0,
    };
  }

  /* ======================================================================= *
   *  뷰모델 렌더 (game.js 가 메인 씬 다음에 호출)
   * ==================================================================== */
  renderViewmodel(renderer) {
    if (!this.alive) return;
    this.viewCamera.aspect = this.camera.aspect;
    this.viewCamera.fov = 52 + (this.settings.fov - 74) * 0.25;
    this.viewCamera.updateProjectionMatrix();

    renderer.clearDepth();               // 메인 씬의 깊이를 지운다 = 총이 항상 앞에
    renderer.render(this.viewScene, this.viewCamera);
  }

  dispose() {
    this.viewScene.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m?.dispose?.();
      }
    });
  }
}

/* --- 재사용 임시 객체 (매 프레임 new 하면 GC 가 튄다) --- */
const _v1 = new THREE.Vector3();
const _e1 = new THREE.Euler();

/** -PI~PI 범위로 감싼 각도 차 */
function shortestDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function clampAbs(v, lim) { return Math.max(-lim, Math.min(lim, v)); }

/** 총구 섬광용 별 모양 텍스처 */
function makeFlareTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,252,228,1)');
  grad.addColorStop(0.22, 'rgba(255,196,96,0.8)');
  grad.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,232,186,0.6)';
  g.fillRect(30, 0, 4, 64);
  g.fillRect(0, 30, 64, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
