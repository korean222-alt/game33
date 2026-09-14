/* =============================================================================
 *  world.js  -  씬 구성 (지형 / 벽 / 천장 / 문 / 소품 / 조명 / 목표 표시)
 *
 *  map-data.js 의 데이터로만 그린다. 서버가 충돌 판정에 쓰는 것과 같은 데이터라
 *  "보이는 벽"과 "막히는 벽"이 항상 일치한다.
 *
 *  저택 안은 천장이 있고, 담장 안 바깥은 밤하늘이 보인다.
 * ========================================================================== */

import * as THREE from 'three';
import {
  MAP, WALLS, PROPS, LIGHTS, BOMB_SITES, FURNITURE, DOORWAYS, EXTRACTION,
} from './map-data.js';
import { DOOR, isBlocking } from './doors.js';
import { wallSections } from './wall-sections.js';
import { QUALITY } from './config.js';
import { roomMaterials, dressRoom } from './visuals.js';

/*
 * three r155 부터 조명이 물리 단위(칸델라)로 바뀌어서, map-data.js 의 intensity 값을
 * 그대로 쓰면 화면이 거의 까맣게 나온다. 맵 데이터는 서버와 공유하는 원본이라
 * 건드리지 않고, 그릴 때만 배율을 곱한다.
 */
const LIGHT_INTENSITY_SCALE = 4;
const DOOR_THICKNESS = 0.07;
/* 벽 꼭대기를 천장보다 이만큼 더 올려서 그린다.
 * 벽의 윗면(y = MAP.height)과 천장면(y = MAP.height)이 정확히 겹치면 깊이 값이
 * 같아져서, 카메라가 움직일 때마다 어느 쪽이 앞인지 뒤집히며 천장이 깨져 보인다
 * (z-fighting). 벽을 천장 위로 조금 더 올려 두 면이 겹치는 일 자체를 없앤다.
 * 충돌 판정은 map-data 의 원본 높이를 쓰므로 게임플레이는 그대로다. */
const CEILING_OVERLAP = 0.08;

export class World {
  constructor(renderer, assets) {
    this.renderer = renderer;
    this.assets = assets;
    this.scene = new THREE.Scene();
    this.pointLights = [];
    this.siteMarkers = new Map();   // siteId -> { group, ring, mat }
    this.evidenceMarkers = new Map();
    this.doorMeshes = new Map();    // doorId -> { pivot, leaf, state }
    this._t = 0;
  }

  build(qualityKey) {
    const q = QUALITY[qualityKey] || QUALITY.high;
    const s = this.scene;

    // 밤. 안개는 담장 밖을 가려 주기도 한다.
    s.background = new THREE.Color(0x0b1119);
    s.fog = new THREE.FogExp2(0x0d141d, Math.max(q.fogDensity, 0.012));
    this.materials = roomMaterials();

    this._buildShell();
    this._buildWalls();
    this._buildDoors();
    this._buildProps();
    this._buildFurniture();
    this._buildLights(q);
    this._buildSiteMarkers();
    this._buildExtraction();
    this.dust = dressRoom(s, this.renderer);

    return this;
  }

  /* ---- 지면 / 천장 ------------------------------------------------------ */
  _buildShell() {
    // 구역 전체 지면
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP.width, MAP.depth),
      new THREE.MeshStandardMaterial({ color: 0x25281f, roughness: 0.96 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 저택 내부 바닥 (콘크리트 텍스처)
    const i = MAP.interior;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(i.maxX - i.minX, i.maxZ - i.minZ),
      this.materials.floor,
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.02;
    const floorUV = floor.geometry.attributes.uv;
    for (let k = 0; k < floorUV.count; k++) {
      floorUV.setXY(k, floorUV.getX(k) * (i.maxX - i.minX) / 4, floorUV.getY(k) * (i.maxZ - i.minZ) / 4);
    }
    floor.receiveShadow = true;
    this.scene.add(floor);

    // 진입로 포장
    const drive = new THREE.Mesh(
      new THREE.PlaneGeometry(13, MAP.depth / 2 - 16),
      new THREE.MeshStandardMaterial({ color: 0x2c2d2c, roughness: 0.92 }),
    );
    drive.rotation.x = -Math.PI / 2;
    drive.position.set(0, 0.012, 26);
    drive.receiveShadow = true;
    this.scene.add(drive);

    // 저택 천장 (실내에만)
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(i.maxX - i.minX, i.maxZ - i.minZ),
      new THREE.MeshStandardMaterial({ color: MAP.ceilColor, roughness: .9 }),
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = MAP.height;
    this.scene.add(ceil);

    // 지붕 (밖에서 봤을 때 저택이 건물로 보이도록)
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(i.maxX - i.minX + 1.2, 0.6, i.maxZ - i.minZ + 1.2),
      new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: .85 }),
    );
    // 지붕 밑면은 천장(MAP.height)보다 20cm 위. 위로 늘린 벽 꼭대기보다도 높아서
    // 어느 면과도 같은 높이에 놓이지 않는다.
    roof.position.y = MAP.height + 0.5;
    roof.castShadow = true;
    this.scene.add(roof);

    // 별
    const starCount = 420;
    const stars = new Float32Array(starCount * 3);
    for (let k = 0; k < starCount; k++) {
      const a = Math.random() * Math.PI * 2, r = 60 + Math.random() * 30;
      stars[k * 3] = Math.cos(a) * r;
      stars[k * 3 + 1] = 18 + Math.random() * 40;
      stars[k * 3 + 2] = Math.sin(a) * r;
    }
    const starField = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(stars, 3)),
      new THREE.PointsMaterial({ color: 0xdfe8ff, size: 0.32, sizeAttenuation: true, depthWrite: false }),
    );
    this.scene.add(starField);
  }

  /* ---- 벽 --------------------------------------------------------------- */
  _buildWalls() {
    for (const w of WALLS) {
      const base = w.y || 0;
      // 상인방(문 위쪽 조각)과 담장은 띠 장식 없이 한 덩어리로 그린다.
      const bands = base > 0 || w.h < 3.4
        ? [{ bottom: base, top: base + w.h, material: base > 0 ? 'wall' : 'plaster' }]
        : wallSections(w.h).map((s) => ({ ...s }));
      const ceilingTop = Math.abs(base + w.h - MAP.height) < 0.001;
      if (ceilingTop) bands[bands.length - 1].top += CEILING_OVERLAP;
      for (const section of bands) {
        const height = section.top - section.bottom;
        if (height <= 0.001) continue;
        const geo = new THREE.BoxGeometry(w.w, height, w.d);
        const uv = geo.attributes.uv, n = geo.attributes.normal;
        for (let k = 0; k < uv.count; k++) {
          const width = Math.abs(n.getX(k)) > .5 ? w.d : w.w;
          const horizontal = Math.abs(n.getY(k)) > .5;
          uv.setXY(k, uv.getX(k) * width / 3,
            horizontal ? uv.getY(k) * w.d / 3 : (section.bottom + uv.getY(k) * height) / 3);
        }
        const mesh = new THREE.Mesh(geo, this.materials[section.material]);
        mesh.position.set(w.x, (section.bottom + section.top) / 2, w.z);
        mesh.castShadow = mesh.receiveShadow = true;
        this.scene.add(mesh);
      }
    }
  }

  /* ---- 문 --------------------------------------------------------------- */
  _buildDoors() {
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: .68 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a1f16, roughness: .7 });
    const knobMat = new THREE.MeshStandardMaterial({ color: 0xc3a46b, roughness: .3, metalness: .85 });

    for (const door of DOORWAYS) {
      // 경첩 축을 중심으로 도는 피벗. 회전은 보기용이고 충돌은 서버가 판정한다.
      const pivot = new THREE.Group();
      const width = door.span;
      const leaf = new THREE.Mesh(
        new THREE.BoxGeometry(width, MAP.doorHeight - 0.04, DOOR_THICKNESS), leafMat,
      );
      leaf.position.set(width / 2, (MAP.doorHeight - 0.04) / 2, 0);
      leaf.castShadow = leaf.receiveShadow = true;
      pivot.add(leaf);

      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), knobMat);
      knob.position.set(width - 0.16, 1.02, DOOR_THICKNESS);
      pivot.add(knob);

      // 문틀
      const frame = new THREE.Group();
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.09, MAP.doorHeight + 0.08, door.thickness + 0.04), frameMat,
        );
        post.position.set(side * (width / 2 + 0.045), (MAP.doorHeight + 0.08) / 2, 0);
        frame.add(post);
      }
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.18, 0.09, door.thickness + 0.04), frameMat,
      );
      head.position.y = MAP.doorHeight + 0.04;
      frame.add(head);

      const group = new THREE.Group();
      group.position.set(door.x, 0, door.z);
      group.rotation.y = door.axis === 'x' ? Math.PI / 2 : 0;
      // 경첩은 한쪽 끝. hinge 가 -1 이면 반대쪽에서 열린다.
      pivot.position.x = -door.hinge * width / 2;
      pivot.scale.x = door.hinge;
      group.add(frame, pivot);
      this.scene.add(group);
      this.doorMeshes.set(door.id, { group, pivot, angle: 0, target: 0, state: DOOR.CLOSED });
    }
  }

  /** 서버가 알려 준 문 상태를 반영한다. */
  setDoorState(id, state) {
    const entry = this.doorMeshes.get(id);
    if (!entry) return;
    entry.state = state;
    entry.target = isBlocking(state) ? 0 : Math.PI * 0.52;
    if (state === DOOR.DESTROYED) entry.target = Math.PI * 0.62;
    entry.pivot.visible = state !== DOOR.DESTROYED;
  }

  applyDoorStates(list) {
    for (const { id, state } of list) this.setDoorState(id, state);
  }

  _buildFurniture() {
    const materials = {
      wood: new THREE.MeshStandardMaterial({ color: 0x523829, roughness: .55 }),
      velvet: new THREE.MeshStandardMaterial({ color: 0x284b43, roughness: .95 }),
      stone: new THREE.MeshStandardMaterial({ color: 0xddd4be, roughness: .58 }),
      brass: new THREE.MeshStandardMaterial({ color: 0xc3a46b, roughness: .3, metalness: .8 }),
      hedge: new THREE.MeshStandardMaterial({ color: 0x1f3320, roughness: .98 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: .45, metalness: .7 }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x9fc0cc, roughness: .18, metalness: .1, transparent: true, opacity: .38,
      }),
    };
    for (const f of FURNITURE) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h, f.d), materials[f.material] || materials.wood);
      mesh.position.set(f.x, (f.y || 0) + f.h / 2, f.z);
      mesh.rotation.y = f.ry || 0;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.collider = f;
      this.scene.add(mesh);
    }
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
    // 밤이므로 전체 조명은 아주 낮게. 어둠 자체가 엄폐다.
    const ambient = new THREE.AmbientLight(0x2a3644, .5);
    ambient.layers.enable(1); this.scene.add(ambient);

    const moon = new THREE.HemisphereLight(0x4a6683, 0x1a1c17, .55);
    moon.layers.enable(1);
    this.scene.add(moon);

    const lights = LIGHTS.filter((L) => L.kind !== 'lamp').slice(0, q.pointLights)
      .concat(LIGHTS.filter((L) => L.kind === 'lamp'));
    for (const L of lights) {
      const light = new THREE.PointLight(L.color, L.intensity * LIGHT_INTENSITY_SCALE, L.distance, 2);
      light.position.set(L.x, L.y, L.z);
      light.layers.enable(1);
      this.scene.add(light);
      this.pointLights.push(light);

      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(L.kind === 'lamp' ? 0.09 : 0.055, 8, 6),
        new THREE.MeshBasicMaterial({ color: L.color }),
      );
      bulb.position.copy(light.position);
      this.scene.add(bulb);

      if (L.kind === 'lamp') {
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.07, 0.09, L.y, 8),
          new THREE.MeshStandardMaterial({ color: 0x23282c, roughness: .6, metalness: .5 }),
        );
        post.position.set(L.x, L.y / 2, L.z);
        post.castShadow = true;
        this.scene.add(post);
      }
    }

    // 달빛 대신 저택 전면을 비추는 하나의 그림자 광원
    const key = new THREE.SpotLight(0xbcd2e8, 260, 60, Math.PI * .42, .7, 2);
    key.position.set(6, 14, 28); key.target.position.set(0, 0, 6);
    key.castShadow = q.shadows; key.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    key.shadow.bias = -.0005; key.shadow.normalBias = .025;
    key.shadow.camera.near = .5; key.shadow.camera.far = 70;
    key.layers.enable(1); this.scene.add(key, key.target); this.keyLight = key;
  }

  /* ---- 목표 표시 -------------------------------------------------------- */
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

      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.3, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.7, metalness: 0.3 }),
      );
      box.position.y = 0.15;
      box.castShadow = true;
      group.add(box);

      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.032, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff3b28 }),
      );
      led.position.set(0, 0.31, 0);
      group.add(led);

      this.scene.add(group);
      this.siteMarkers.set(site.id, { group, ring, ringMat, led, defused: false });
    }
  }

  /** 증거 위치는 매 판 달라지므로 matchStart 때 만든다. */
  buildEvidence(list = []) {
    for (const marker of this.evidenceMarkers.values()) {
      this.scene.remove(marker.group);
      marker.mat.dispose();
    }
    this.evidenceMarkers.clear();
    for (const item of list) {
      const group = new THREE.Group();
      group.position.set(item.x, 0, item.z);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xb8c4a0, emissive: 0x4c5a3a, emissiveIntensity: 1.1, roughness: .6,
      });
      const bag = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.3), mat);
      bag.position.y = 0.08;
      bag.castShadow = true;
      group.add(bag);
      this.scene.add(group);
      this.evidenceMarkers.set(item.id, { group, mat, taken: false });
    }
  }

  setEvidenceTaken(id) {
    const marker = this.evidenceMarkers.get(id);
    if (!marker) return;
    marker.taken = true;
    marker.group.visible = false;
  }

  _buildExtraction() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x6f9b52, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(EXTRACTION.radius, 32), mat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(EXTRACTION.x, 0.03, EXTRACTION.z);
    disc.visible = false;
    this.scene.add(disc);
    this.extractionDisc = disc;
    this.extractionMat = mat;
  }

  setExtractionActive(on) {
    if (this.extractionDisc) this.extractionDisc.visible = !!on;
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
    for (const m of this.evidenceMarkers.values()) { m.taken = false; m.group.visible = true; }
    this.setExtractionActive(false);
    for (const entry of this.doorMeshes.values()) {
      entry.state = DOOR.CLOSED; entry.angle = entry.target = 0;
      entry.pivot.rotation.y = 0; entry.pivot.visible = true;
    }
  }

  update(dt) {
    this._t += dt;
    if (this.dust) this.dust.position.y = Math.sin(this._t * .12) * .08;

    // 문 여닫힘 보간
    for (const entry of this.doorMeshes.values()) {
      if (Math.abs(entry.angle - entry.target) < 0.002) continue;
      entry.angle += (entry.target - entry.angle) * Math.min(1, dt * 9);
      entry.pivot.rotation.y = entry.angle;
    }

    // 미해체 지점의 LED 를 깜빡여서 눈에 띄게
    const blink = (Math.sin(this._t * 5) + 1) * 0.5;
    for (const m of this.siteMarkers.values()) {
      if (m.defused) continue;
      m.ringMat.opacity = 0.35 + blink * 0.5;
      m.led.material.color.setRGB(0.35 + blink * 0.65, 0.08, 0.06);
    }
    for (const m of this.evidenceMarkers.values()) {
      if (m.taken) continue;
      m.mat.emissiveIntensity = 0.8 + blink * 0.8;
    }
    if (this.extractionMat) this.extractionMat.opacity = 0.14 + blink * 0.18;
  }
}
