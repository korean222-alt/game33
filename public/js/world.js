/* =============================================================================
 *  world.js  -  맵을 실제 3D 로 세운다
 *
 *  map-data.js 의 숫자 그대로 바닥/벽/천장을 만들고, PROPS 목록대로 GLB 를 심는다.
 *  ★ 충돌 판정은 map-data.js 가 하고, 여기는 "보이는 것" 만 담당한다.
 *    그래서 여기서 소품 위치를 마음대로 바꾸면 안 된다(눈과 몸이 따로 논다).
 *
 *  조명 설계 (리얼리즘)
 *    - 밝은 태양광은 없다. 실내이므로 전구 몇 개 + 아주 약한 환경광.
 *    - 그림자를 드리우는 건 "천장 메인 등" 하나(DirectionalLight)뿐이다.
 *      PointLight 마다 그림자를 켜면 모바일에서 즉사한다.
 *    - 나머지 전구는 그림자 없이 색감만 담당한다.
 * ========================================================================== */

import * as THREE from 'three';
import { MAP, WALLS, PROPS, LIGHTS, BOMB_SITES } from './map-data.js';

const TAU = Math.PI * 2;

/** 켜진 전구 수가 적을수록 환경광을 올린다 (0.55 ~ 1.25) */
function hemiFor(q) {
  const ratio = Math.min(1, q.pointLights / LIGHTS.length);
  return 0.55 + (1 - ratio) * 0.7;
}

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./assets.js').AssetManager} assets
   */
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;

    this.root = new THREE.Group();
    this.root.name = 'world';
    scene.add(this.root);

    this.pointLights = [];      // 품질 설정에 따라 켜고 끈다
    this.siteMarkers = new Map();
    this.sunLight = null;
    this.fog = null;
    this._lightFlickers = [];
    this._materials = [];       // dispose 용
  }

  /* ======================================================================= *
   *  전체 빌드
   * ==================================================================== */
  build(quality) {
    this._buildAtmosphere(quality);
    this._buildShell();
    this._buildLights(quality);
    this._buildProps();
    this._buildSiteMarkers();
    return this;
  }

  /* ----------------------------------------------------------------------
   *  안개 / 배경
   *  좁은 실내 + 먼지 낀 공기. 안개가 draw distance 도 자연스럽게 가려준다.
   * ------------------------------------------------------------------- */
  _buildAtmosphere(q) {
    this.scene.background = new THREE.Color(0x07070a);
    this.fog = new THREE.FogExp2(0x14110e, q.fogDensity);
    this.scene.fog = this.fog;
  }

  /* ----------------------------------------------------------------------
   *  바닥 / 벽 / 천장
   * ------------------------------------------------------------------- */
  _buildShell() {
    const { width, depth, height } = MAP;

    /* --- 바닥: 젖은 콘크리트 느낌 --- */
    const floorMat = new THREE.MeshStandardMaterial({
      color: MAP.floorColor,
      roughness: 0.82,
      metalness: 0.04,
    });
    floorMat.map = this._concreteTexture(0x3a352e, 0x22201c, 512);
    floorMat.map.repeat.set(width / 2.2, depth / 2.2);
    this._materials.push(floorMat);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.root.add(floor);

    /* --- 천장 --- */
    const ceilMat = new THREE.MeshStandardMaterial({
      color: MAP.ceilColor, roughness: 0.95, metalness: 0,
    });
    this._materials.push(ceilMat);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = height;
    this.root.add(ceil);

    /* --- 벽 --- */
    const wallTex = this._concreteTexture(0x4a443c, 0x2e2a25, 512);
    for (const w of WALLS) {
      // 벽마다 크기가 달라서 텍스처 반복 횟수도 달라야 한다.
      // (하나의 머티리얼을 공유하면 짧은 벽에서 무늬가 늘어나 보인다)
      const tex = wallTex.clone();
      tex.needsUpdate = true;
      tex.repeat.set(Math.max(w.w, w.d) / 2.4, w.h / 2.4);

      const mat = new THREE.MeshStandardMaterial({
        color: MAP.wallColor, roughness: 0.88, metalness: 0.02, map: tex,
      });
      this._materials.push(mat);

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.w, w.h, w.d), mat);
      mesh.position.set(w.x, w.h / 2, w.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }

    /* --- 문틀 (입구가 어디인지 눈에 띄게) --- */
    this._buildDoorFrames();
  }

  /** 벽에 난 구멍(출입구) 위에 인방(lintel)을 얹어서 문처럼 보이게 한다 */
  _buildDoorFrames() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1d1a16, roughness: 0.9 });
    this._materials.push(mat);
    const DOOR_H = 2.25;

    // [x, z, 폭, 가로문인가(=X 방향으로 뚫린 문)]
    const doors = [
      [0.0,   5.5,  3.0, true],   // 남쪽 정문
      [7.5,   0.0,  2.0, false],  // 동쪽 측면문
      [-2.0, -2.5,  2.0, true],   // 창고 서편 문
      [4.75, -2.5,  1.5, true],   // 창고 동편 문
      [-3.5,  3.0,  2.0, true],   // 홀 좌측 문
      [4.0,   3.0,  2.0, true],   // 홀 우측 문
    ];

    for (const [x, z, w, horiz] of doors) {
      const th = 0.32;
      const geo = horiz
        ? new THREE.BoxGeometry(w + 0.3, MAP.height - DOOR_H, th)
        : new THREE.BoxGeometry(th, MAP.height - DOOR_H, w + 0.3);
      const lintel = new THREE.Mesh(geo, mat);
      lintel.position.set(x, DOOR_H + (MAP.height - DOOR_H) / 2, z);
      lintel.castShadow = true;
      this.root.add(lintel);
    }
  }

  /* ----------------------------------------------------------------------
   *  조명
   * ------------------------------------------------------------------- */
  _buildLights(q) {
    /* --- 환경광: 아주 약하게. 이게 세면 실내가 아니라 야외처럼 보인다.
     *  단, 낮은 화질에서는 전구를 몇 개 꺼버리므로 그만큼 환경광을 올려서
     *  "화질을 낮췄더니 아무것도 안 보인다" 를 막는다.                      */
    const hemi = new THREE.HemisphereLight(0x505c72, 0x1a1510, hemiFor(q));
    this.scene.add(hemi);
    this.hemi = hemi;

    /* --- 그림자를 만드는 유일한 광원 ---
     * 천장 전체를 덮는 평행광. 실제 태양이 아니라 "천장 조명 뭉치" 로 취급한다.
     * 그림자 카메라를 맵 크기에 딱 맞춰야 해상도가 안 아깝다.            */
    const sun = new THREE.DirectionalLight(0xffd9ae, 1.05);
    sun.position.set(4.5, 9, 5.5);
    sun.target.position.set(-1, 0, -1);
    sun.castShadow = q.shadows;

    const half = Math.max(MAP.width, MAP.depth) * 0.62;
    sun.shadow.camera.left = -half;
    sun.shadow.camera.right = half;
    sun.shadow.camera.top = half;
    sun.shadow.camera.bottom = -half;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 30;
    sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.028;
    sun.shadow.radius = q.shadowRadius;

    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sunLight = sun;

    /* --- 전구들: 색감 담당, 그림자 없음 --- */
    LIGHTS.forEach((L, i) => {
      const light = new THREE.PointLight(L.color, L.intensity, L.distance, 2);
      light.position.set(L.x, L.y, L.z);
      light.castShadow = false;
      light.visible = i < q.pointLights;
      this.scene.add(light);
      this.pointLights.push(light);

      // 전구 알맹이 (빛나는 작은 구) - 광원 위치를 눈으로 알 수 있게
      const bulbMat = new THREE.MeshBasicMaterial({ color: L.color });
      this._materials.push(bulbMat);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), bulbMat);
      bulb.position.copy(light.position);
      this.root.add(bulb);

      // 전선
      const cordMat = new THREE.MeshBasicMaterial({ color: 0x0b0b0b });
      this._materials.push(cordMat);
      const cord = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.008, MAP.height - L.y, 4), cordMat
      );
      cord.position.set(L.x, (MAP.height + L.y) / 2, L.z);
      this.root.add(cord);

      // 몇 개는 깜빡이게 (긴장감)
      if (i === 3 || i === 6) {
        this._lightFlickers.push({ light, bulb, base: L.intensity, seed: Math.random() * 100 });
      }
    });
  }

  /* ----------------------------------------------------------------------
   *  소품 배치
   * ------------------------------------------------------------------- */
  _buildProps() {
    this.propRoot = new THREE.Group();
    this.propRoot.name = 'props';
    this.root.add(this.propRoot);

    for (const p of PROPS) {
      let obj;
      try {
        obj = this.assets.instance(p.model);
      } catch {
        continue;   // 로드 실패 - assets.js 가 이미 placeholder 를 만들어뒀어야 정상
      }

      // 모델 자체 보정(rotY)은 인스턴스 안에 이미 들어있다.
      // 여기서는 맵이 요구하는 회전만 "한 겹 더" 감싸서 적용한다.
      const holder = new THREE.Group();
      holder.add(obj);
      holder.position.set(p.x, p.yOff || 0, p.z);
      holder.rotation.y = p.ry || 0;
      const s = p.s ?? 1;
      if (s !== 1) holder.scale.setScalar(s);

      holder.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      this.propRoot.add(holder);
    }
  }

  /* ----------------------------------------------------------------------
   *  폭발물 표시 (목표 지점)
   *  멀리서도 보이게 빨간 점멸등 + 바닥 링
   * ------------------------------------------------------------------- */
  _buildSiteMarkers() {
    for (const site of BOMB_SITES) {
      const g = new THREE.Group();
      g.position.set(site.x, 0, site.z);

      // 바닥 링
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xff3b30, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false,
      });
      this._materials.push(ringMat);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.42, 1.6, 28), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      ring.raycast = () => {};     // 바닥 표시일 뿐이라 총알이 맞으면 안 된다
      g.add(ring);

      // 폭발물 본체 (간단한 케이스 + LED)
      const caseMat = new THREE.MeshStandardMaterial({
        color: 0x1f2228, roughness: 0.55, metalness: 0.45,
      });
      this._materials.push(caseMat);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.30, 0.30), caseMat);
      box.position.y = 0.15;
      box.castShadow = true;
      g.add(box);

      const ledMat = new THREE.MeshBasicMaterial({ color: 0xff2a20 });
      this._materials.push(ledMat);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), ledMat);
      led.position.set(0.13, 0.28, 0.16);
      g.add(led);

      const blink = new THREE.PointLight(0xff2a20, 2.2, 3.2, 2);
      blink.position.set(0, 0.35, 0);
      g.add(blink);

      // 머리 위 마커 (벽 너머로도 보이게 depthTest 끔)
      const markMat = new THREE.SpriteMaterial({
        map: this._labelTexture(site.id),
        depthTest: false, transparent: true, opacity: 0.92,
      });
      this._materials.push(markMat);
      const mark = new THREE.Sprite(markMat);
      mark.scale.set(0.55, 0.55, 1);
      mark.position.y = 1.55;
      mark.renderOrder = 999;
      mark.raycast = () => {};     // 총알 판정 제외
      g.add(mark);

      this.root.add(g);
      this.siteMarkers.set(site.id, { group: g, ring, led, blink, mark, ledMat, ringMat, defused: false });
    }
  }

  /**
   * 새 판을 시작할 때 목표 마커를 원래(빨강, 점멸) 상태로 되돌린다.
   * 이걸 안 하면 다시 하기를 눌렀을 때 이미 해체한 것처럼 초록으로 남는다.
   */
  resetSiteMarkers() {
    for (const m of this.siteMarkers.values()) {
      m.defused = false;
      m.ledMat.color.set(0xff2a20);
      m.ringMat.color.set(0xff3b30);
      m.ringMat.opacity = 0.5;
      m.blink.color.set(0xff2a20);
      m.blink.intensity = 2.6;
      m.led.visible = true;
      m.mark.visible = true;
      m.mark.material.opacity = 0.92;
    }
  }

  /** 해체 완료 -> 초록으로 바꾸고 점멸 정지 */
  setSiteDefused(id) {
    const m = this.siteMarkers.get(id);
    if (!m || m.defused) return;
    m.defused = true;
    m.ledMat.color.set(0x4fd1a1);
    m.ringMat.color.set(0x4fd1a1);
    m.ringMat.opacity = 0.28;
    m.blink.color.set(0x4fd1a1);
    m.blink.intensity = 1.0;
    m.mark.material.opacity = 0.4;
  }

  /* ----------------------------------------------------------------------
   *  매 프레임 갱신 (깜빡임 / 점멸등 / 목표 마커)
   *
   *  @param {number} t          초 단위 시간
   *  @param {THREE.Vector3} eye 카메라 위치 (마커 크기 조절에 쓴다)
   * ------------------------------------------------------------------- */
  update(t, eye = null) {
    // 형광등 깜빡임
    for (const f of this._lightFlickers) {
      const n = Math.sin(t * 37 + f.seed) * Math.sin(t * 11.3 + f.seed * 2);
      const flick = n > 0.86 ? 0.18 : 1;
      f.light.intensity = f.base * flick;
      f.bulb.visible = flick > 0.5;
    }
    // 폭발물 LED 점멸 + 머리 위 마커 크기 조절
    for (const m of this.siteMarkers.values()) {
      if (!m.defused) {
        const on = (t * 1.7) % 1 < 0.45;
        m.blink.intensity = on ? 2.6 : 0.25;
        m.led.visible = on;
      }

      /* --- 마커는 "멀리 있는 목표를 가리키는" 용도다 -------------------
       *  벽 너머로도 보이게 depthTest 를 껐기 때문에, 가까이 가면 화면을
       *  통째로 가려버린다. 그래서
       *    - 거리에 반비례해 크기를 줄여 화면상 크기를 일정하게 유지하고
       *    - 3m 안으로 들어오면 서서히 사라지게 한다 (이미 도착했으니 불필요)   */
      if (!eye) continue;
      const d = m.group.position.distanceTo(eye);
      const size = Math.min(0.55, 0.10 * d);          // 화면상 크기 고정
      m.mark.scale.set(size, size, 1);

      const near = Math.max(0, Math.min(1, (d - 1.4) / 1.8));   // 1.4m 이하면 완전 투명
      const base = m.defused ? 0.4 : 0.92;
      m.mark.material.opacity = base * near;
      m.mark.visible = near > 0.02;
    }
  }

  /* ----------------------------------------------------------------------
   *  품질 변경 반영
   * ------------------------------------------------------------------- */
  applyQuality(q) {
    if (this.fog) this.fog.density = q.fogDensity;
    if (this.sunLight) {
      this.sunLight.castShadow = q.shadows;
      this.sunLight.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      this.sunLight.shadow.radius = q.shadowRadius;
      // mapSize 를 바꾸면 기존 그림자 맵을 버려야 새 해상도가 적용된다
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
    this.pointLights.forEach((l, i) => { l.visible = i < q.pointLights; });
    if (this.hemi) this.hemi.intensity = hemiFor(q);
  }

  /* ======================================================================= *
   *  절차적 텍스처 (이미지 파일 없이 콘크리트 느낌)
   * ==================================================================== */
  _concreteTexture(light, dark, size = 256) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');

    g.fillStyle = '#' + dark.toString(16).padStart(6, '0');
    g.fillRect(0, 0, size, size);

    // 얼룩
    for (let i = 0; i < 220; i++) {
      const r = 6 + Math.random() * 48;
      const a = 0.03 + Math.random() * 0.07;
      g.fillStyle = `rgba(${(light >> 16) & 255},${(light >> 8) & 255},${light & 255},${a})`;
      g.beginPath();
      g.arc(Math.random() * size, Math.random() * size, r, 0, TAU);
      g.fill();
    }
    // 자잘한 알갱이
    const img = g.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 26;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _labelTexture(text) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(210,30,25,0.9)';
    g.beginPath(); g.arc(64, 64, 54, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 5;
    g.beginPath(); g.arc(64, 64, 54, 0, TAU); g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 68px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 64, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ----------------------------------------------------------------------
   *  정리 (다음 판을 위해)
   * ------------------------------------------------------------------- */
  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        o.geometry?.dispose?.();
      }
    });
    for (const m of this._materials) m.dispose?.();
    this.scene.remove(this.root);
    if (this.sunLight) { this.scene.remove(this.sunLight); this.scene.remove(this.sunLight.target); }
    if (this.hemi) this.scene.remove(this.hemi);
    for (const l of this.pointLights) this.scene.remove(l);
    this.pointLights.length = 0;
    this.siteMarkers.clear();
  }
}
