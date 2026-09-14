/* =============================================================================
 *  import-animations.mjs  -  Mixamo FBX 묶음을 게임용 GLB 하나로 변환한다.
 *
 *  사용법:
 *    npm run import:animations -- /path/to/extracted-fbx-folder
 *
 *  입력
 *    - 스킨이 포함된 FBX 1개 (가장 큰 파일. 메시 + 뼈대 + 텍스처)
 *    - 동작만 담긴 FBX 여러 개 (같은 mixamorig 뼈대를 공유한다)
 *
 *  출력
 *    - public/assets/models/character-animated.glb
 *      (스킨 메시 1개 + CLIPS 에 정의된 이름의 애니메이션 클립들)
 *
 *  왜 브라우저를 쓰나
 *    three 의 FBXLoader / GLTFExporter 는 텍스처를 다룰 때 canvas 가 필요하다.
 *    Node 에는 canvas 가 없으므로 미리 설치된 Chromium 을 헤드리스로 띄워서
 *    변환한다. 결과 GLB 는 저장소에 커밋되므로 게임 실행/배포에는 필요 없다.
 * ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'assets', 'models', 'character-animated.glb');

/* 파일 이름(확장자 제외) -> 게임에서 쓰는 클립 이름.
 * animation.js 의 상태 기계가 이 이름들을 그대로 참조한다. */
const CLIPS = {
  'Rifle Idle': 'idle',
  'Rifle Aiming Idle': 'aim',
  'Idle Crouching': 'crouchIdle',
  'Crouched Walking': 'crouchWalk',
  'Rifle Crouch Walk': 'crouchWalkAim',
  'Rifle Run': 'run',
  'Fast Run': 'sprint',
  'Left Strafe Walking': 'strafeLeft',
  'Right Strafe Walking': 'strafeRight',
  'Walking Backwards': 'walkBack',
  'Running Backward': 'runBack',
  'Firing Rifle': 'fire',
  'Reloading': 'reload',
  'Jump': 'jump',
  'Hit Reaction': 'hit',
  'Death': 'death',
};

/** "Left Strafe Walking(1).fbx" -> "Left Strafe Walking" */
const clipKey = (file) => path.basename(file, '.fbx').replace(/\s*\(\d+\)$/, '').trim();

async function loadPlaywright() {
  // CommonJS 로 배포된 버전은 ESM import 시 default 아래에 들어온다.
  const unwrap = (mod) => (mod.chromium ? mod : mod.default);
  try { return unwrap(await import('playwright')); } catch { /* 전역 설치본을 찾아본다 */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return unwrap(await import(path.join(globalRoot, 'playwright', 'index.js')));
}

/** ROOT 와 FBX 폴더를 같은 오리진에서 서빙한다 (fetch 로 읽어야 하므로). */
function serve(sourceDir) {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.fbx': 'application/octet-stream' };
  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const base = url.startsWith('/fbx/') ? sourceDir : ROOT;
    const rel = url.startsWith('/fbx/') ? url.slice(5) : url.slice(1);
    const file = path.join(base, rel);
    if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(bytes);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* 브라우저 안에서 실행되는 변환 본체.
 * 반환값은 GLB 바이트의 base64 문자열이다. */
const CONVERT = async ({ origin, files, clips, skinFile, textureSize, targetHeight }) => {
  // 경로는 import-animations.html 의 importmap 이 해결한다.
  const THREE = await import('three');
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');

  const loader = new FBXLoader();
  const load = (file) => new Promise((resolve, reject) =>
    loader.load(`${origin}/fbx/${encodeURIComponent(file)}`, resolve, undefined, reject));

  /* ---- 스킨(메시 + 뼈대) ---- */
  const skin = await load(skinFile);
  /* Mixamo FBX 의 단위는 내려받기 설정에 따라 cm 또는 mm 다. 단위를 가정하지 말고
   * 바인드 포즈의 키를 재서 정확히 1.8m(게임의 PLAYER.height)로 맞춘다. */
  skin.updateMatrixWorld(true);
  const bind = new THREE.Box3().setFromObject(skin, true);
  const rawHeight = bind.max.y - bind.min.y;
  if (!(rawHeight > 0)) throw new Error('바인드 포즈 크기를 잴 수 없습니다.');
  skin.scale.setScalar(targetHeight / rawHeight);
  skin.updateMatrixWorld(true);
  console.log(`bind height ${rawHeight.toFixed(1)} units -> ${targetHeight} m`);

  /* FBXLoader 는 내장 텍스처를 비동기로 읽는다. texture.image 는 나중에 채워지므로
   * 픽셀이 준비될 때까지 기다린다. 기다리지 않으면 축소를 건너뛰고 원본이 그대로 박힌다. */
  const imageReady = async (texture) => {
    for (let i = 0; i < 600 && !texture.image?.width; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  /* 512px JPEG 로 줄인다. 게임 내 거리에서는 차이가 보이지 않고 용량이 1/40 이 된다. */
  const shrink = async (texture) => {
    if (!texture) return null;
    await imageReady(texture);
    const image = texture.image;
    if (!image || !image.width) throw new Error('텍스처 픽셀을 읽지 못했습니다.');
    const scale = Math.min(1, textureSize / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    texture.image = canvas;
    texture.userData.mimeType = 'image/jpeg';
    texture.needsUpdate = true;
    return texture;
  };

  const meshes = [];
  skin.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) throw new Error('스킨 FBX 에 메시가 없습니다: ' + skinFile);

  for (const o of meshes) {
    o.castShadow = o.receiveShadow = true;
    // Mixamo 메시는 UV 세트를 7개나 들고 있다. 렌더링에는 첫 번째만 쓴다.
    for (const name of Object.keys(o.geometry.attributes)) {
      if (name.startsWith('uv') && name !== 'uv') o.geometry.deleteAttribute(name);
    }
    // 여분 UV 때문에 갈라져 있던 정점을 합친다 (정점 수와 용량이 크게 줄어든다).
    const before = o.geometry.attributes.position.count;
    o.geometry = mergeVertices(o.geometry);
    console.log(`vertices ${before} -> ${o.geometry.attributes.position.count}`);
    // FBX 는 Phong 재질로 들어온다. glTF 는 PBR 이므로 직접 변환해야
    // 거칠기/금속성이 의도한 값으로 기록된다.
    const source = Array.isArray(o.material) ? o.material : [o.material];
    const converted = [];
    for (const m of source) {
      if (!m) continue;
      converted.push(new THREE.MeshStandardMaterial({
        name: m.name,
        map: await shrink(m.map),
        normalMap: await shrink(m.normalMap),
        color: m.color ? m.color.clone() : undefined,
        roughness: 0.78,
        metalness: 0.04,
      }));
    }
    o.material = converted.length > 1 ? converted : converted[0];
  }

  /* ---- 애니메이션 클립 ---- */
  // FBXLoader 는 뼈 이름의 ':' 를 지우므로 'mixamorig:Hips' 가 'mixamorigHips' 가 된다.
  let hips = null;
  skin.traverse((o) => { if (!hips && o.isBone && /Hips$/.test(o.name)) hips = o; });
  if (!hips) throw new Error('Hips 뼈를 찾지 못했습니다.');

  /* 제자리 동작으로 만든다: 엉덩이 뼈의 수평 이동을 첫 프레임 값으로 고정.
   * 수직(y) 성분은 점프/사망에 필요하므로 그대로 둔다. */
  const pinHorizontal = (clip) => {
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.position') || !track.name.includes('Hips')) continue;
      const v = track.values;
      for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
    }
  };

  /* Mixamo 는 모든 뼈에 위치·회전·크기 트랙을 전부 넣는다. 실제로 필요한 것은
   * 뼈의 회전과 엉덩이(루트)의 위치뿐이다. 나머지를 버리면 용량이 3분의 1이 된다. */
  const usefulTracks = (clip) => clip.tracks.filter((t) =>
    t.values.some(Number.isFinite) &&
    (t.name.endsWith('.quaternion') || (t.name.endsWith('.position') && t.name.includes('Hips'))));

  const animations = [];
  const seen = new Set();
  for (const file of files) {
    const key = clips[file];
    if (!key || seen.has(key)) continue;
    const source = file === skinFile ? skin : await load(file);
    const clip = source.animations[0];
    if (!clip) throw new Error('클립이 없습니다: ' + file);
    clip.name = key;
    clip.tracks = usefulTracks(clip);
    pinHorizontal(clip);
    animations.push(clip);
    seen.add(key);
  }

  /* ---- 내보내기 ---- */
  const root = new THREE.Group();
  root.name = 'character';
  root.add(skin);
  const glb = await new GLTFExporter().parseAsync(root, {
    binary: true, animations, includeCustomExtensions: false,
  });
  const bytes = new Uint8Array(glb);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return { base64: btoa(binary), clips: animations.map((a) => `${a.name} (${a.duration.toFixed(2)}s)`) };
};

/* ========================================================================== */
async function main() {
  const source = process.argv[2];
  if (!source) throw new Error('FBX 폴더 경로를 인자로 넘기세요.');
  const sourceDir = path.resolve(source);

  const entries = (await fs.readdir(sourceDir)).filter((f) => f.toLowerCase().endsWith('.fbx'));
  if (!entries.length) throw new Error(`FBX 파일이 없습니다: ${sourceDir}`);

  const clips = {};
  for (const file of entries) {
    const key = CLIPS[clipKey(file)];
    if (key) clips[file] = key;
    else console.warn(`  건너뜀(이름 규칙 없음): ${file}`);
  }
  const missing = Object.values(CLIPS).filter((v) => !Object.values(clips).includes(v));
  if (missing.length) throw new Error(`필요한 동작 파일이 없습니다: ${missing.join(', ')}`);

  // 스킨이 들어 있는 파일은 압도적으로 크다.
  const sizes = await Promise.all(entries.map(async (f) => [f, (await fs.stat(path.join(sourceDir, f))).size]));
  const skinFile = sizes.sort((a, b) => b[1] - a[1])[0][0];
  console.log(`  스킨 파일: ${skinFile}`);

  const server = await serve(sourceDir);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => console.log("  [browser]", m.text()));
    await page.goto(`${origin}/scripts/import-animations.html`);
    const result = await page.evaluate(CONVERT, {
      origin, files: entries, clips, skinFile, textureSize: 512, targetHeight: 1.8,
    });
    const bytes = Buffer.from(result.base64, 'base64');
    await fs.writeFile(OUT, bytes);
    console.log(`  클립 ${result.clips.length}개: ${result.clips.join(', ')}`);
    console.log(`  저장됨 -> ${path.relative(ROOT, OUT)} (${(bytes.length / 1048576).toFixed(2)} MB)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
