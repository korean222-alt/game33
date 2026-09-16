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
  MAP, BACKUP_GENERATOR, WALLS, PROPS, LIGHTS, BOMB_SITES, FURNITURE, DOORWAYS, EXTRACTION,
  SPRINKLERS,
} from './map-data.js';
import { DOOR, isBlocking, doorLeaves, DOOR_OPEN_ANGLE, DOOR_LEAF_THICKNESS } from './doors.js';
import { wallSections, OFFICE_BANDS } from './wall-sections.js';
import { QUALITY } from './config.js';
import { roomMaterials, dressRoom } from './visuals.js';

/*
 * three r155 부터 조명이 물리 단위(칸델라)로 바뀌어서, map-data.js 의 intensity 값을
 * 그대로 쓰면 화면이 거의 까맣게 나온다. 맵 데이터는 서버와 공유하는 원본이라
 * 건드리지 않고, 그릴 때만 배율을 곱한다.
 */
const LIGHT_INTENSITY_SCALE = 4;

/** 씬에서 떼어 낸 가지의 지오메트리·재질·텍스처를 놓아 준다. */
function disposeTree(root) {
  const seen = new Set();
  const free = (r) => { if (r && !seen.has(r)) { seen.add(r); r.dispose?.(); } };
  root.traverse((o) => {
    free(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      Object.values(m).filter((v) => v?.isTexture).forEach(free);
      free(m);
    }
  });
}
/* 벽 꼭대기를 천장보다 이만큼 더 올려서 그린다.
 * 벽의 윗면(y = MAP.height)과 천장면(y = MAP.height)이 정확히 겹치면 깊이 값이
 * 같아져서, 카메라가 움직일 때마다 어느 쪽이 앞인지 뒤집히며 천장이 깨져 보인다
 * (z-fighting). 벽을 천장 위로 조금 더 올려 두 면이 겹치는 일 자체를 없앤다.
 * 충돌 판정은 map-data 의 원본 높이를 쓰므로 게임플레이는 그대로다. */
const CEILING_OVERLAP = 0.08;

/* 스프링클러 물줄기. 구역 전체(92 x 16.5m)에 뿌리면 입자가 수만 개 필요하고
 * 정작 눈앞은 성기다. 카메라 둘레 7m 안에만 뿌린다 - 걸어 들어가면 그때부터
 * 앞이 뿌옇고, 구역 밖으로 나가면 뚝 그친다. */
const RAIN_COUNT = 1200;
const RAIN_REACH = 7;
const RAIN_LENGTH = 0.22;
const RAIN_SPEED = 8.5;

export class World {
  constructor(renderer, assets) {
    this.renderer = renderer;
    this.assets = assets;
    this.scene = new THREE.Scene();
    this.pointLights = [];
    this.siteMarkers = new Map();   // siteId -> { group, ring, mat }
    this.evidenceMarkers = new Map();
    this.doorMeshes = new Map();    // doorId -> { pivot, leaf, state }
    this.power = true;              // 저택 전기 (정전되면 실내등이 꺼진다)
    this.sprinklers = null;         // 스프링클러 구역 (사무실)
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
    this._buildGenerator();
    this._buildSprinklers();
    this._buildLights(q);
    this._buildSiteMarkers();
    this._buildExtraction();
    this.dust = dressRoom(s, this.renderer);

    return this;
  }

  /**
   * 맵이 바뀌었다. 씬을 비우고 같은 Scene 객체 위에 다시 짓는다.
   *
   *  Scene 을 새로 만들면 Entities·LocalPlayer·뷰모델이 전부 옛 씬을 붙잡고
   *  있어서 화면에서 사라진다. 그래서 그릇은 그대로 두고 내용물만 간다.
   *  카메라(와 거기 달린 총·손전등)는 게임이 씬에 넣어 둔 것이라 남긴다.
   *  모델 에셋은 assets 캐시에 있으므로 다시 받지 않는다 — 맵 교체가 로딩
   *  화면으로 돌아가지 않는 이유다.
   */
  rebuild(qualityKey) {
    const keep = this.scene.children.filter((o) => o.isCamera);
    for (const child of [...this.scene.children]) {
      if (keep.includes(child)) continue;
      this.scene.remove(child);
      disposeTree(child);
    }
    this.pointLights = [];
    this.siteMarkers.clear();
    this.evidenceMarkers.clear();
    this.doorMeshes.clear();
    this.power = true;
    this.torch = null;          // _buildLights 가 다시 만든다
    this.torchOn = false;
    this.generatorLever = null;
    this.generatorLamp = null;
    this.sprinklers = null;
    this.extraction = null;
    this.dust = null;
    this._t = 0;
    return this.build(qualityKey);
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
      /* 상인방(문 위 조각)과 담장은 띠 장식 없이 한 덩어리로 그린다.
       * 사무실에서 그 한 덩어리를 'wall'(벽돌)로 두면 문마다 벽돌 인방이
       * 얹힌 저택 복도가 된다 - 사무실은 같은 도장면으로 이어져야 한다. */
      const office = MAP.style === 'office';
      const solidMaterial = base > 0 ? (office ? 'plaster' : 'wall') : 'plaster';
      const bands = base > 0 || w.h < 3.4
        ? [{ bottom: base, top: base + w.h, material: solidMaterial }]
        : wallSections(w.h, office ? OFFICE_BANDS : undefined).map((s) => ({ ...s }));
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
        // Box end caps at adjacent bands/lintels are internal surfaces. Remove them
        // only when a neighbouring wall completely covers that face.
        const covered = (axis, sign) => {
          const size = axis === 'x' ? w.w : w.d;
          const plane = w[axis] + sign * size / 2;
          const otherAxis = axis === 'x' ? 'z' : 'x';
          const half = (axis === 'x' ? w.d : w.w) / 2;
          return WALLS.some(other => other !== w &&
            Math.abs(other[axis] - plane) <= (axis === 'x' ? other.w : other.d) / 2 + 1e-6 &&
            other[otherAxis] - (axis === 'x' ? other.d : other.w) / 2 <= w[otherAxis] - half + 1e-6 &&
            other[otherAxis] + (axis === 'x' ? other.d : other.w) / 2 >= w[otherAxis] + half - 1e-6 &&
            (other.y || 0) <= section.bottom + 1e-6 &&
            (other.y || 0) + other.h >= Math.min(section.top, MAP.height) - 1e-6);
        };
        const hiddenFaces = new Set();
        if (covered('x', 1)) hiddenFaces.add(0);
        if (covered('x', -1)) hiddenFaces.add(1);
        if (covered('z', 1)) hiddenFaces.add(4);
        if (covered('z', -1)) hiddenFaces.add(5);
        if (section.bottom > base) hiddenFaces.add(3);
        if (section.top < base + w.h) hiddenFaces.add(2);
        geo.groups = geo.groups.filter(g => !hiddenFaces.has(g.materialIndex));
        const material = this.materials[section.material];
        const mesh = new THREE.Mesh(geo, Array(6).fill(material));
        mesh.position.set(w.x, (section.bottom + section.top) / 2, w.z);
        mesh.castShadow = mesh.receiveShadow = true;
        this.scene.add(mesh);
      }
    }
  }

  /* ---- 문 --------------------------------------------------------------- */
  _buildDoors() {
    // 저택은 짙은 원목 + 놋쇠 손잡이, 사무실은 밝은 도장 문짝 + 알루미늄 레버.
    const office = MAP.style === 'office';
    const leafMat = new THREE.MeshStandardMaterial({
      color: office ? 0xb9b3a6 : 0x3b2a1e, roughness: office ? .5 : .68 });
    const frameMat = new THREE.MeshStandardMaterial({
      color: office ? 0x6f7276 : 0x2a1f16, roughness: office ? .45 : .7,
      metalness: office ? .5 : 0 });
    const knobMat = new THREE.MeshStandardMaterial({
      color: office ? 0xa8adb2 : 0xc3a46b, roughness: .3, metalness: .85 });

    for (const door of DOORWAYS) {
      /* 경첩 축을 중심으로 도는 피벗. 회전은 보기용이고 충돌은 서버가 판정한다.
       * 폭이 넓은 문은 두 짝으로 달린다 (doors.js 의 doorLeaves 가 정한다). */
      const leaves = doorLeaves(door).map((spec) => {
        const pivot = new THREE.Group();
        const leaf = new THREE.Mesh(
          new THREE.BoxGeometry(spec.width, MAP.doorHeight - 0.04, DOOR_LEAF_THICKNESS), leafMat,
        );
        leaf.position.set(spec.width / 2, (MAP.doorHeight - 0.04) / 2, 0);
        leaf.castShadow = leaf.receiveShadow = true;
        pivot.add(leaf);

        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), knobMat);
        knob.position.set(spec.width - 0.14, 1.02, DOOR_LEAF_THICKNESS);
        pivot.add(knob);

        // 경첩은 문틀에서 조금 안쪽. hinge 가 -1 이면 반대쪽에서 열린다.
        pivot.position.x = spec.offset;
        pivot.scale.x = spec.hinge;
        return pivot;
      });

      // 문틀
      const frame = new THREE.Group();
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.09, MAP.doorHeight, door.thickness + 0.08), frameMat,
        );
        post.position.set(side * (door.span / 2 + 0.045), MAP.doorHeight / 2, 0);
        frame.add(post);
      }
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(door.span + 0.18, 0.09, door.thickness + 0.08), frameMat,
      );
      head.position.y = MAP.doorHeight + 0.045;
      frame.add(head);

      const group = new THREE.Group();
      group.position.set(door.x, 0, door.z);
      group.rotation.y = door.axis === 'x' ? Math.PI / 2 : 0;
      group.add(frame, ...leaves);
      this.scene.add(group);
      this.doorMeshes.set(door.id, { group, leaves, angle: 0, target: 0, state: DOOR.CLOSED });
    }
  }

  /** 서버가 알려 준 문 상태를 반영한다. */
  setDoorState(id, state) {
    const entry = this.doorMeshes.get(id);
    if (!entry) return;
    entry.state = state;
    entry.target = isBlocking(state) ? 0 : DOOR_OPEN_ANGLE;
    const visible = !entry.peeking && state !== DOOR.DESTROYED;
    for (const leaf of entry.leaves) leaf.visible = visible;
  }

  applyDoorStates(list) {
    for (const { id, state } of list) this.setDoorState(id, state);
  }

  /**
   * 문틈으로 볼 때는 문짝을 잠깐 감춘다.
   *
   * 카메라가 문짝 바로 앞(26cm)에 붙기 때문에 그냥 두면 나무판만 화면에 가득
   * 찬다. 열쇠구멍 모양 마스크가 가장자리를 가려 주므로, 실제로 보이는 것은
   * 구멍만 한 크기다. 문 자체는 여전히 닫혀 있고 총알도 사람도 막는다.
   */
  setDoorPeek(id, on) {
    const entry = this.doorMeshes.get(id);
    if (!entry) return;
    entry.peeking = !!on;
    const visible = on ? false : entry.state !== DOOR.DESTROYED;
    for (const leaf of entry.leaves) leaf.visible = visible;
  }

  _buildFurniture() {
    const materials = {
      wood: new THREE.MeshStandardMaterial({ color: 0x523829, roughness: .55 }),
      velvet: new THREE.MeshStandardMaterial({ color: 0x284b43, roughness: .95 }),
      stone: new THREE.MeshStandardMaterial({ color: 0xddd4be, roughness: .58 }),
      brass: new THREE.MeshStandardMaterial({ color: 0xc3a46b, roughness: .3, metalness: .8 }),
      hedge: new THREE.MeshStandardMaterial({ color: 0x1f3320, roughness: .98 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: .45, metalness: .7 }),
      // 사무실 쪽 재질. 저택의 나무·벨벳만 있으면 사무 가구가 전부 고재로
      // 보인다 — 파티션도, 책상 상판도, 의자 등받이도.
      laminate: new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: .42 }),
      panel: new THREE.MeshStandardMaterial({ color: 0x5d6a72, roughness: .88 }),
      fabric: new THREE.MeshStandardMaterial({ color: 0x35424c, roughness: .97 }),
      carpet: new THREE.MeshStandardMaterial({ color: 0x33383c, roughness: 1 }),
      plastic: new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: .55 }),
      paint: new THREE.MeshStandardMaterial({ color: 0xb9c2c6, roughness: .8 }),
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

  setGeneratorState(started) {
    if (this.generatorLever) this.generatorLever.rotation.x = started ? -.65 : .65;
    this.generatorLamp?.material.color.setHex(started ? 0x61ef95 : 0xefb942);
  }

  _buildGenerator() {
    const gen = BACKUP_GENERATOR;
    // 정전이 없는 맵에는 예비 발전기도 없다.
    if (!gen) return;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(.55, .32, .06),
      new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: .65 }));
    panel.position.set(gen.x, .76, gen.z + gen.d / 2 + .035);
    this.scene.add(panel);
    this.generatorLever = new THREE.Mesh(new THREE.BoxGeometry(.08, .22, .08),
      new THREE.MeshStandardMaterial({ color: 0xe5ba44, metalness: .5, roughness: .4 }));
    this.generatorLever.position.set(gen.x, .76, gen.z + gen.d / 2 + .11);
    this.scene.add(this.generatorLever);
    this.generatorLamp = new THREE.Mesh(new THREE.SphereGeometry(.055, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xefb942 }));
    this.generatorLamp.position.set(gen.x + .18, .8, gen.z + gen.d / 2 + .08);
    this.scene.add(this.generatorLamp);
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101614'; ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = '#f2d780'; ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('예비 발전기 · BACKUP', 256, 59);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1.4, .26),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), side: THREE.DoubleSide }));
    label.position.set(gen.x, 1.3, gen.z + gen.d / 2);
    this.scene.add(label);
  }

  /* ---- 스프링클러 ---------------------------------------------------------
   *  천장의 헤드는 늘 보인다 (작은 놋쇠 꼭지). 물은 경보기를 당겨야 나온다.
   *
   *  비는 구역 전체(92 x 16.5m)에 뿌리지 않는다. 그 넓이를 다 채우려면 입자가
   *  수만 개 필요하고, 정작 눈앞은 여전히 성기다. 대신 카메라 둘레 12m 안에만
   *  뿌리고 구역 밖으로는 넘기지 않는다 - 걸어 들어가면 그 순간부터 앞이
   *  뿌옇고, 구역 경계를 넘는 순간 뚝 그친다.
   * ------------------------------------------------------------------------ */
  _buildSprinklers() {
    if (!SPRINKLERS.length) return;
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xb08a4a, roughness: 0.35, metalness: 0.8,
    });
    const stem = new THREE.CylinderGeometry(0.022, 0.022, 0.12, 6);
    const rose = new THREE.ConeGeometry(0.055, 0.05, 8);
    const zones = new Map();
    for (const zone of SPRINKLERS) {
      for (const [hx, hz] of zone.heads || []) {
        const head = new THREE.Group();
        const pipe = new THREE.Mesh(stem, headMat);
        pipe.position.y = MAP.height - 0.06;
        const cap = new THREE.Mesh(rose, headMat);
        cap.position.y = MAP.height - 0.14;
        cap.rotation.x = Math.PI;
        head.add(pipe, cap);
        head.position.set(hx, 0, hz);
        this.scene.add(head);
      }
      zones.set(zone.id, this._makeRain(zone));
    }
    this.sprinklers = { zones, active: new Set() };
  }

  /** 구역 하나의 빗줄기와 젖은 바닥. 꺼진 채로 만들어 둔다. */
  _makeRain(zone) {
    /* 점이 아니라 짧은 선분으로 그린다. 물방울을 점으로 찍으면 아무리 많이
     * 뿌려도 먼지처럼 보이고, 실제로 그렇게 보였다. 20cm 짜리 세로 선분
     * 1,200 개면 눈앞이 제대로 뿌옇다. */
    const position = new Float32Array(RAIN_COUNT * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    const drops = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0xc8dce8, transparent: true, opacity: 0.42, depthWrite: false,
    }));
    drops.frustumCulled = false;
    drops.visible = false;
    this.scene.add(drops);

    // 젖은 바닥. 구역 전체에 얇게 깔아 두고 반사만 올린다.
    const wet = new THREE.Mesh(
      new THREE.PlaneGeometry(zone.area.w, zone.area.d),
      new THREE.MeshStandardMaterial({
        color: 0x4b5e6b, roughness: 0.12, metalness: 0.35,
        transparent: true, opacity: 0, depthWrite: false,
      }),
    );
    wet.rotation.x = -Math.PI / 2;
    wet.position.set(zone.area.x, 0.045, zone.area.z);
    wet.visible = false;
    this.scene.add(wet);

    return { zone, drops, wet, seeded: false };
  }

  /** 서버가 알려 준 스프링클러 상태. */
  setSprinkler(id, on) {
    const entry = this.sprinklers?.zones.get(id);
    if (!entry) return;
    if (on) {
      this.sprinklers.active.add(id);
      entry.seeded = false;
      entry.drops.visible = true;
      entry.wet.visible = true;
    } else {
      this.sprinklers.active.delete(id);
      entry.drops.visible = false;
      entry.wet.visible = false;
      entry.wet.material.opacity = 0;
    }
  }

  clearSprinklers() {
    if (!this.sprinklers) return;
    for (const id of [...this.sprinklers.active]) this.setSprinkler(id, false);
  }

  /** 빗줄기를 한 프레임 굴린다. */
  _updateRain(dt, camera) {
    if (!this.sprinklers?.active.size || !camera) return;
    const top = MAP.height - 0.25;
    for (const id of this.sprinklers.active) {
      const entry = this.sprinklers.zones.get(id);
      const a = entry.zone.area;
      const eye = camera.position;
      // 카메라가 구역에서 멀면 그릴 필요가 없다 - 비는 눈앞에만 뿌린다.
      const near = Math.abs(eye.x - a.x) < a.w / 2 + RAIN_REACH
        && Math.abs(eye.z - a.z) < a.d / 2 + RAIN_REACH;
      entry.drops.visible = near;
      // 바닥이 젖어드는 데는 시간이 조금 걸린다.
      entry.wet.material.opacity = Math.min(0.3, entry.wet.material.opacity + dt * 0.25);
      if (!near) continue;
      const position = entry.drops.geometry.attributes.position;
      const array = position.array;
      /** 물줄기 하나를 카메라 둘레 아무 데나 다시 세운다. */
      const spawn = (i, y) => {
        const o = i * 6;
        const x = clampRange(eye.x + (Math.random() - 0.5) * RAIN_REACH * 2, a.x, a.w);
        const z = clampRange(eye.z + (Math.random() - 0.5) * RAIN_REACH * 2, a.z, a.d);
        array[o] = x; array[o + 1] = y; array[o + 2] = z;
        array[o + 3] = x; array[o + 4] = y - RAIN_LENGTH; array[o + 5] = z;
      };
      if (!entry.seeded) {
        for (let i = 0; i < RAIN_COUNT; i++) spawn(i, Math.random() * top);
        entry.seeded = true;
      }
      const fall = RAIN_SPEED * dt;
      for (let i = 0; i < RAIN_COUNT; i++) {
        const o = i * 6;
        const y = array[o + 1] - fall;
        if (y - RAIN_LENGTH < 0.02) spawn(i, top - Math.random() * 0.4);
        else { array[o + 1] = y; array[o + 4] = y - RAIN_LENGTH; }
      }
      position.needsUpdate = true;
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
  /*
   * 조명.
   *
   * 실제 광원(PointLight)은 기기가 감당할 수 있는 개수(q.pointLights)만 만든다.
   * 방이 17칸이라 등은 25개가 넘는데, 앞에서부터 몇 개만 켜면 저택 절반이
   * 늘 캄캄하다. 그래서 광원을 "자리"가 아니라 "묶음"으로 두고, 가까운 등
   * 몇 개에 번갈아 붙인다. 전구 알맹이(bulb)는 전부 만들어 둔다 - 멀리서
   * 보이는 것은 그 점이지 빛이 아니다.
   */
  _buildLights(q) {
    // 밤이므로 전체 조명은 아주 낮게. 어둠 자체가 엄폐다.
    this.ambient = new THREE.AmbientLight(0x2a3644, .5);
    this.ambient.layers.enable(1); this.scene.add(this.ambient);

    this.moon = new THREE.HemisphereLight(0x4a6683, 0x1a1c17, .55);
    this.moon.layers.enable(1);
    this.scene.add(this.moon);

    this.fixtures = [];
    for (const L of LIGHTS) {
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(L.kind === 'lamp' ? 0.09 : 0.055, 8, 6),
        new THREE.MeshBasicMaterial({ color: L.color }),
      );
      bulb.position.set(L.x, L.y, L.z);
      this.scene.add(bulb);
      this.fixtures.push({ def: L, bulb, on: true });

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

    // 실제 광원 묶음. 매 프레임 가까운 등에 다시 붙인다.
    const lampCount = LIGHTS.filter((L) => L.kind === 'lamp').length;
    this.lightPool = [];
    for (let i = 0; i < q.pointLights + Math.min(4, lampCount); i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, 2);
      light.layers.enable(1);
      this.scene.add(light);
      this.lightPool.push(light);
      this.pointLights.push(light);
    }
    this._lightAccum = 99;

    // 달빛 대신 저택 전면을 비추는 하나의 그림자 광원
    const key = new THREE.SpotLight(0xbcd2e8, 260, 80, Math.PI * .42, .7, 2);
    key.position.set(8, 18, 38); key.target.position.set(0, 0, 10);
    key.castShadow = q.shadows; key.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    key.shadow.bias = -.0005; key.shadow.normalBias = .025;
    key.shadow.camera.near = .5; key.shadow.camera.far = 95;
    key.layers.enable(1); this.scene.add(key, key.target); this.keyLight = key;

    /* 손전등.
     *
     * 카메라에 붙여 두고 켤 때만 밝기를 올린다. 총(뷰모델)보다 앞에서 쏘고,
     * 뷰모델 레이어(1)는 비워 둔다 - 안 그러면 총만 하얗게 타고 정작 복도는
     * 그대로 어둡다. */
    const torch = new THREE.SpotLight(0xfff1d6, 0, 32, Math.PI * 0.17, 0.5, 1.2);
    torch.position.set(0.2, -0.1, -0.5);
    torch.target.position.set(0.02, -0.04, -1.5);
    torch.add(torch.target);
    this.torch = torch;
    this.torchOn = false;
  }

  /** 손전등을 카메라에 붙인다 (플레이어가 만들어진 뒤에 부른다). */
  attachTorch(camera) {
    if (this.torch && this.torch.parent !== camera) camera.add(this.torch);
  }

  /** 손전등 켜기/끄기. */
  setTorch(on) {
    this.torchOn = !!on;
    if (this.torch) this.torch.intensity = this.torchOn ? 150 : 0;
  }

  /**
   * 저택 전기. 끊기면 실내등(chandelier)만 전부 꺼진다. 야외등은 담장 밖
   * 배선이라 그대로 켜져 있다 - 그래서 창밖은 어슴푸레하고 안은 캄캄하다.
   */
  setPower(on) {
    this.power = !!on;
    for (const fixture of this.fixtures) {
      if (fixture.def.kind === 'lamp') continue;
      fixture.on = this.power;
      fixture.bulb.visible = this.power;
    }
    /* 정전 중에는 전체 조명을 확 떨어뜨린다. 여기를 조금만 낮추면 "불이 꺼진 것
     * 같긴 한데 다 보이는" 어중간한 화면이 된다. 손전등이 필요해야 의미가 있다. */
    if (this.ambient) this.ambient.intensity = this.power ? 0.5 : 0.13;
    if (this.moon) this.moon.intensity = this.power ? 0.55 : 0.18;
    // 저택 전면을 비추던 광원은 달빛 몫만 남긴다.
    if (this.keyLight) this.keyLight.intensity = this.power ? 260 : 95;
    /* 이걸 빼먹으면 아무리 등을 꺼도 화면이 그대로 밝다. visuals.js 가 방 전체를
     * 은은하게 채우는 환경광(RoomEnvironment)을 깔아 두는데, 그게 실제로는 가장
     * 센 광원이기 때문이다. 정전이면 이것도 같이 내린다. */
    this.scene.environmentIntensity = this.power ? 0.5 : 0.08;
    this._lightAccum = 99;   // 다음 프레임에 바로 다시 배치한다
  }

  /**
   * 광원 묶음을 카메라에서 가까운 등에 다시 붙인다.
   * 매 프레임 할 필요는 없다(0.2초). 등끼리 멀리 떨어져 있어서 바뀌는 순간이
   * 화면에 잘 걸리지 않는다.
   */
  _updateLightPool(dt, camera) {
    this._lightAccum += dt;
    if (!camera || !this.lightPool?.length || this._lightAccum < 0.2) return;
    this._lightAccum = 0;
    const eye = camera.position;
    const near = this.fixtures
      .filter((f) => f.on)
      .map((f) => ({ f, d: Math.hypot(f.def.x - eye.x, f.def.z - eye.z) }))
      .filter((e) => e.d < e.f.def.distance + 14)
      .sort((a, b) => a.d - b.d)
      .slice(0, this.lightPool.length);
    this.lightPool.forEach((light, i) => {
      const entry = near[i];
      if (!entry) { light.intensity = 0; return; }
      const L = entry.f.def;
      light.position.set(L.x, L.y, L.z);
      light.color.set(L.color);
      light.distance = L.distance;
      light.intensity = L.intensity * LIGHT_INTENSITY_SCALE;
    });
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

  /**
   * 증거.
   *
   * 예전에는 바닥에 놓인 40cm 짜리 초록 상자 하나였다. 밤이고, 방은 넓고,
   * 가구는 많다. "장부를 회수하라"는 지시를 받고도 방을 몇 바퀴 돌게 된다.
   * 그래서 세 가지를 같이 세운다.
   *
   *   1) 무엇인지 알아볼 수 있는 물건  (장부는 책 더미, 드라이브는 작은 기기)
   *   2) 천장까지 올라가는 가느다란 빛기둥 — 방 문에서 보인다
   *   3) 이름표 — 가까이 가면 무엇을 어떻게 회수하는지 읽힌다
   *
   * 벽을 뚫고 보이지는 않는다. 방에 들어와야 보인다.
   */
  buildEvidence(list = []) {
    for (const marker of this.evidenceMarkers.values()) {
      this.scene.remove(marker.group);
      marker.mat.dispose();
      marker.beamMat.dispose();
      marker.label.material.map.dispose();
      marker.label.material.dispose();
    }
    this.evidenceMarkers.clear();

    for (const item of list) {
      const group = new THREE.Group();
      // 실내 바닥은 y=0.02 에 깔려 있다. 물건을 y=0 에 놓으면 밑동이 바닥에
      // 파묻혀 잘려 보인다.
      group.position.set(item.x, 0.025, item.z);

      const mat = new THREE.MeshStandardMaterial({
        color: 0xd8cfa8, emissive: 0xb8912f, emissiveIntensity: 1.1, roughness: .62,
      });
      for (const piece of evidenceShape(item.id)) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(piece.w, piece.h, piece.d),
          piece.plain
            ? new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: .8 })
            : mat,
        );
        mesh.position.set(piece.x || 0, piece.y, piece.z || 0);
        mesh.rotation.y = piece.ry || 0;
        mesh.castShadow = true;
        group.add(mesh);
      }

      // 빛기둥. 방 안 어디에서든 "저기에 뭔가 있다"가 보인다.
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xffd98a, transparent: true, opacity: 0.16,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.05, 2.6, 10, 1, true), beamMat);
      beam.position.y = 1.35;
      group.add(beam);

      const label = makeLabel(`${item.label}\nF 길게 눌러 회수`);
      label.position.y = 1.05;
      group.add(label);

      this.scene.add(group);
      this.evidenceMarkers.set(item.id, { group, mat, beam, beamMat, label, taken: false });
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
    this.clearSprinklers();
    for (const entry of this.doorMeshes.values()) {
      entry.state = DOOR.CLOSED; entry.angle = entry.target = 0;
      entry.peeking = false;
      for (const leaf of entry.leaves) { leaf.rotation.y = 0; leaf.visible = true; }
    }
  }

  update(dt, camera = null) {
    this._t += dt;
    if (this.dust) this.dust.position.y = Math.sin(this._t * .12) * .08;
    this._updateLightPool(dt, camera);
    this._updateRain(dt, camera);

    // 문 여닫힘 보간
    for (const entry of this.doorMeshes.values()) {
      if (Math.abs(entry.angle - entry.target) < 0.002) continue;
      entry.angle += (entry.target - entry.angle) * Math.min(1, dt * 9);
      for (const leaf of entry.leaves) leaf.rotation.y = entry.angle;
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
      m.beamMat.opacity = 0.1 + blink * 0.14;
      if (!camera) continue;
      m.label.quaternion.copy(camera.quaternion);
      // 이름표는 가까울 때만. 멀리서 글자가 떠 있으면 야간 작전의 긴장이 깨진다.
      m.label.visible = m.group.position.distanceTo(camera.position) < 9;
    }
    if (this.extractionMat) this.extractionMat.opacity = 0.14 + blink * 0.18;
  }
}

/* ========================================================================== *
 *  증거 물건의 생김새
 *
 *  "장부" 라고만 쓰여 있으면 무엇을 찾아야 하는지 모른다. 물건마다 다르게
 *  생기게 해서 화면만 보고도 알아볼 수 있게 한다. (단위: m)
 * ========================================================================== */
function evidenceShape(id) {
  switch (id) {
    case 'ledger':    // 거래 장부 - 책 세 권을 쌓았다
      return [
        { w: 0.34, h: 0.07, d: 0.26, y: 0.035 },
        { w: 0.32, h: 0.06, d: 0.24, y: 0.1, ry: 0.18 },
        { w: 0.3, h: 0.05, d: 0.23, y: 0.16, ry: -0.12 },
      ];
    case 'drive':     // 암호 드라이브 - 손바닥만 한 기기
      return [
        { w: 0.3, h: 0.05, d: 0.22, y: 0.025, plain: true },
        { w: 0.16, h: 0.08, d: 0.11, y: 0.09 },
      ];
    case 'radio':     // 무전 기록 - 무전기와 안테나
      return [
        { w: 0.18, h: 0.26, d: 0.12, y: 0.13, plain: true },
        { w: 0.02, h: 0.4, d: 0.02, y: 0.46 },
        { w: 0.22, h: 0.04, d: 0.16, y: 0.02 },
      ];
    case 'passport':  // 위조 여권 - 얇은 책자 여러 권
      return [
        { w: 0.13, h: 0.03, d: 0.18, y: 0.015 },
        { w: 0.13, h: 0.03, d: 0.18, y: 0.05, x: 0.05, ry: 0.4 },
        { w: 0.13, h: 0.03, d: 0.18, y: 0.085, x: -0.03, ry: -0.3 },
      ];
    case 'cash':      // 현금 가방
      return [
        { w: 0.46, h: 0.3, d: 0.18, y: 0.15, plain: true },
        { w: 0.2, h: 0.04, d: 0.03, y: 0.32 },
      ];
    default:          // 서류철 / 출입 기록
      return [
        { w: 0.28, h: 0.04, d: 0.36, y: 0.02, plain: true },
        { w: 0.24, h: 0.03, d: 0.32, y: 0.055 },
      ];
  }
}

/** 값을 [center - size/2, center + size/2] 안으로 접어 넣는다. */
function clampRange(value, center, size) {
  return Math.max(center - size / 2, Math.min(center + size / 2, value));
}

/** 두 줄까지 들어가는 작은 이름표 스프라이트. */
function makeLabel(text) {
  const lines = String(text).split('\n');
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const g = cv.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((line, i) => {
    const big = i === 0;
    g.font = `${big ? 'bold 44px' : '30px'} -apple-system, sans-serif`;
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(0,0,0,.88)';
    const y = lines.length === 1 ? 64 : 42 + i * 48;
    g.strokeText(line, 256, y);
    g.fillStyle = big ? '#ffdf9a' : '#dfe7e2';
    g.fillText(line, 256, y);
  });
  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: true,
  }));
  sprite.scale.set(1.3, 0.33, 1);
  sprite.renderOrder = 5;
  return sprite;
}

