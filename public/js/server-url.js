/* =============================================================================
 *  server-url.js  -  게임(Socket.io) 서버 주소
 *
 *  로컬 개발 / 단일 서버 배포:
 *    빈 문자열 그대로 두면 된다. 클라이언트가 페이지를 받아온 곳(same-origin)으로
 *    그대로 접속하므로 `npm start` 후 http://localhost:3000 이 알아서 잡힌다.
 *
 *  분리 배포 (정적 파일=Vercel, 게임 서버=Render 등):
 *    Vercel 프로젝트의 환경 변수 GAME_SERVER_URL 에 게임 서버 주소를 넣는다.
 *      예)  GAME_SERVER_URL = https://market-raid.onrender.com
 *    빌드(scripts/build-static.mjs)가 이 파일을 그 값으로 덮어써서 내보낸다.
 *    → 이 파일을 직접 고칠 필요는 없다.
 * ========================================================================== */

/** Socket.io 접속 주소. '' 이면 same-origin. */
export const SERVER_URL = '';

/**
 * Socket.io 클라이언트 생성 시 이렇게 쓴다:
 *
 *   import { SERVER_URL } from './server-url.js';
 *   const socket = SERVER_URL ? io(SERVER_URL) : io();
 */
