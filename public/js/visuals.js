import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { QUALITY } from './config.js';
import { MAP, LIGHTS } from './map-data.js';
import { roomSigns, roomRugs, exteriorWindows, grandHallArt, estatePlaque, WINDOW, ART } from './decor-layout.js';

export function roomMaterials() {
  const loader = new THREE.TextureLoader();
  const tex = (file, color = false) => {
    const t = loader.load('/assets/textures/' + file);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return {
    plaster: new THREE.MeshStandardMaterial({ color: 0xe8dfca, roughness: .82 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xbfa16b, roughness: .3, metalness: .8 }),
    floor: new THREE.MeshStandardMaterial({
      map: tex('concrete-color.jpg', true), normalMap: tex('concrete-normal.jpg'),
      normalScale: new THREE.Vector2(.65,.65), roughnessMap: tex('concrete-rough.jpg'),
      roughness: .85, metalness: 0,
    }),
    wall: new THREE.MeshStandardMaterial({
      map: tex('brick-color.jpg', true), normalMap: tex('brick-normal.jpg'),
      normalScale: new THREE.Vector2(.55,.55), roughness: .88, metalness: 0,
    }),
  };
}

function sign(scene, text, caption, x, y, z, color, width = 2.2, rotation = 0) {
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256;
  const g = cv.getContext('2d'); g.fillStyle = '#081419'; g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = color; g.lineWidth = 10; g.strokeRect(8, 8, 1008, 240);
  g.textAlign = 'center'; g.fillStyle = color; g.font = 'bold 90px sans-serif'; g.fillText(text, 512, 124);
  g.fillStyle = '#b8cdd2'; g.font = '27px sans-serif'; g.fillText(caption, 512, 195);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff,
    emissiveIntensity: 1.8, roughness: .4, metalness: .2 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, width / 4, .055), m);
  mesh.position.set(x, y, z); mesh.rotation.y = rotation; scene.add(mesh);
}

export function dressRoom(scene, renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer), env = new RoomEnvironment();
  const target = pmrem.fromScene(env, .04);
  scene.environment = target.texture; scene.environmentIntensity = .5;
  scene.userData.environmentTarget = target; env.dispose(); pmrem.dispose();

  const brass = new THREE.MeshStandardMaterial({ color: 0xbfa16b, roughness: .3, metalness: .8 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x312017, roughness: .65 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xffe9bf, emissive: 0xffd294, emissiveIntensity: 2.4 });
  const box = (x, y, z, w, h, d, material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; scene.add(m); return m;
  };

  const inner = MAP.interior;
  const spanX = inner.maxX - inner.minX, spanZ = inner.maxZ - inner.minZ;

  // 천장 우물반자. 실내 전체를 덮는다 (예전에는 저택 절반 크기에서 끊겼다).
  for (let x = inner.minX + 3; x <= inner.maxX - 3; x += 6) box(x, 6.94, 0, .1, .1, spanZ - .4, wood);
  for (let z = inner.minZ + 3; z <= inner.maxZ - 3; z += 6) box(0, 6.94, z, spanX - .4, .1, .1, wood);

  // 샹들리에. 줄기는 천장에서 고리까지 이어 놓는다 - 예전에는 등 높이와 상관없이
  // y=6.2 에 고정이라, 낮게 달린 복도등에서는 줄기와 고리가 따로 떠 있었다.
  for (const L of LIGHTS.filter((l) => l.kind !== 'lamp')) {
    const ringY = L.y - .15;
    // 줄기 꼭대기는 천장 속으로 6cm 밀어 넣는다. 천장면(y = MAP.height)과 딱
    // 맞추면 깊이 값이 같아져 카메라가 움직일 때마다 깜빡인다(z-fighting).
    const stem = Math.max(.2, MAP.height + .06 - ringY);
    box(L.x, ringY + stem / 2, L.z, .07, stem, .07, brass);
    const radius = 1.15;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, .035, 6, 32), brass);
    ring.rotation.x = Math.PI / 2; ring.position.set(L.x, ringY, L.z); scene.add(ring);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      box(L.x + Math.cos(a) * radius, L.y, L.z + Math.sin(a) * radius, .09, .3, .09, glow);
    }
  }

  // 양탄자. 방 안에 들어가는 크기로만 깐다 - 예전 현관홀 양탄자는 26m 라
  // 벽을 뚫고 앞마당까지 삐져나가 있었다.
  for (const r of roomRugs()) {
    const mat = new THREE.MeshStandardMaterial({ color: r.grand ? 0x58232b : 0x233d39, roughness: .98 });
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d), mat);
    rug.rotation.x = -Math.PI / 2; rug.position.set(r.x, .008, r.z); scene.add(rug);
    for (const x of [-r.w / 2 + .15, r.w / 2 - .15]) box(r.x + x, .012, r.z, .025, .005, r.d - .3, brass);
    for (const z of [-r.d / 2 + .15, r.d / 2 - .15]) box(r.x, .012, r.z + z, r.w - .3, .005, .025, brass);
  }

  // 방 이름표 / 저택 현판 / 창문 / 액자는 decor-layout 이 벽에서 찾아 준 자리에만.
  for (const s of roomSigns()) sign(scene, s.name, s.label, s.x, s.y, s.z, '#d6bc82', s.width, s.ry);
  const plaque = estatePlaque();
  if (plaque) sign(scene, 'RAVENWOOD', 'ESTATE / TACTICAL OPERATIONS', plaque.x, plaque.y, plaque.z, '#d6bc82', plaque.width, plaque.ry);

  const glass = new THREE.MeshStandardMaterial({
    color: 0xadc9d6, emissive: 0x84aabe, emissiveIntensity: .65, roughness: .3, metalness: .2,
  });
  for (const win of exteriorWindows()) {
    const across = WINDOW.depth, flat = win.axis === 'x';
    box(win.x, win.y, win.z, flat ? across : WINDOW.w, WINDOW.h, flat ? WINDOW.w : across, glass);
    box(win.x, win.y, win.z, flat ? across + .01 : .07, WINDOW.h, flat ? .07 : across + .01, brass);
    box(win.x, win.y, win.z, flat ? across + .01 : WINDOW.w, .07, flat ? WINDOW.w : across + .01, brass);
  }

  for (const a of grandHallArt()) {
    box(a.x, a.y, a.z, .06, ART.h, ART.w, brass);
    box(a.x + a.side * .03, a.y, a.z, .035, ART.h - .2, ART.w - .2,
      new THREE.MeshStandardMaterial({ color: a.tone, roughness: .95 }));
  }

  const positions = new Float32Array(160 * 3);
  for (let i = 0; i < 160; i++) {
    positions[i * 3] = Math.sin(i * 78.23) * (spanX / 2 - 2);
    positions[i * 3 + 1] = .3 + (i % 29) * .19;
    positions[i * 3 + 2] = Math.cos(i * 19.8) * (spanZ / 2 - 2);
  }
  const dust = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)),
    new THREE.PointsMaterial({ color: 0xf2dfba, size: .016, transparent: true, opacity: .18, depthWrite: false }),
  );
  scene.add(dust); return dust;
}

/* 실내 색 보정.
 *
 *  저택은 형광등 아래 사무실이 아니라 밤중에 남의 집에 들어간 장면이다.
 *  그늘은 푸르게, 불빛이 닿는 쪽은 노랗게 갈라 놓으면 같은 조명에서도
 *  공간이 훨씬 깊어 보인다. 대비를 중간 회색(0.18) 축으로 살짝 올리고
 *  화면 가장자리를 떨어뜨려 시선을 가운데로 모은다.
 *
 *  톤매핑(OutputPass) 앞에서 도므로 여기 색은 선형 공간이다. 그래서 대비를
 *  올릴 때 음수로 내려갈 수 있어 마지막에 잘라 준다. 전체 화면 한 번을
 *  훑는 것이 전부라 비용은 거의 없다.                                      */
const ColorGradeShader = {
  name: 'ColorGrade',
  uniforms: {
    tDiffuse:      { value: null },
    contrast:      { value: 1.08 },
    saturation:    { value: 1.06 },
    shadowTint:    { value: new THREE.Vector3(0.84, 0.93, 1.14) },
    highlightTint: { value: new THREE.Vector3(1.07, 1.00, 0.90) },
    vignette:      { value: 0.30 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float contrast, saturation, vignette;
    uniform vec3 shadowTint, highlightTint;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = texel.rgb;
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));

      c *= mix(shadowTint, highlightTint, smoothstep(0.0, 0.55, luma));
      c = (c - 0.18) * contrast + 0.18;
      c = mix(vec3(luma), c, saturation);

      vec2 d = vUv - 0.5;
      c *= 1.0 - vignette * dot(d, d) * 2.0;

      gl_FragColor = vec4(max(c, 0.0), texel.a);
    }`,
};

export class VisualPipeline {
  constructor(renderer, scene, camera, quality) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.composer = null; this.built = null;
    this.setQuality(quality);
  }

  /* 합성 단계는 쓰는 품질에서만 만든다.
   *
   *  Pass 는 enabled 를 꺼도 렌더 타깃을 놓지 않는다. GTAO 하나만 해도 법선 ·
   *  깊이 · AO · 잡음제거로 화면 크기 버퍼를 넷 잡고, SMAA 가 셋을 더 잡는다.
   *  파이프라인 자체는 품질과 무관하게 항상 만들어지므로, 그냥 두면 합성을
   *  쓰지도 않는 '낮음' 의 폰이 그 VRAM 을 전부 문다.
   *
   *  그래서 필요한 단계 구성이 바뀔 때만 합성기를 다시 세운다. 품질 변경은
   *  드물게 일어나고(설정 변경, 자동 저하) 그때마다 쓰지 않는 버퍼는 놓인다. */
  setQuality(key) {
    const q = QUALITY[key] || QUALITY.high;
    const wanted = (key === 'high' || key === 'ultra')
      ? { ao: !!q.ao, smaa: !!q.smaa }
      : null;
    const same = this.built && wanted && this.built.ao === wanted.ao && this.built.smaa === wanted.smaa;
    if (!same && !(this.built === null && wanted === null)) {
      this.dispose();
      if (wanted) this._build(wanted);
      this.built = wanted;
    }
    this.enabled = !!this.composer;
    this.resize();
  }

  _build({ ao, smaa }) {
    const { renderer, scene, camera } = this;
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    /* 접촉 그림자(GTAO).
     *
     *  광원 몇 개로는 벽과 바닥이 만나는 모서리, 상자 밑, 문틀 안쪽이 전부
     *  똑같이 밝아 방이 납작해 보인다. 화면 공간에서 주변 가림 정도를 재어
     *  그런 자리를 어둡게 깎는다. 저폴리 모델이라도 공간이 붙어 보이는 데
     *  가장 크게 기여한다. 대신 버퍼를 넷 잡고 잡음까지 걸러야 해서 이
     *  파이프라인에서 제일 비싸다. 켤 품질은 QUALITY.ao 가 정한다. */
    if (ao) {
      this.gtao = new GTAOPass(scene, camera, size.x, size.y);
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.gtao.blendIntensity = 1;
      this.gtao.updateGtaoMaterial({
        radius: 2,            // m. 방 하나 크기에 맞춘다. 0.5 쯤으로 좁히면
                              // 가림이 모서리 선 몇 줄로만 남아 눈에 띄지 않는다.
        scale: 2,             // 대홀 기준 화면의 7% 가 5% 이상 어두워지는 세기다.
                              // 더 올리면 모서리에 검은 테가 둘리기 시작한다.
        thickness: 1,
        distanceExponent: 1,
        samples: 16,
        screenSpaceRadius: false,
      });
      this.composer.addPass(this.gtao);
    }

    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), .24, .45, 1.1);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(ColorGradeShader);
    this.composer.addPass(this.grade);

    this.composer.addPass(new OutputPass());

    /* SMAA 는 톤매핑을 마친 화면에서 가장자리를 찾으므로 OutputPass 뒤에 둔다.
     * EffectComposer 의 렌더 타깃에는 멀티샘플이 걸려 있지 않아서, 렌더러의
     * antialias 옵션은 합성을 거치지 않는 1인칭 총에만 먹는다. 월드의 계단
     * 현상은 여기서만 지울 수 있다. */
    if (smaa) {
      this.smaa = new SMAAPass(size.x, size.y);
      this.composer.addPass(this.smaa);
    }
  }

  dispose() {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose?.();
    this.composer.dispose();
    this.composer = null;
    this.gtao = this.smaa = this.grade = this.bloom = null;
    this.enabled = false;
  }

  resize() {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer.setSize(size.x, size.y);
  }

  render() {
    const { renderer, scene, camera } = this;
    camera.layers.set(0);
    if (this.composer) this.composer.render(); else renderer.render(scene, camera);
    // A separate depth buffer preserves self-occlusion on the first-person gun.
    // Shared world materials never have depthTest disabled.
    const background = scene.background; const autoClear = renderer.autoClear;
    const shadowUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    scene.background = null; renderer.autoClear = false; renderer.clearDepth();
    camera.layers.set(1); renderer.render(scene, camera);
    camera.layers.set(0); scene.background = background; renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowUpdate;
  }
}
