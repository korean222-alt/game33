/* =============================================================================
 *  build-static.mjs  -  정적 배포용 빌드 (Vercel 등)
 *
 *  하는 일
 *    1) public/            ->  dist/   (EXCLUDE 목록은 제외)
 *    2) node_modules/three ->  dist/vendor/three/{build,examples/jsm}
 *       (server.js 가 로컬에서 /vendor/three 로 서빙하는 경로와 동일하게 맞춘다.
 *        덕분에 클라이언트 import 경로가 로컬/배포에서 똑같이 동작한다.)
 *    3) 환경 변수 GAME_SERVER_URL 이 있으면 dist/js/server-url.js 를 그 값으로
 *       덮어쓴다. -> 정적 페이지가 외부 게임 서버로 접속하게 된다.
 *
 *  실행: npm run build:static
 * ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyModels } from './verify-models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const THREE_ROOT = path.join(ROOT, 'node_modules', 'three');
// three 패키지 전체(src/docs 포함)는 매우 크므로 브라우저가 실제로 쓰는 것만 복사한다.
const THREE_PARTS = ['build', path.join('examples', 'jsm')];

// public/ 안에 있지만 배포에는 넣지 않을 것 (public/ 기준 상대 경로).
// 게임이 불러오지 않는 원본 소스 에셋 - 변환 결과물만 assets/models/ 로 서빙된다.
const EXCLUDE = ['assets/low_poly_market_stalls'];

async function main() {
  await verifyModels();
  await fs.rm(DIST, { recursive: true, force: true });

  // 1) public -> dist (EXCLUDE 제외)
  const PUBLIC = path.join(ROOT, 'public');
  const excluded = new Set(
    EXCLUDE.map((rel) => path.join(PUBLIC, ...rel.split('/'))),
  );
  await fs.cp(PUBLIC, DIST, {
    recursive: true,
    filter: (src) => !excluded.has(src),
  });
  for (const rel of EXCLUDE) console.log(`  제외됨: public/${rel}`);

  // 2) three -> dist/vendor/three
  for (const part of THREE_PARTS) {
    const src = path.join(THREE_ROOT, part);
    if (!(await exists(src))) {
      throw new Error(
        `three 파일을 찾을 수 없습니다: ${src}\n` +
        `빌드 전에 npm install 이 실행됐는지 확인하세요.`,
      );
    }
    await fs.cp(src, path.join(DIST, 'vendor', 'three', part), { recursive: true });
  }

  // 3) 게임 서버 주소 주입
  const serverUrl = (process.env.GAME_SERVER_URL || '').trim().replace(/\/+$/, '');
  if (serverUrl) {
    await fs.writeFile(
      path.join(DIST, 'js', 'server-url.js'),
      `/* 빌드 시 GAME_SERVER_URL 환경 변수로 자동 생성됨. 직접 수정하지 말 것. */\n` +
      `export const SERVER_URL = ${JSON.stringify(serverUrl)};\n`,
      'utf8',
    );
    console.log(`  게임 서버 주소: ${serverUrl}`);
  } else {
    console.warn(
      '  [경고] GAME_SERVER_URL 이 비어 있습니다. 클라이언트가 same-origin 으로 접속을 시도합니다.\n' +
      '         정적 호스팅(Vercel 등)에는 Socket.io 서버가 없으므로 멀티플레이가 동작하지 않습니다.\n' +
      '         호스팅 환경 변수에 게임 서버 주소를 설정하세요.',
    );
  }

  console.log(`  정적 빌드 완료 -> ${path.relative(ROOT, DIST)}/`);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
