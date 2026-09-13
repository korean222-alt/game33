/* =============================================================================
 *  main.js  -  진입점. 메뉴 -> 로비 -> 게임 -> 결과 흐름을 관리한다.
 * ========================================================================== */

import { connect, serverLabel } from './net.js';
import { Hud, escapeHtml } from './hud.js';
import { Game } from './game.js';
import { isTouchDevice } from './input.js';

const $ = (id) => document.getElementById(id);

const state = {
  socket: null,
  game: null,
  hud: new Hud(),
  myId: null,
  lobby: null,
  weapon: 'rifle',
  ready: false,
};

/* ========================================================================== *
 *  메뉴
 * ========================================================================== */
function initMenu() {
  const nameIn = $('nameIn');
  nameIn.value = localStorage.getItem('mr-name') || '';

  // 무기 선택
  for (const b of $('wpSeg').children) {
    b.addEventListener('click', () => {
      state.weapon = b.dataset.w;
      for (const o of $('wpSeg').children) o.setAttribute('aria-pressed', String(o === b));
    });
  }

  $('codeIn').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('btnCreate').addEventListener('click', () => enterRoom('createRoom'));
  $('btnJoin').addEventListener('click', () => {
    const code = $('codeIn').value.trim();
    if (code.length !== 5) return setMenuErr('방 코드는 5글자입니다.');
    enterRoom('joinRoom', code);
  });
  $('codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
}

function setMenuErr(msg) { $('menuErr').textContent = msg; }

function playerName() {
  const v = $('nameIn').value.trim().slice(0, 12) || '대원';
  localStorage.setItem('mr-name', v);
  return v;
}

/** 방 만들기 / 참가 - 서버 연결도 여기서 처음 한다 */
async function enterRoom(action, code) {
  setMenuErr('');
  $('btnCreate').disabled = $('btnJoin').disabled = true;

  try {
    if (!state.socket) {
      setMenuErr('서버에 연결하는 중…');
      state.socket = await connect();
      wireLobbyEvents();
      setMenuErr('');
    }

    const payload = { name: playerName(), weapon: state.weapon };
    if (code) payload.code = code;

    const res = await new Promise((resolve) => state.socket.emit(action, payload, resolve));
    if (!res?.ok) { setMenuErr(res?.error || '방에 들어가지 못했습니다.'); return; }

    state.myId = res.you;
    applyLobby(res.lobby);

    // 매치가 시작되기 "전에" 게임을 초기화해 둔다.
    // matchStart 를 받고 나서 만들면 Game 이 그 이벤트를 놓친다.
    await ensureGame();
    state.hud.show('lobby');
  } catch (err) {
    setMenuErr(err.message || String(err));
    console.error(err);
  } finally {
    $('btnCreate').disabled = $('btnJoin').disabled = false;
  }
}

/**
 * 게임(렌더러 + 에셋)을 준비한다. 이미 준비돼 있으면 아무것도 하지 않는다.
 * 반드시 matchStart 가 오기 전에 끝나야 Game 이 그 이벤트를 받을 수 있다.
 */
async function ensureGame() {
  if (state.game) { state.game.myId = state.myId; return state.game; }

  state.hud.show('loading');
  try {
    const game = new Game(state.socket, state.hud);
    game.myId = state.myId;
    await game.init((done, total, key) => {
      $('loadFill').style.width = `${Math.round((done / total) * 100)}%`;
      $('loadLabel').textContent = `${key} (${done}/${total})`;
    });
    state.game = game;
    return game;
  } catch (err) {
    console.error(err);
    throw new Error(`게임을 준비하지 못했습니다: ${err.message}`);
  }
}

/* ========================================================================== *
 *  로비
 * ========================================================================== */
function wireLobbyEvents() {
  state.socket.on('lobby', (l) => applyLobby(l));

  state.socket.on('disconnect', () => {
    if (!state.game?.matchActive) {
      state.hud.show('menu');
      setMenuErr('서버와 연결이 끊겼습니다. 다시 시도해 주세요.');
      state.socket = null;
      state.game = null;
    }
  });
}

function applyLobby(l) {
  if (!l) return;
  state.lobby = l;
  $('lobbyCode').textContent = l.code;

  const isHost = l.hostId === state.myId;
  $('hostOnly').classList.toggle('hidden', !isHost);
  $('btnStart').classList.toggle('hidden', !isHost);

  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  for (const p of l.players) {
    const li = document.createElement('li');
    const tags = [
      p.id === l.hostId ? '방장' : null,
      p.id === state.myId ? '나' : null,
      WEAPON_LABEL[p.weapon] || p.weapon,
    ].filter(Boolean).join(' · ');
    li.innerHTML =
      `<span class="dot${p.ready ? ' on' : ''}"></span>` +
      `<span class="nm">${escapeHtml(p.name)}</span>` +
      `<span class="tag">${escapeHtml(tags)}</span>`;
    ul.appendChild(li);
  }

  for (const b of $('botSeg').children) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.n) === l.botCount));
  }
  for (const b of $('diffSeg').children) {
    b.setAttribute('aria-pressed', String(b.dataset.d === l.difficulty));
  }

  const others = l.players.length;
  const allReady = l.players.every((p) => p.ready);
  $('btnStart').disabled = !(isHost && others >= 1 && allReady);
  $('btnStart').textContent = allReady ? '작전 개시' : '전원 준비 대기 중';
}

function initLobby() {
  $('btnReady').addEventListener('click', () => {
    state.ready = !state.ready;
    $('btnReady').textContent = state.ready ? '준비 완료' : '준비';
    $('btnReady').classList.toggle('primary', state.ready);
    state.socket.emit('setLoadout', { weapon: state.weapon, ready: state.ready });
  });

  for (const b of $('botSeg').children) {
    b.addEventListener('click', () => state.socket.emit('setRoomConfig', { botCount: Number(b.dataset.n) }));
  }
  for (const b of $('diffSeg').children) {
    b.addEventListener('click', () => state.socket.emit('setRoomConfig', { difficulty: b.dataset.d }));
  }

  $('btnStart').addEventListener('click', () => state.socket.emit('startMatch'));

  $('btnLeave').addEventListener('click', () => {
    state.socket.emit('leaveRoom');
    state.ready = false;
    $('btnReady').textContent = '준비';
    $('btnReady').classList.remove('primary');
    state.hud.show('menu');
  });

  $('btnAgain').addEventListener('click', () => {
    state.ready = false;
    $('btnReady').textContent = '준비';
    $('btnReady').classList.remove('primary');
    state.socket.emit('setLoadout', { weapon: state.weapon, ready: false });
    state.hud.show('lobby');
  });
}

const WEAPON_LABEL = { rifle: 'M416', smg: 'UMP9', sniper: 'AWM' };

/* ========================================================================== *
 *  시작
 * ========================================================================== */
function boot() {
  initMenu();
  initLobby();
  state.hud.show('menu');
  console.log(`[MARKET RAID] 게임 서버: ${serverLabel}`);

  if (isTouchDevice) document.body.classList.add('touch');

  // iOS 사파리에서 주소창이 접히며 높이가 바뀌면 캔버스가 어긋난다
  addEventListener('orientationchange', () => setTimeout(() => dispatchEvent(new Event('resize')), 220));
}

boot();
