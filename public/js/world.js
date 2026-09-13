/* =============================================================================
 *  world.js  -  씬 구성 (바닥 / 벽 / 천장 / 소품 / 조명)
 *
 *  map-data.js 의 데이터로만 그린다. 서버가 충돌 판정에 쓰는 것과 같은 데이터라
 *  "보이는 벽"과 "막히는 벽"이 항상 일치한다.
 * ========================================================================== */

import * as THREE from 'three';
import { MAP, WALLS, PROPS, LIGHTS, BOMB_SITES } from './map-data.js';
import { QUALITY } from './config.js';

/*
 * three r155 부터 조명이 물리 단위(칸델라)로 바뀌어서, map-data.js 의 intensity 값을
 * 그대로 쓰면 화면이 거의 까맣게 나온다(측정: 평균 밝기 24/255). 맵 데이터는 서버와
 * 공유하는 원본이라 건드리지 않고, 그릴 때만 배율을 곱한다.
 */
const LIGHT_INTENSITY_SCALE = 4;

export class World {
  constructor(renderer, assets) {
    this.renderer = renderer;
    this.assets = assets;
    this.scene = new THREE.Scene();
    this.pointLights = [];
    this.siteMarkers = new Map();   // siteId -> { group, ring, mat }
    this._t = 0;
  }

  build(qualityKey) {
    const q = QUALITY[qualityKey] || QUALITY.high;
    const s = this.scene;

    s.background = new THREE.Color(0x0b0a08);
    s.fog = new THREE.FogExp2(0x0b0a08, q.fogDensity);

    this._buildShell();
    this._buildWalls();
    this._buildProps();
    this._buildLights(q);
    this._buildSiteMarkers();

    return this;
  }

  /* ---- 바닥 / 천장 ------------------------------------------------------ */
  _buildShell() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP.width, MAP.depth),
      new THREE.MeshStandardMaterial({ color: MAP.floorColor, roughness: 0.95, metalness: 0.03 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP.width, MAP.depth),
      new THREE.MeshStandardMaterial({ color: MAP.ceilColor, roughness: 1 }),
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = MAP.height;
    this.scene.add(ceil);
  }

  /* ---- 벽 --------------------------------------------------------------- */
  _buildWalls() {
    const matWall = new THREE.MeshStandardMaterial({
      color: MAP.wallColor, roughness: 0.92, metalness: 0.04,
    });
    // 벽은 전부 같은 머티리얼 + 박스라 인스턴싱으로 드로우콜을 1개로 줄인다.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, matWall, WALLS.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    WALLS.forEach((w, i) => {
      m.compose(
        new THREE.Vector3(w.x, w.h / 2, w.z),
        new THREE.Quaternion(),
        new THREE.Vector3(w.w, w.h, w.d),
      );
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  /* ---- 소품 (GLB, 없으면 placeholder) ----------------------------------- */
  _buildProps() {
    for (const p of PROPS) {
      let obj;
      try {
        obj = this.assets.instance(p.model);
      } catch {
        continue; // 로드 실패한 모델은 건너뛴다 (AssetManager 가 이미 경고함)
      }
      obj.position.set(p.x, p.yOff || 0, p.z);
      obj.rotation.y = p.ry || 0;
      if (p.s && p.s !== 1) obj.scale.multiplyScalar(p.s);
      this.scene.add(obj);
    }
  }

  /* ---- 조명 ------------------------------------------------------------- */
  _buildLights(q) {
    this.scene.add(new THREE.AmbientLight(0x30302c, 0.55));

    const hemi = new THREE.HemisphereLight(0x4a4438, 0x14120e, 0.5);
    this.scene.add(hemi);

    // 천장 전구. 품질에 따라 개수를 줄이고, 가장 밝은 것 하나만 그림자를 만든다.
    const lights = LIGHTS.slice(0, q.pointLights);
    let shadowGiven = false;
    for (const L of lights) {
      const light = new THREE.PointLight(
        L.color, L.intensity * LIGHT_INTENSITY_SCALE, L.distance, 2,
      );
      light.position.set(L.x, L.y, L.z);
      if (q.shadows && !shadowGiven) {
        light.castShadow = true;
        light.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
        light.shadow.radius = q.shadowRadius;
        light.shadow.bias = -0.004;
        light.shadow.camera.far = 14;
        shadowGiven = true;
      }
      this.scene.add(light);
      this.pointLights.push(light);

      // 전구 알맹이 (보이는 광원)
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 8, 6),
        new THREE.MeshBasicMaterial({ color: L.color }),
      );
      bulb.position.copy(light.position);
      this.scene.add(bulb);
    }
  }

  /* ---- 폭발물 지점 표시 -------------------------------------------------- */
  _buildSiteMarkers() {
    for (const site of BOMB_SITES) {
      const group = new THREE.Group();
      group.position.set(site.x, 0.02, site.z);

      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xd8a24a, transparent: true, opacity: 0.75, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 28), ringMat);
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);

      // 폭발물 본체
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.24, 0.24),
        new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.7, metalness: 0.3 }),
      );
      box.position.y = 0.12;
      box.castShadow = true;
      group.add(box);

      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.032, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff3b28 }),
      );
      led.position.set(0, 0.25, 0);
      group.add(led);

      this.scene.add(group);
      this.siteMarkers.set(site.id, { group, ring, ringMat, led, defused: false });
    }
  }

  /** 해체 완료된 지점은 초록으로 바꾼다 */
  setSiteDefused(id) {
    const m = this.siteMarkers.get(id);
    if (!m) return;
    m.defused = true;
    m.ringMat.color.set(0x6f9b52);
    m.led.material.color.set(0x6f9b52);
  }

  /** 매치 재시작 시 표시 초기화 */
  resetSites() {
    for (const m of this.siteMarkers.values()) {
      m.defused = false;
      m.ringMat.color.set(0xd8a24a);
      m.led.material.color.set(0xff3b28);
    }
  }

  update(dt) {
    this._t += dt;
    // 미해체 지점의 LED 를 깜빡여서 눈에 띄게
    const blink = (Math.sin(this._t * 5) + 1) * 0.5;
    for (const m of this.siteMarkers.values()) {
      if (m.defused) continue;
      m.ringMat.opacity = 0.35 + blink * 0.5;
      m.led.material.color.setRGB(0.35 + blink * 0.65, 0.08, 0.06);
    }
  }
}
