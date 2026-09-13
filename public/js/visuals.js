import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Seeded grain keeps the room stable across reloads and clients.
function surface(kind) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 512;
  const g = cv.getContext('2d'); let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  g.fillStyle = kind === 'floor' ? '#68747b' : '#8d9594'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 15000; i++) {
    g.fillStyle = random() > .5 ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.07)';
    g.fillRect(random() * 512, random() * 512, 1 + random() * 4, 1 + random() * 4);
  }
  if (kind === 'floor') {
    for (let y = 0; y < 512; y += 128) for (let x = 0; x < 512; x += 128) {
      g.strokeStyle = '#354249'; g.lineWidth = 3; g.strokeRect(x, y, 128, 128);
      g.strokeStyle = 'rgba(216,231,229,.3)'; g.lineWidth = 1; g.strokeRect(x + 3, y + 3, 122, 122);
    }
    for (let i = 0; i < 16; i++) {
      const x = random() * 512, y = random() * 512, r = 12 + random() * 65;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(19,34,38,.23)'); grad.addColorStop(1, 'rgba(19,34,38,0)');
      g.fillStyle = grad; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

export function roomMaterials() {
  const floor = surface('floor'); floor.repeat.set(5, 4);
  const wall = surface('wall'); wall.repeat.set(3, 2);
  // Height/roughness maps contain data, so they must not use sRGB decoding.
  const bump = floor.clone(); bump.colorSpace = THREE.NoColorSpace;
  const wallBump = wall.clone(); wallBump.colorSpace = THREE.NoColorSpace;
  return {
    floor: new THREE.MeshStandardMaterial({ map: floor, bumpMap: bump, bumpScale: .022,
      roughnessMap: bump, roughness: .68, metalness: .16 }),
    wall: new THREE.MeshStandardMaterial({ map: wall, bumpMap: wallBump, bumpScale: .028,
      color: 0x9caeb4, roughness: .88, metalness: .03 }),
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
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new RoomEnvironment();
  const target = pmrem.fromScene(env, .04);
  scene.environment = target.texture; scene.environmentIntensity = .42;
  env.dispose(); pmrem.dispose();
  scene.userData.environmentTarget = target;

  sign(scene, '남부시장', 'NAMBU MARKET / NIGHT OPERATIONS', .25, 2.48, 3.17, '#73ffe0', 3.4);
  sign(scene, '청과 · 과일', 'FRESH PRODUCE / 01', -4.7, 2.54, .95, '#ffd38a');
  sign(scene, '시장 잡화', 'GENERAL GOODS / 02', 0, 2.58, 1.05, '#7effe1');
  sign(scene, '식료품', 'LOCAL GROCER / 03', 4.7, 2.54, .95, '#ffa181');
  sign(scene, '창고 A', 'STORAGE / AUTHORIZED PERSONNEL', 2, 2.4, -5.31, '#71d8ff', 2.4);
  const metal = new THREE.MeshStandardMaterial({ color: 0x273943, roughness: .48, metalness: .72 });
  for (const z of [-4.6, -1.8, 1.8, 4.6]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(14.7, .14, .13), metal);
    beam.position.set(0, 3.04, z); scene.add(beam);
  }
  const warm = new THREE.MeshStandardMaterial({ color: 0xffdab0, emissive: 0xffac53, emissiveIntensity: 4 });
  const cool = new THREE.MeshStandardMaterial({ color: 0xabfff1, emissive: 0x42cfce, emissiveIntensity: 4 });
  for (const x of [-3.4, 3.5]) for (const z of [-3.9, 0, 4.3]) {
    const casing = new THREE.Mesh(new THREE.BoxGeometry(.14, .09, 1.8), metal);
    casing.position.set(x, 3.01, z); scene.add(casing);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(.07, .018, 1.65), z > 1 ? cool : warm);
    strip.position.set(x, 2.95, z); scene.add(strip);
  }
  // Painted lane edges sit flush on the floor and introduce no invisible collisions.
  const paint = new THREE.MeshStandardMaterial({ color: 0xd5b75f, roughness: .78 });
  for (const x of [-3.4, 3.5]) for (let z = -1.6; z < 4.6; z += .8) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(.035, .42), paint);
    dash.rotation.x = -Math.PI / 2; dash.position.set(x - .55, .007, z); scene.add(dash);
  }
  const positions = new Float32Array(100 * 3);
  for (let i = 0; i < 100; i++) { positions[i * 3] = Math.sin(i * 78.23) * 7; positions[i * 3 + 1] = .3 + (i % 29) * .09; positions[i * 3 + 2] = Math.cos(i * 19.8) * 5; }
  const dust = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)),
    new THREE.PointsMaterial({ color: 0xdbe9df, size: .012, transparent: true, opacity: .22, depthWrite: false }));
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
