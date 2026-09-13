/* =============================================================================
 *  net.js  -  서버 연결 (Socket.io)
 *
 *  socket.io 클라이언트 라이브러리는 게임 서버가 /socket.io/socket.io.js 로
 *  서빙한다. 분리 배포(정적=Vercel, 게임서버=Render)에서는 정적 호스트에 그 파일이
 *  없으므로, SERVER_URL 을 붙인 절대 경로로 런타임에 불러온다.
 * ========================================================================== */

import { SERVER_URL } from './server-url.js';

let socket = null;

const IO_OPTS = {
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 5,
  timeout: 12000,
};

/** <script> 를 동적으로 하나 삽입하고 로드될 때까지 기다린다. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`스크립트를 불러오지 못했습니다: ${src}`));
    document.head.appendChild(el);
  });
}

/**
 * 게임 서버에 접속한다.
 * @returns {Promise<import('socket.io-client').Socket>}
 */
export async function connect() {
  if (socket?.connected) return socket;

  if (!window.io) {
    await loadScript(`${SERVER_URL}/socket.io/socket.io.js`);
    if (!window.io) throw new Error('socket.io 클라이언트를 초기화하지 못했습니다.');
  }

  socket = SERVER_URL ? window.io(SERVER_URL, IO_OPTS) : window.io(IO_OPTS);

  await new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = (err) => {
      cleanup();
      reject(new Error(
        `게임 서버에 연결하지 못했습니다.\n${SERVER_URL || '(같은 주소)'}\n${err?.message || ''}`,
      ));
    };
    const cleanup = () => {
      socket.off('connect', done);
      socket.off('connect_error', fail);
    };
    socket.once('connect', done);
    socket.once('connect_error', fail);
  });

  return socket;
}

export function getSocket() {
  if (!socket) throw new Error('아직 서버에 연결되지 않았습니다.');
  return socket;
}

/** 콜백을 받는 이벤트를 Promise 로 감싼다. */
export function request(event, payload) {
  return new Promise((resolve) => getSocket().emit(event, payload, resolve));
}

/** 서버 주소 (진단용 표시에 쓴다) */
export const serverLabel = SERVER_URL || location.origin;
