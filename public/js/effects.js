/* =============================================================================
 *  effects.js  -  총구 화염 / 예광탄 / 탄착 / 피 / 탄피
 *
 *  모바일에서 제일 흔한 사고가 "이펙트 때문에 프레임이 떨어지는 것" 이다.
 *  그래서 여기는 전부 "미리 만들어두고 돌려쓰는" 풀(pool) 방식이다.
 *  새 오브젝트를 런타임에 만들지 않는다 = GC 멈춤이 없다.
 * ========================================================================== */

import * as THREE from 'three';
import { COMBAT } from './config.js';

const MAX_TRACERS = 28;
const MAX_IMPACTS = 26;
const MAX_SPARKS  = 90;
const MAX_DECALS  = 40;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'fx';
    scene.add(this.root);

    this._initTracers();
    this._initImpacts();
    this._initSparks();
    this._initDecals();
    this._initMuzzle();

    this.time = 0;
  }

  /* ======================================================================= *
   *  예광탄 - 가늘고 긴 사각형이 날아간다
   * ==================================================================== */
  _initTracers() {
    const geo = new THREE.CylinderGeometry(0.012, 0.012, 1, 4, 1, true);
    geo.translate(0, 0.5, 0);                 // 원점이 꼬리가 되게
    geo.rotateX(Math.PI / 2);                 // +Z 방향으로 눕힌다

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    this.tracerMat = mat;
    this.tracers = [];
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.root.add(m);
      this.tracers.push({ mesh: m, alive: false, t: 0, life: 0, from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0 });
    }
    this.tracerGeo = geo;
  }

  /**
   * 예광탄 발사
   * @param {THREE.Vector3} from  총구 위치
   * @param {THREE.Vector3} dir   정규화된 방향
   * @param {number} dist         날아갈 거리
   * @param {boolean} mine        내 총알이면 좀 더 작게(시야 방해 방지)
   */
  tracer(from, dir, dist, mine = false) {
    const t = this.tracers.find((x) => !x.alive) || this.tracers[0];
    t.alive = true;
    t.t = 0;
    t.from.copy(from);
    t.dir.copy(dir).normalize();
    t.dist = Math.min(dist, 90);
    t.life = Math.max(0.05, t.dist / COMBAT.tracerSpeed);
    t.mine = mine;
    t.mesh.visible = true;
  }

  /* ======================================================================= *
   *  총구 화염
   * ==================================================================== */
  _initMuzzle() {
    const g = new THREE.Group();

    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff0c0, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), coreMat);
    g.add(core);

    // 별 모양 섬광 (평면 2장 십자)
    const flareMat = new THREE.MeshBasicMaterial({
      map: this._flareTexture(), transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 2; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), flareMat);
      p.rotation.z = i * Math.PI / 2;
      g.add(p);
    }

    const light = new THREE.PointLight(0xffc070, 0, 5.5, 2);
    g.add(light);

    g.visible = false;
    g.renderOrder = 900;
    this.root.add(g);

    this.muzzle = { group: g, core, coreMat, flareMat, light, t: 0, on: false };
  }

  /** 총구 화염 번쩍 (world 좌표에 그린다) */
  flash(pos, quat) {
    const m = this.muzzle;
    m.group.position.copy(pos);
    if (quat) m.group.quaternion.copy(quat);
    m.group.visible = true;
    m.lightOnly = false;
    m.core.visible = true;
    for (const c of m.group.children) { if (c.isMesh) c.visible = true; }
    m.group.scale.setScalar(0.8 + Math.random() * 0.5);
    m.group.rotation.z = Math.random() * Math.PI;
    m.on = true;
    m.t = 0;
    m.light.intensity = 9;
  }

  /**
   * 섬광 그림 없이 "빛" 만 번쩍인다.
   * 내 총은 섬광을 뷰모델 씬에 그리므로(총에 딱 붙게), 주변을 밝히는 역할만
   * 메인 씬에서 맡는다.
   */
  flashLightOnly(pos) {
    const m = this.muzzle;
    m.group.position.copy(pos);
    m.group.visible = false;      // 그림은 안 보이게
    m.core.visible = false;
    m.on = true;
    m.t = 0;
    m.lightOnly = true;
    m.light.intensity = 9;
    // PointLight 는 group 에 붙어 있으므로 group 을 씬에 남겨두되 메시만 숨긴다
    m.group.visible = true;
    for (const c of m.group.children) {
      if (c.isMesh) c.visible = false;
    }
  }

  /* ======================================================================= *
   *  탄착 (먼지 튀김 + 불꽃)
   * ==================================================================== */
  _initImpacts() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xb9a184, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.impactMat = mat;
    this.impacts = [];
    const geo = new THREE.SphereGeometry(0.07, 5, 4);
    for (let i = 0; i < MAX_IMPACTS; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      this.root.add(m);
      this.impacts.push({ mesh: m, alive: false, t: 0, life: 0.26 });
    }
    this.impactGeo = geo;
  }

  _initSparks() {
    // 점 스프라이트 무리 하나로 전부 처리 (드로우콜 1개)
    const pos = new Float32Array(MAX_SPARKS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffb45a, size: 0.035, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.root.add(pts);

    this.sparks = {
      points: pts, geo, mat, attr: geo.attributes.position,
      vel: new Float32Array(MAX_SPARKS * 3),
      life: new Float32Array(MAX_SPARKS),
      next: 0,
    };
    // 안 쓰는 입자는 화면 밖으로
    for (let i = 0; i < MAX_SPARKS; i++) pos[i * 3 + 1] = -999;
  }

  /** 벽/바닥 탄착 */
  impact(point, normal, kind = 'concrete') {
    const it = this.impacts.find((x) => !x.alive) || this.impacts[0];
    it.alive = true; it.t = 0;
    it.mesh.position.copy(point);
    it.mesh.visible = true;
    it.mesh.scale.setScalar(0.6);

    // 불꽃 몇 개
    const n = kind === 'metal' ? 8 : 5;
    const s = this.sparks;
    for (let k = 0; k < n; k++) {
      const i = s.next; s.next = (s.next + 1) % MAX_SPARKS;
      s.attr.array[i * 3 + 0] = point.x;
      s.attr.array[i * 3 + 1] = point.y;
      s.attr.array[i * 3 + 2] = point.z;
      // 법선 방향으로 튄다 + 랜덤
      const sp = 1.6 + Math.random() * 2.6;
      s.vel[i * 3 + 0] = (normal.x + (Math.random() - 0.5) * 1.3) * sp;
      s.vel[i * 3 + 1] = (normal.y + Math.random() * 0.9) * sp;
      s.vel[i * 3 + 2] = (normal.z + (Math.random() - 0.5) * 1.3) * sp;
      s.life[i] = 0.28 + Math.random() * 0.22;
    }
    s.attr.needsUpdate = true;

    this._decal(point, normal);
  }

  /** 살점 튐 (빨간 입자) */
  blood(point) {
    const s = this.sparks;
    for (let k = 0; k < 7; k++) {
      const i = s.next; s.next = (s.next + 1) % MAX_SPARKS;
      s.attr.array[i * 3 + 0] = point.x;
      s.attr.array[i * 3 + 1] = point.y;
      s.attr.array[i * 3 + 2] = point.z;
      const sp = 1.0 + Math.random() * 1.8;
      s.vel[i * 3 + 0] = (Math.random() - 0.5) * sp;
      s.vel[i * 3 + 1] = (Math.random() * 0.7 + 0.2) * sp;
      s.vel[i * 3 + 2] = (Math.random() - 0.5) * sp;
      s.life[i] = 0.30 + Math.random() * 0.2;
    }
    s.attr.needsUpdate = true;

    // 붉은 구 하나
    const it = this.impacts.find((x) => !x.alive);
    if (it) {
      it.alive = true; it.t = 0;
      it.mesh.position.copy(point);
      it.mesh.visible = true;
      it.mesh.scale.setScalar(0.75);
    }
  }

  /* ======================================================================= *
   *  탄흔 (벽에 남는 자국)
   * ==================================================================== */
  _initDecals() {
    const tex = this._holeTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.85, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.decalMat = mat;
    this.decalGeo = new THREE.PlaneGeometry(0.14, 0.14);
    this.decals = [];
    for (let i = 0; i < MAX_DECALS; i++) {
      const m = new THREE.Mesh(this.decalGeo, mat);
      m.visible = false;
      this.root.add(m);
      this.decals.push(m);
    }
    this.decalNext = 0;
  }

  _decal(point, normal) {
    const m = this.decals[this.decalNext];
    this.decalNext = (this.decalNext + 1) % MAX_DECALS;
    m.position.copy(point).addScaledVector(normal, 0.012);
    m.lookAt(point.clone().add(normal));
    m.rotation.z = Math.random() * Math.PI;
    m.scale.setScalar(0.7 + Math.random() * 0.6);
    m.visible = true;
  }

  /* ======================================================================= *
   *  매 프레임
   * ==================================================================== */
  update(dt) {
    this.time += dt;

    /* --- 예광탄 --- */
    for (const t of this.tracers) {
      if (!t.alive) continue;
      t.t += dt;
      const k = t.t / t.life;
      if (k >= 1) { t.alive = false; t.mesh.visible = false; continue; }

      // 꼬리는 앞머리보다 조금 뒤에 있다 -> 길쭉한 선으로 보인다
      const head = k * t.dist;
      const tailLen = Math.min(head, t.mine ? 2.2 : 4.5);
      const tail = head - tailLen;

      t.mesh.position.copy(t.from).addScaledVector(t.dir, tail);
      t.mesh.lookAt(t.from.clone().addScaledVector(t.dir, head));
      t.mesh.scale.set(t.mine ? 0.7 : 1, t.mine ? 0.7 : 1, tailLen);
      t.mesh.material.opacity = 0.9 * (1 - k * 0.6);
    }

    /* --- 총구 화염 --- */
    const m = this.muzzle;
    if (m.on) {
      m.t += dt * 1000;
      const k = m.t / COMBAT.muzzleFlashMs;
      if (k >= 1) {
        m.on = false;
        m.group.visible = false;
        m.light.intensity = 0;
      } else {
        m.coreMat.opacity = 1 - k;
        m.flareMat.opacity = 1 - k;
        m.light.intensity = 9 * (1 - k);
      }
    }

    /* --- 탄착 구 --- */
    for (const it of this.impacts) {
      if (!it.alive) continue;
      it.t += dt;
      const k = it.t / it.life;
      if (k >= 1) { it.alive = false; it.mesh.visible = false; continue; }
      it.mesh.scale.setScalar(0.6 + k * 1.5);
    }
    this.impactMat.opacity = 0.75;

    /* --- 불꽃 입자 --- */
    const s = this.sparks;
    const arr = s.attr.array;
    let dirty = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (s.life[i] <= 0) continue;
      s.life[i] -= dt;
      if (s.life[i] <= 0) { arr[i * 3 + 1] = -999; dirty = true; continue; }
      s.vel[i * 3 + 1] -= 9.0 * dt;             // 중력
      arr[i * 3 + 0] += s.vel[i * 3 + 0] * dt;
      arr[i * 3 + 1] += s.vel[i * 3 + 1] * dt;
      arr[i * 3 + 2] += s.vel[i * 3 + 2] * dt;
      dirty = true;
    }
    if (dirty) s.attr.needsUpdate = true;
  }

  /* ======================================================================= *
   *  절차적 텍스처
   * ==================================================================== */
  _flareTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,250,220,1)');
    grad.addColorStop(0.25, 'rgba(255,190,90,0.75)');
    grad.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    // 십자 광선
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(255,230,180,0.55)';
    g.fillRect(30, 0, 4, 64);
    g.fillRect(0, 30, 64, 4);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _holeTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    // 바깥 먼지 링
    const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, 'rgba(20,16,12,0.95)');
    grad.addColorStop(0.45, 'rgba(60,52,42,0.5)');
    grad.addColorStop(1, 'rgba(90,80,66,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
    // 구멍
    g.fillStyle = 'rgba(8,6,4,0.98)';
    g.beginPath(); g.arc(32, 32, 7, 0, Math.PI * 2); g.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** 새 판 시작할 때 탄흔 지우기 */
  reset() {
    for (const m of this.decals) m.visible = false;
    for (const t of this.tracers) { t.alive = false; t.mesh.visible = false; }
    for (const i of this.impacts) { i.alive = false; i.mesh.visible = false; }
    const s = this.sparks;
    for (let i = 0; i < MAX_SPARKS; i++) { s.life[i] = 0; s.attr.array[i * 3 + 1] = -999; }
    s.attr.needsUpdate = true;
    this.muzzle.on = false;
    this.muzzle.group.visible = false;
    this.muzzle.light.intensity = 0;
  }

  dispose() {
    this.tracerGeo.dispose(); this.tracerMat.dispose();
    this.impactGeo.dispose(); this.impactMat.dispose();
    this.decalGeo.dispose(); this.decalMat.map?.dispose(); this.decalMat.dispose();
    this.sparks.geo.dispose(); this.sparks.mat.dispose();
    this.muzzle.coreMat.dispose();
    this.muzzle.flareMat.map?.dispose();
    this.muzzle.flareMat.dispose();
    this.scene.remove(this.root);
  }
}
