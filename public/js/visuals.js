import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

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

export class VisualPipeline {
  constructor(renderer, scene, camera, quality) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), .24, .45, 1.1);
    this.composer.addPass(this.bloom); this.composer.addPass(new OutputPass());
    this.setQuality(quality);
  }
  setQuality(key) { this.enabled = key === 'high' || key === 'ultra'; this.resize(); }
  resize() {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(innerWidth, innerHeight);
  }
  render() {
    const { renderer, scene, camera } = this;
    camera.layers.set(0);
    if (this.enabled) this.composer.render(); else renderer.render(scene, camera);
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
