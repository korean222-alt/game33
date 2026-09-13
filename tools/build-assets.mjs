/* =============================================================================
 *  tools/build-assets.mjs  -  Sketchfab 원본 -> 게임용 GLB 굽는 스크립트
 *
 *  하는 일
 *    1) assets-src/ 안의 scene.gltf 에서 필요한 노드(소품/총기/캐릭터)만 잘라낸다
 *    2) "발이 y=0, 중심이 원점" 이 되도록 위치를 정규화한다
 *    3) 목표 크기(m)에 맞게 스케일을 맞춘다  -> 게임 코드에서 scale 만지지 않아도 됨
 *    4) 텍스처를 모바일용으로 축소하고, 안 쓰는 데이터를 전부 버린다
 *    5) public/assets/models/*.glb 로 저장한다
 *
 *  실행:  npm run build:assets
 *
 *  ※ 이 스크립트는 "개발용"이다. 이미 구워진 GLB 가 public/assets/models 에
 *    들어있으므로, 게임을 돌리기만 할 거면 실행할 필요 없다.
 * ========================================================================== */

import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, join, flatten } from '@gltf-transform/functions';
import { getBounds } from '@gltf-transform/core';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets-src');
const OUT = path.join(ROOT, 'public/assets/models');

/* -----------------------------------------------------------------------------
 *  굽는 목록
 *
 *  src      : assets-src 아래 폴더명
 *  node     : 잘라낼 노드 이름 (null = 씬 전체)
 *  out      : 결과 파일명
 *  targetY  : 결과물의 목표 "높이"(m). 지정하면 그 높이에 맞춰 균일 스케일.
 *  targetX  : 높이 대신 폭(X)으로 맞추고 싶을 때
 *  center   : 'floor'(발이 y=0, XZ 중심) | 'origin'(완전 중심) | 'grip'(총기용)
 *  tex      : 텍스처 최대 변 길이
 *  skinned  : 뼈대 포함 여부 (true 면 weld/join 안 함)
 * -------------------------------------------------------------------------- */
const JOBS = [
  /* ---- 시장 소품 ---- */
  { src: 'low_poly_market', node: 'Stall',       out: 'stall-tarp.glb', targetX: 2.83, center: 'floor', tex: 512 },
  { src: 'low_poly_market', node: 'Create',      out: 'crate.glb',      targetX: 0.75, center: 'floor', tex: 512 },
  { src: 'low_poly_market', node: 'Barrel',      out: 'barrel.glb',     targetY: 0.99, center: 'floor', tex: 512 },
  { src: 'low_poly_market', node: 'Vase',        out: 'vase.glb',       targetY: 1.53, center: 'floor', tex: 512 },
  { src: 'low_poly_market', node: 'Well',        out: 'well.glb',       targetY: 2.35, center: 'floor', tex: 512 },
  { src: 'low_poly_market', node: 'Table',       out: 'table.glb',      targetX: 1.60, center: 'floor', tex: 512 },
  { src: 'low_poly_market', node: 'Weapon Rack', out: 'rack.glb',       targetY: 1.90, center: 'floor', tex: 512 },

  /* ---- 총기 (길이 기준으로 맞춘다) ---- */
  { src: 'low_poly_gun_pack', node: 'M416_8',  out: 'weapon-rifle.glb',  targetLen: 0.90, center: 'origin', tex: 256, gun: true },
  { src: 'low_poly_gun_pack', node: 'UMP9_7',  out: 'weapon-smg.glb',    targetLen: 0.65, center: 'origin', tex: 256, gun: true },
  { src: 'low_poly_gun_pack', node: 'AWM_2',   out: 'weapon-sniper.glb', targetLen: 1.20, center: 'origin', tex: 256, gun: true },

  /* ---- 캐릭터 (뼈대 있음 - 절대 join 하면 안 됨) ---- */
  { src: 'psx_swat_guy', node: null, out: 'character.glb', targetY: 1.80, center: 'floor', tex: 256, skinned: true },
];

/* ========================================================================== *
 *  헬퍼
 * ========================================================================== */

/** 노드 이름으로 찾기 (정확히 일치 우선, 없으면 접두사 매치) */
function findNode(doc, name) {
  const nodes = doc.getRoot().listNodes();
  return nodes.find((n) => n.getName() === name)
      || nodes.find((n) => n.getName().startsWith(name))
      || null;
}

/** 4x4 행렬 곱 (column-major, gltf 규격) */
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** 이동+균일스케일 행렬 */
function trsMatrix(tx, ty, tz, s) {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, tx, ty, tz, 1];
}

/** 텍스처를 모바일 크기로 줄인다 */
async function shrinkTextures(doc, maxSize) {
  for (const tex of doc.getRoot().listTextures()) {
    const image = tex.getImage();
    if (!image) continue;
    const mime = tex.getMimeType();
    try {
      let pipe = sharp(Buffer.from(image));
      const meta = await pipe.metadata();
      if (meta.width > maxSize || meta.height > maxSize) {
        pipe = pipe.resize(
          Math.min(meta.width, maxSize),
          Math.min(meta.height, maxSize),
          { fit: 'inside', kernel: 'lanczos3' }
        );
      }
      const buf = mime === 'image/jpeg'
        ? await pipe.jpeg({ quality: 82, mozjpeg: true }).toBuffer()
        : await pipe.png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();

      // 줄여서 더 커지면(이미 최적화된 파일) 원본 유지
      if (buf.length < image.byteLength) tex.setImage(new Uint8Array(buf));
    } catch (err) {
      console.warn(`    ! 텍스처 처리 실패 (${tex.getName()}): ${err.message}`);
    }
  }
}

/**
 * 총기 팩에는 색을 안 칠한 채로 남은 형광 청록색 머티리얼이 섞여 있다.
 * 실사풍 실내에서 형광 하늘색 총을 들고 다니면 몰입이 통째로 깨지므로
 * "채도가 높고 파랑/청록 계열" 인 것만 골라서 건메탈로 바꾼다.
 * (목재 개머리판 같은 붉은/황토 계열은 실제 총기 색이므로 건드리지 않는다)
 */
function isDummyGunColor([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0.001) return false;
  const sat = (max - min) / max;
  if (sat < 0.5) return false;
  return b >= r && b > g * 0.6;
}

function degunk(doc) {
  let n = 0;
  for (const m of doc.getRoot().listMaterials()) {
    const base = m.getBaseColorFactor();
    if (!isDummyGunColor(base)) continue;
    m.setBaseColorFactor([0.105, 0.108, 0.118, base[3]]);
    m.setMetallicFactor(0.55);
    m.setRoughnessFactor(0.42);
    n++;
  }
  return n;
}

/** 머티리얼을 실내 조명에 맞게 손본다 (Sketchfab 기본값이 너무 번들거림) */
function tuneMaterials(doc) {
  for (const m of doc.getRoot().listMaterials()) {
    const rough = m.getRoughnessFactor();
    const metal = m.getMetallicFactor();
    if (rough < 0.35 && !m.getMetallicRoughnessTexture()) m.setRoughnessFactor(0.45);
    if (metal > 0.9) m.setMetallicFactor(0.85);
    // 완전 무광 검정은 실내에서 형태가 안 보인다 - 살짝 띄운다
    const base = m.getBaseColorFactor();
    if (base[0] < 0.02 && base[1] < 0.02 && base[2] < 0.02) {
      m.setBaseColorFactor([0.055, 0.055, 0.06, base[3]]);
    }
  }
}

/* ========================================================================== *
 *  메인
 * ========================================================================== */
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

async function build(job) {
  const srcPath = path.join(SRC, job.src, 'scene.gltf');
  const outPath = path.join(OUT, job.out);
  const label = `${job.out.padEnd(20)}`;

  const doc = await io.read(srcPath);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];

  /* --- 1. 필요한 노드만 남긴다 ------------------------------------------ */
  if (job.node) {
    const target = findNode(doc, job.node);
    if (!target) throw new Error(`노드를 못 찾음: ${job.node}`);

    // 조상들의 행렬(Sketchfab 은 보통 -90도 회전 + 0.01 스케일이 박혀있다)을
    // 잘라낸 노드에 직접 구워 넣어야 방향/크기가 안 틀어진다.
    const world = target.getWorldMatrix();
    const parent = target.getParentNode();
    if (parent) parent.removeChild(target);
    for (const child of scene.listChildren()) scene.removeChild(child);
    target.setMatrix(world);
    scene.addChild(target);
  }

  /* --- 2. 안 쓰는 것 버리기 ----------------------------------------------
   * ★ 스킨(뼈대) 모델은 keepAttributes: true 가 필수다.
   *   false 로 두면 JOINTS_0 / WEIGHTS_0 어트리뷰트가 날아가고,
   *   그 다음 Skin 이 "안 쓰는 것"으로 판정돼서 통째로 삭제된다.
   *   -> 캐릭터가 뻣뻣한 T 포즈로 굳어버린다.                              */
  await doc.transform(
    prune({ keepAttributes: !!job.skinned, keepLeaves: !!job.skinned }),
    dedup()
  );

  /* --- 3. 위치/크기 정규화 ---------------------------------------------- */
  // 현재 경계 상자를 재고, 원하는 크기/위치가 되도록 한 겹 감싼다.
  let bounds = getBounds(scene);
  let size = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];

  let s = 1;
  if (job.targetY) s = job.targetY / (size[1] || 1);
  else if (job.targetX) s = job.targetX / (size[0] || 1);
  else if (job.targetLen) s = job.targetLen / (Math.max(size[0], size[1], size[2]) || 1);

  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;

  // center 방식에 따라 Y 기준점을 고른다
  const originY = job.center === 'floor' ? bounds.min[1] : cy;

  const fix = trsMatrix(-cx * s, -originY * s, -cz * s, s);

  // 씬 최상위 노드들에 직접 행렬을 곱한다 (노드를 추가하면 스킨 계층이 꼬일 수 있음)
  for (const child of scene.listChildren()) {
    child.setMatrix(mul(fix, child.getMatrix()));
  }

  /* --- 4. 지오메트리 최적화 (스킨 모델은 건드리지 않는다) ---------------- */
  if (!job.skinned) {
    await doc.transform(
      flatten(),                   // 노드 행렬을 정점에 구워넣는다 (AABB 가 딱 맞아짐 -> 컬링 정확)
      weld(),
      join({ keepNamed: false })   // 드로우콜 줄이기
    );
  }

  /* --- 5. 머티리얼 / 텍스처 --------------------------------------------- */
  tuneMaterials(doc);
  const recolored = job.gun ? degunk(doc) : 0;
  await shrinkTextures(doc, job.tex);
  await doc.transform(
    prune({ keepAttributes: !!job.skinned, keepLeaves: !!job.skinned }),
    dedup()
  );

  /* --- 6. 저장 ----------------------------------------------------------- */
  await io.write(outPath, doc);

  // 리포트
  bounds = getBounds(scene);
  size = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += idx ? idx.getCount() / 3 : prim.getAttribute('POSITION').getCount() / 3;
    }
  }
  const bytes = (await fs.stat(outPath)).size;
  console.log(
    `  ✔ ${label} ${(bytes / 1024).toFixed(0).padStart(5)} KB  ` +
    `${String(Math.round(tris)).padStart(6)} tri  ` +
    `크기 ${size.map((v) => v.toFixed(2)).join(' x ')} m  ` +
    `바닥 y=${bounds.min[1].toFixed(3)}` +
    (recolored ? `  (더미색 ${recolored}개 -> 건메탈)` : '')
  );

  return { out: job.out, size, bytes, tris: Math.round(tris) };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log('\n  ███  에셋 굽기 시작  ███\n');

  const results = [];
  for (const job of JOBS) {
    try {
      results.push(await build(job));
    } catch (err) {
      console.error(`  ✘ ${job.out}  실패: ${err.message}`);
    }
  }

  const total = results.reduce((a, r) => a + r.bytes, 0);
  console.log(`\n  합계 ${results.length}개 / ${(total / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  -> ${path.relative(ROOT, OUT)}/\n`);
  console.log('  이 크기 값을 public/js/config.js 의 placeholder 에 맞춰두면');
  console.log('  GLB 가 없을 때도 충돌 박스가 똑같이 동작합니다.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
