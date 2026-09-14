/* =============================================================================
 *  swap-character.mjs  -  캐릭터 모델만 갈아 끼운다 (동작 16개는 그대로)
 *
 *  왜 필요한가
 *    지금 들어 있는 캐릭터는 Mixamo 의 판타지 전사(dreyar)다. 야간 전술 진입
 *    작전에 맨몸의 전사가 소총을 들고 서 있으니 어울리지 않는다. 그런데
 *    동작 16개(대기/조준/앉기/걷기/달리기/측면/후진/사격/재장전/점프/피격/사망)를
 *    다시 받아 오려면 FBX 를 전부 다시 내려받아야 한다.
 *
 *    Mixamo 캐릭터는 전부 같은 뼈 이름(mixamorig*)을 쓴다. 그래서 지금 GLB 에
 *    들어 있는 클립을 그대로 새 캐릭터에 씌울 수 있다. 이 스크립트는 그 일만
 *    한다. 새 모델 파일 하나만 주면 된다.
 *
 *  사용법
 *    node scripts/swap-character.mjs <새 캐릭터 파일(.fbx | .glb | .gltf)>
 *    node scripts/swap-character.mjs --role <officer|suspect|hostage> <파일>
 *
 *    예) 전원을 같은 모델로:
 *        node scripts/swap-character.mjs ~/Downloads/swat.fbx
 *        인질만 다른 사람으로:
 *        node scripts/swap-character.mjs --role hostage ~/Downloads/civilian.fbx
 *        납치범(용의자·주범)만:
 *        node scripts/swap-character.mjs --role suspect ~/Downloads/robber.fbx
 *
 *  결과
 *    역할을 안 주면 public/assets/models/character-animated.glb 를 덮어쓴다.
 *    역할을 주면 character-<역할>.glb 로 저장하고 roles.json 에 등록한다.
 *    (등록되지 않은 역할은 기본 캐릭터를 그대로 쓴다)
 *    이어서 반드시:
 *      node scripts/asset-integrity.mjs --write
 *      npm test && npm run build:static
 *
 *  주의
 *    - 뼈 이름이 mixamorig* 가 아니면 동작이 하나도 안 붙는다. 그 경우 이
 *      스크립트가 어떤 뼈를 못 찾았는지 알려 주고 중단한다.
 *    - 모델 크기는 1.8m(PLAYER.height)로 자동으로 맞춘다.
 *    - 텍스처는 512px JPEG 로 줄인다. 원본 용량이 그대로 들어가면 배포가
 *      무거워지고 모바일에서 첫 로딩이 길어진다.
 * ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'assets', 'models');
const OUT = path.join(MODELS_DIR, 'character-animated.glb');
const CURRENT = '/public/assets/models/character-animated.glb';
const ROLES_FILE = path.join(MODELS_DIR, 'roles.json');
/** 역할 이름 -> [저장할 파일, config.js 의 모델 키] */
const ROLES = {
  officer: ['character-officer.glb', 'characterOfficer'],
  suspect: ['character-suspect.glb', 'characterSuspect'],
  hostage: ['character-hostage.glb', 'characterHostage'],
};
const TARGET_HEIGHT = 1.8;
const TEXTURE_SIZE = 512;

/* 설치된 Playwright 버전과 미리 받아 둔 Chromium 버전이 어긋나면 실행 파일을
 * 못 찾는다. CHROMIUM_PATH 로 직접 지정할 수 있게 열어 둔다.
 *   예) CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/...
 */
const launchOptions = (args) => ({
  args,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

async function loadPlaywright() {
  const unwrap = (mod) => (mod.chromium ? mod : mod.default);
  try { return unwrap(await import('playwright')); } catch { /* 전역 설치본을 찾아본다 */ }
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return unwrap(await import(path.join(globalRoot, 'playwright', 'index.js')));
}

/** 저장소와 새 모델 파일을 같은 오리진에서 서빙한다. */
function serve(sourceFile) {
  const types = {
    '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json',
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.fbx': 'application/octet-stream',
  };
  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = url === '/incoming' ? sourceFile : path.join(ROOT, url.slice(1));
    if (url !== '/incoming' && !file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(bytes);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* 브라우저 안에서 도는 본체. base64 GLB 와 보고서를 돌려준다. */
const SWAP = async ({ origin, current, incomingKind, textureSize, targetHeight }) => {
  const THREE = await import('three');
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');

  const loadWith = (loader, url) => new Promise((resolve, reject) =>
    loader.load(url, resolve, undefined, reject));

  /* ---- 1. 지금 쓰는 캐릭터에서 클립만 가져온다 ---- */
  const old = await loadWith(new GLTFLoader(), origin + current);
  const clips = old.animations;
  if (!clips.length) throw new Error('기존 파일에 동작 클립이 없습니다.');

  /* ---- 2. 새 캐릭터를 불러온다 ---- */
  const incoming = incomingKind === 'fbx'
    ? await loadWith(new FBXLoader(), origin + '/incoming')
    : (await loadWith(new GLTFLoader(), origin + '/incoming')).scene;

  /* ---- 3. 키를 1.8m 로 맞춘다 (Mixamo 단위는 내려받기 설정마다 다르다) ---- */
  incoming.updateMatrixWorld(true);
  const bind = new THREE.Box3().setFromObject(incoming, true);
  const rawHeight = bind.max.y - bind.min.y;
  if (!(rawHeight > 0)) throw new Error('새 모델의 크기를 잴 수 없습니다.');
  incoming.scale.multiplyScalar(targetHeight / rawHeight);
  incoming.updateMatrixWorld(true);

  /* ---- 4. 뼈 이름을 맞춘다 ----
   * 같은 Mixamo 뼈라도 파일 형식에 따라 'mixamorig:Hips' / 'mixamorigHips' /
   * 'mixamorig_Hips' 로 들어온다. 이름을 단순화해서 짝을 찾고, 클립의 트랙
   * 이름을 새 뼈 이름으로 바꿔 준다. 그래야 동작이 실제로 붙는다. */
  const simplify = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const bones = new Map();
  incoming.traverse((o) => { if (o.isBone || o.isObject3D) bones.set(simplify(o.name), o.name); });

  const missing = new Set();
  let retargeted = 0;
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      const node = track.name.slice(0, dot);
      const property = track.name.slice(dot);
      const match = bones.get(simplify(node));
      if (!match) { missing.add(node); continue; }
      if (match !== node) retargeted++;
      track.name = match + property;
    }
    clip.tracks = clip.tracks.filter((t) => bones.has(simplify(t.name.slice(0, t.name.lastIndexOf('.')))));
  }
  if (missing.size) {
    return { error: `새 모델에 없는 뼈: ${[...missing].slice(0, 12).join(', ')}` +
      (missing.size > 12 ? ` 외 ${missing.size - 12}개` : '') };
  }

  /* ---- 5. 메시 정리 + 텍스처 축소 ---- */
  const imageReady = async (texture) => {
    for (let i = 0; i < 600 && !texture.image?.width; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
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
  incoming.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) return { error: '새 모델에 메시가 없습니다.' };
  if (!meshes.some((m) => m.isSkinnedMesh)) {
    return { error: '스킨(뼈에 붙은 메시)이 없습니다. Mixamo 에서 T 포즈로 내려받으세요.' };
  }

  for (const o of meshes) {
    o.castShadow = o.receiveShadow = true;
    for (const name of Object.keys(o.geometry.attributes)) {
      if (name.startsWith('uv') && name !== 'uv') o.geometry.deleteAttribute(name);
    }
    o.geometry = mergeVertices(o.geometry);
    const source = Array.isArray(o.material) ? o.material : [o.material];
    const converted = [];
    for (const m of source) {
      if (!m) continue;
      converted.push(m.isMeshStandardMaterial && !m.map ? m : new THREE.MeshStandardMaterial({
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

  /* ---- 6. 내보내기 ---- */
  const root = new THREE.Group();
  root.name = 'character';
  root.add(incoming);
  const glb = await new GLTFExporter().parseAsync(root, {
    binary: true, animations: clips, includeCustomExtensions: false,
  });
  const bytes = new Uint8Array(glb);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return {
    base64: btoa(binary),
    retargeted,
    height: rawHeight,
    clips: clips.map((c) => `${c.name} (${c.duration.toFixed(2)}s)`),
  };
};

/* ========================================================================== */
/** roles.json 의 present 목록을 갱신한다. 여기 없는 역할은 불러오지 않는다. */
async function registerRole(modelKey) {
  const manifest = JSON.parse(await fs.readFile(ROLES_FILE, 'utf8'));
  const present = new Set(manifest.present || []);
  present.add(modelKey);
  manifest.present = [...present].sort();
  await fs.writeFile(ROLES_FILE, JSON.stringify(manifest, null, 2) + '\n');
  return manifest.present;
}

async function main() {
  const args = process.argv.slice(2);
  let role = null;
  const roleAt = args.findIndex((a) => a === '--role' || a.startsWith('--role='));
  if (roleAt >= 0) {
    role = args[roleAt].includes('=') ? args[roleAt].split('=')[1] : args[roleAt + 1];
    args.splice(roleAt, args[roleAt].includes('=') ? 1 : 2);
    if (!ROLES[role]) {
      console.error(`알 수 없는 역할: ${role} (쓸 수 있는 값: ${Object.keys(ROLES).join(' | ')})`);
      process.exit(1);
    }
  }
  const source = args[0];
  if (!source) {
    console.error('사용법: node scripts/swap-character.mjs [--role officer|suspect|hostage] <새 캐릭터 파일(.fbx | .glb | .gltf)>');
    process.exit(1);
  }
  const outFile = role ? path.join(MODELS_DIR, ROLES[role][0]) : OUT;
  const sourceFile = path.resolve(source);
  const extension = path.extname(sourceFile).toLowerCase();
  if (!['.fbx', '.glb', '.gltf'].includes(extension)) {
    throw new Error(`지원하지 않는 형식입니다: ${extension} (fbx / glb / gltf 만 됩니다)`);
  }
  await fs.access(sourceFile);

  const server = await serve(sourceFile);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch(launchOptions(['--no-sandbox']));
  try {
    const page = await browser.newPage();
    page.on('console', (m) => console.log('  [browser]', m.text()));
    await page.goto(`${origin}/scripts/import-animations.html`);
    const result = await page.evaluate(SWAP, {
      origin, current: CURRENT, incomingKind: extension === '.fbx' ? 'fbx' : 'gltf',
      textureSize: TEXTURE_SIZE, targetHeight: TARGET_HEIGHT,
    });
    if (result.error) throw new Error(result.error);

    const bytes = Buffer.from(result.base64, 'base64');
    await fs.writeFile(outFile, bytes);
    console.log(`  원본 키 ${result.height.toFixed(1)} 단위 -> ${TARGET_HEIGHT} m`);
    console.log(`  이름을 바꿔 붙인 트랙 ${result.retargeted}개`);
    console.log(`  클립 ${result.clips.length}개: ${result.clips.join(', ')}`);
    console.log(`  저장됨 -> ${path.relative(ROOT, outFile)} (${(bytes.length / 1048576).toFixed(2)} MB)`);
    if (role) {
      const present = await registerRole(ROLES[role][1]);
      console.log(`  역할 등록: ${role} -> ${ROLES[role][1]}  (지금 쓰는 역할별 모델: ${present.join(', ')})`);
    }
    console.log('\n  다음 순서로 마무리하세요:');
    console.log('    node scripts/asset-integrity.mjs --write');
    console.log('    npm test && npm run build:static');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
