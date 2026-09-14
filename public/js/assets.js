/* =============================================================================
 *  assets.js  -  GLB 로더 + 없을 때 쓰는 placeholder 생성기
 *
 *  핵심 규칙
 *    - MODELS[key].url 을 GLTFLoader 로 불러온다.
 *    - 실패하면(404, 파싱 오류 등) 같은 크기의 기본 도형을 만들어 대신 쓴다.
 *      => GLB 파일을 안 넣어도 게임이 돌아가고, 넣으면 코드 수정 없이 바뀐다.
 *    - 모델은 전부 "발이 y=0 에 닿고, 중심이 원점" 이 되도록 이미 정규화되어 있다.
 * ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { MODELS } from './config.js';

/** 넣어 둔 역할별 캐릭터 모델 목록. 없으면 전부 기본 캐릭터를 쓴다. */
const ROLE_MANIFEST = '/assets/models/roles.json';

export class AssetManager {
  constructor(renderer) {
    this.loader = new GLTFLoader();
    this.cache = new Map();      // key -> { scene, animations, isPlaceholder }
    this.renderer = renderer;
    this.maxAnisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
    this.anisotropy = 4;
    this.missing = [];           // placeholder 로 대체된 목록 (콘솔에 알려주려고)
  }

  setAnisotropy(v) { this.anisotropy = Math.min(v, this.maxAnisotropy); }

  /**
   * 전체 모델을 병렬로 불러온다. onProgress(loaded, total, key)
   *
   * 선택 모델(역할별 캐릭터)은 목록 파일에 적힌 것만 불러온다. 없는 파일을
   * 일단 요청해 보면 브라우저 콘솔이 404 로 더러워지고, 느린 연결에서는
   * 로딩이 그만큼 늦어진다.
   */
  async loadAll(keys = null, onProgress = null) {
    if (!keys) keys = await this._availableKeys();
    let done = 0;
    const total = keys.length;
    await Promise.all(keys.map(async (key) => {
      await this.load(key);
      done++;
      onProgress?.(done, total, key);
    }));
    if (this.missing.length) {
      console.warn(
        `[assets] GLB 파일이 없어서 임시 도형으로 대체함: ${this.missing.join(', ')}\n` +
        `  -> public/assets/models/ 에 파일을 넣으면 자동으로 바뀝니다.`
      );
    }
    return this.cache;
  }

  /** 실제로 불러올 모델 키 목록 (넣지 않은 역할별 모델은 뺀다). */
  async _availableKeys() {
    const optional = Object.keys(MODELS).filter((key) => MODELS[key].optional);
    if (!optional.length) return Object.keys(MODELS);
    let present = [];
    try {
      const response = await fetch(ROLE_MANIFEST, { cache: 'no-cache' });
      if (response.ok) present = (await response.json()).present || [];
    } catch { /* 목록이 없으면 역할별 모델을 쓰지 않는다 */ }
    // 목록에 없는 선택 모델은 기본 캐릭터로 바로 연결해 둔다.
    for (const key of optional) {
      if (present.includes(key)) continue;
      this.cache.set(key, { fallback: MODELS[key].fallback || 'character', animations: [], isPlaceholder: false });
    }
    return Object.keys(MODELS).filter((key) => !MODELS[key].optional || present.includes(key));
  }

  async load(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const def = MODELS[key];
    if (!def) throw new Error(`[assets] 알 수 없는 모델 키: ${key}`);

    let entry;
    try {
      const gltf = await this.loader.loadAsync(def.url);
      // Keep source transforms under a wrapper: placement and viewmodel rotation
      // must never overwrite the authoring-tool axis conversion.
      const model = gltf.scene;
      const root = new THREE.Group();
      root.add(model);
      if (def.rotation) model.rotation.set(...def.rotation);
      root.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(root, true);
      const size = bounds.getSize(new THREE.Vector3());
      if (!Number.isFinite(size.length()) || size.length() <= 0) throw new Error('Empty model bounds');
      const target = def.fit;
      if (target) {
        if (target.size) model.scale.multiply(new THREE.Vector3(...target.size).divide(size));
        else model.scale.multiplyScalar(target.height ? target.height / size.y : target.length / size.x);
        root.updateMatrixWorld(true);
        bounds.setFromObject(root, true);
        const center = bounds.getCenter(new THREE.Vector3());
        model.position.sub(new THREE.Vector3(center.x, target.center ? center.y : bounds.min.y, center.z));
      }
      root.scale.multiplyScalar(def.scale ?? 1);
      if (def.rotY) root.rotation.y = def.rotY;
      this._prepare(root);
      entry = { scene: root, animations: gltf.animations || [], isPlaceholder: false };
    } catch (err) {
      // 선택 모델(역할별 캐릭터 등)은 없는 것이 정상이다. 기본 모델로 넘긴다.
      if (def.optional) {
        const entry = { fallback: def.fallback || null, animations: [], isPlaceholder: false };
        this.cache.set(key, entry);
        return entry;
      }
      this.missing.push(key);
      console.error(`[assets] ${key}: ${def.url}`, err);
      const root = makePlaceholder(def.placeholder || { type: 'box', w: 1, h: 1, d: 1, color: 0x888888 });
      root.scale.multiplyScalar(def.scale ?? 1);
      if (def.rotY) root.rotation.y = def.rotY;
      this._prepare(root);
      entry = { scene: root, animations: [], isPlaceholder: true };
    }

    this.cache.set(key, entry);
    return entry;
  }

  /** 머티리얼/그림자/텍스처 필터 정리 */
  _prepare(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = true;

      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        // 실내 리얼리즘: 너무 반짝이지 않게
        if (m.metalness !== undefined && m.metalness > 0.85) m.metalness = 0.85;
        if (m.roughness !== undefined && m.roughness < 0.18) m.roughness = 0.18;
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
          const tex = m[slot];
          if (tex && tex.isTexture) {
            tex.anisotropy = this.anisotropy;
            tex.needsUpdate = true;
          }
        }
      }
    });
  }

  /**
   * 인스턴스 하나 만들기.
   * 스킨(뼈대)이 있으면 SkeletonUtils.clone 으로 복제해야 각자 따로 움직인다.
   */
  /**
   * 실제로 그릴 모델 키. 선택 모델이 없으면 기본 모델로 내려간다.
   * (인질 모델만 넣었을 때 대원·용의자는 기존 모델을 그대로 쓰게 하는 장치)
   */
  resolve(key, depth = 0) {
    const entry = this.cache.get(key);
    if (!entry?.fallback || depth > 4) return key;
    return this.resolve(entry.fallback, depth + 1);
  }

  /** 이 키가 자기 모델 파일을 갖고 있는가 (기본 모델로 내려가지 않았는가). */
  hasOwnModel(key) {
    return this.resolve(key) === key && !this.isPlaceholder(key);
  }

  instance(key, { skinned = false, materials = false } = {}) {
    const entry = this.cache.get(this.resolve(key));
    if (!entry?.scene) throw new Error(`[assets] ${key} 가 아직 로드되지 않음`);
    const obj = skinned ? skeletonClone(entry.scene) : entry.scene.clone(true);
    if (materials) obj.traverse(o => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
    });
    obj.userData.isPlaceholder = entry.isPlaceholder;
    return obj;
  }

  isPlaceholder(key) {
    return this.cache.get(this.resolve(key))?.isPlaceholder ?? true;
  }

  /** GLB 에 들어 있는 애니메이션 클립 목록 (없으면 빈 배열). */
  animations(key) {
    const entry = this.cache.get(key);
    // 역할별 모델에는 동작이 없을 수 있다. 그때는 기본 캐릭터의 동작을 쓴다.
    if (entry?.animations?.length) return entry.animations;
    const base = this.cache.get(this.resolve(key));
    return base?.animations ?? [];
  }
}

/* ========================================================================== *
 *  Placeholder 생성기 - GLB 가 없을 때 최소한 게임이 되도록
 * ========================================================================== */
function mat(color, rough = 0.85, metal = 0.05) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

export function makePlaceholder(def) {
  const g = new THREE.Group();

  switch (def.type) {
    /* --- 단순 박스 (상자 등) --- */
    case 'box': {
      const m = new THREE.Mesh(new THREE.BoxGeometry(def.w, def.h, def.d), mat(def.color));
      m.position.y = def.h / 2;
      g.add(m);
      break;
    }

    /* --- 원기둥 (드럼통, 항아리) --- */
    case 'cylinder': {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(def.r * 0.92, def.r, def.h, 12), mat(def.color));
      m.position.y = def.h / 2;
      g.add(m);
      break;
    }

    /* --- 매대: 다리 + 상판 + 천막 --- */
    case 'stall': {
      const legMat = mat(0x5a4a33);
      const topMat = mat(def.color);
      const tarpMat = new THREE.MeshStandardMaterial({
        color: 0x8e3b32, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
      });
      const tableH = Math.min(0.95, def.h * 0.5);
      const legR = 0.05;
      const hx = def.w / 2 - 0.15, hz = def.d / 2 - 0.15;
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(legR * 2, tableH, legR * 2), legMat);
        leg.position.set(sx * hx, tableH / 2, sz * hz);
        g.add(leg);
        const post = new THREE.Mesh(new THREE.BoxGeometry(legR * 1.6, def.h, legR * 1.6), legMat);
        post.position.set(sx * hx, def.h / 2, sz * hz);
        g.add(post);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(def.w, 0.08, def.d), topMat);
      top.position.y = tableH;
      g.add(top);

      const tarp = new THREE.Mesh(new THREE.BoxGeometry(def.w + 0.3, 0.06, def.d + 0.3), tarpMat);
      tarp.position.y = def.h;
      tarp.rotation.z = 0.04;
      g.add(tarp);

      // 매대 위 잡화
      for (let i = 0; i < 5; i++) {
        const s = 0.12 + Math.random() * 0.1;
        const box = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat(0x6e7a4a + i * 0x050300));
        box.position.set(
          (Math.random() - 0.5) * (def.w - 0.5), tableH + s / 2 + 0.04,
          (Math.random() - 0.5) * (def.d - 0.5)
        );
        box.rotation.y = Math.random() * Math.PI;
        g.add(box);
      }
      break;
    }

    /* --- 사람 (팀원/적) --- */
    case 'humanoid': {
      const bodyMat = mat(def.color, 0.9, 0.05);
      const skinMat = mat(0x8c6b4f, 0.9, 0);
      const h = def.h;
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, h * 0.36, 0.24), bodyMat);
      torso.position.y = h * 0.60;
      torso.name = 'torso';
      g.add(torso);

      const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 0.2), skinMat);
      head.position.y = h * 0.90;
      head.name = 'head_02';
      g.add(head);

      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.11, h * 0.32, 0.12), bodyMat);
        arm.position.set(side * 0.27, h * 0.60, 0);
        arm.name = side < 0 ? 'left_arm_03' : 'right_arm_06';
        g.add(arm);

        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, h * 0.42, 0.15), mat(0x3b3f33));
        leg.position.set(side * 0.11, h * 0.21, 0);
        leg.name = side < 0 ? 'left_leg_09' : 'right_leg_012';
        g.add(leg);
      }
      break;
    }

    /* --- 총 --- */
    case 'gun': {
      const L = def.len;
      const body = new THREE.Mesh(new THREE.BoxGeometry(L * 0.62, 0.085, 0.055), mat(def.color, 0.5, 0.6));
      body.position.set(L * 0.05, 0, 0);
      g.add(body);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, L * 0.42, 8), mat(0x1b1b1e, 0.4, 0.8));
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(L * 0.45, 0.005, 0);
      g.add(barrel);

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.04), mat(0x24242a, 0.6, 0.4));
      mag.position.set(L * 0.02, -0.12, 0);
      mag.rotation.z = 0.12;
      g.add(mag);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(L * 0.26, 0.10, 0.05), mat(0x26262b, 0.7, 0.3));
      stock.position.set(-L * 0.36, -0.02, 0);
      g.add(stock);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.05), mat(0x1e1e22, 0.8, 0.2));
      grip.position.set(-L * 0.12, -0.10, 0);
      grip.rotation.z = -0.22;
      g.add(grip);

      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.045, 0.035), mat(0x121216, 0.5, 0.6));
      sight.position.set(L * 0.10, 0.068, 0);
      g.add(sight);
      break;
    }

    default: {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(0xaa00aa));
      m.position.y = 0.5;
      g.add(m);
    }
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
