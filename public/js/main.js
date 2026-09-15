/* =============================================================================
 *  main.js  -  진입점. 메뉴 -> 로비 -> 게임 -> 결과 흐름을 관리한다.
 * ========================================================================== */

import { installViewport } from './viewport.js';
installViewport();

import { connect, serverLabel } from './net.js';
import { Hud, escapeHtml } from './hud.js';
import { Game } from './game.js';
import { isTouchDevice } from './input.js';
import { loadSettings, saveSettings, guessQuality } from './config.js';
import { GameAudio } from './audio.js';

import { MISSION } from './mission-story.js';

const $ = (id) => document.getElementById(id);

const state = {
  socket: null,
  game: null,
  hud: new Hud(),
  myId: null,
  lobby: null,
  weapon: 'rifle',
  ready: false,
  briefing: null,
  menuAudio: null,
};

/* ========================================================================== *
 *  메뉴
 * ========================================================================== */
function initMenu() {
  const nameIn = $('nameIn');
  try { nameIn.value = localStorage.getItem('mr-name') || ''; } catch {}
  const settings = loadSettings();
  const quality = $('qualityIn');
  quality.value = settings._qualityPicked ? settings.quality : guessQuality();
  $('autoQuality').checked = settings.autoScale;
  initSound(settings);
  const update = () => {
    saveSettings({ ...loadSettings(), quality: quality.value, autoScale: $('autoQuality').checked, _qualityPicked: true });
    state.game?.dispose(); state.game = null;
  };
  quality.addEventListener('change', update);
  $('autoQuality').addEventListener('change', update);

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

/* ========================================================================== *
 *  소리
 *
 *  "소리가 안 난다" 는 신고가 가장 확인하기 어렵다. 브라우저가 막고 있는 건지,
 *  꺼 둔 건지, 너무 작은 건지 화면만 봐서는 알 수 없다. 그래서 메뉴에서 바로
 *  눌러 볼 수 있는 시험 버튼과 크기 조절을 둔다.
 * ========================================================================== */
function soundVolume() { return Number($('volumeIn').value) / 100; }

/** 지금 소리를 낼 수 있는 객체. 게임이 떠 있으면 그것을, 아니면 메뉴용을 쓴다. */
function audioTarget() {
  if (state.game?.audio) return state.game.audio;
  if (!state.menuAudio) {
    state.menuAudio = new GameAudio({
      enabled: $('soundEnabled').checked, volume: soundVolume(),
    });
    state.menuAudio.bind(document);
  }
  return state.menuAudio;
}

function setSoundState(text, kind = '') {
  const el = $('soundState');
  el.textContent = text;
  el.className = 'soundState' + (kind ? ' ' + kind : '');
}

function initSound(settings) {
  $('soundEnabled').checked = settings.soundEnabled !== false;
  $('volumeIn').value = String(Math.round((settings.volume ?? 0.8) * 100));

  const apply = () => {
    const enabled = $('soundEnabled').checked;
    const volume = soundVolume();
    saveSettings({ ...loadSettings(), soundEnabled: enabled, volume });
    for (const audio of [state.game?.audio, state.menuAudio]) {
      audio?.setEnabled(enabled);
      audio?.setVolume(volume);
    }
  };
  $('soundEnabled').addEventListener('change', apply);
  $('volumeIn').addEventListener('input', apply);

  $('btnSoundTest').addEventListener('click', async () => {
    if (!$('soundEnabled').checked) {
      setSoundState('효과음이 꺼져 있습니다. 위 체크를 켜 주세요.', 'bad');
      return;
    }
    const audio = audioTarget();
    audio.setEnabled(true);
    audio.setVolume(soundVolume());
    await audio.unlock();
    if (!audio.running) {
      setSoundState('브라우저가 소리를 막고 있습니다. 화면을 한 번 더 누른 뒤 다시 시도해 주세요.', 'bad');
      return;
    }
    setSoundState('총성 → 수갑 → 비명 순으로 들려야 합니다. 안 들리면 기기 음량과 탭 음소거를 확인하세요.', 'ok');
    audio.shot('rifle');
    setTimeout(() => audio.cuff(), 500);
    setTimeout(() => audio.scream(null, 'pain'), 1000);
  });
}

function setMenuErr(msg) { $('menuErr').textContent = msg; }

function playerName() {
  const v = $('nameIn').value.trim().slice(0, 12) || '대원';
  try { localStorage.setItem('mr-name', v); } catch {}
  return v;
}

/** 방 만들기 / 참가 - 서버 연결도 여기서 처음 한다 */
async function enterRoom(action, code) {
  setMenuErr('');
  $('btnCreate').disabled = $('btnJoin').disabled = true;

  try {
    if (!state.socket?.connected) {
      setMenuErr('서버에 연결하는 중…');
      state.socket = await connect();
      wireLobbyEvents();
      setMenuErr('');
    }

    const payload = { name: playerName(), weapon: state.weapon };
    if (code) payload.code = code;

    const res = await new Promise((resolve, reject) => state.socket.timeout(12000).emit(action, payload, (err, response) => err ? reject(new Error('서버 응답이 지연되고 있습니다. 다시 시도해 주세요.')) : resolve(response)));
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
    state.hud.show('menu');
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
  const game = new Game(state.socket, state.hud);
  try {
    game.myId = state.myId;
    await game.init((done, total, key) => {
      $('loadFill').style.width = `${Math.round((done / total) * 100)}%`;
      $('loadLabel').textContent = `${key} (${done}/${total})`;
    });
    if (!state.socket?.connected) throw new Error('모델 로딩 중 서버 연결이 끊겼습니다. 다시 참가해 주세요.');
    // 오디오 컨텍스트를 두 개 들고 있을 필요가 없다. 메뉴용은 여기서 닫는다.
    state.menuAudio?.dispose();
    state.menuAudio = null;
    state.game = game;
    return game;
  } catch (err) {
    game.dispose();
    console.error(err);
    throw new Error(`게임을 준비하지 못했습니다: ${err.message}`);
  }
}

/* ========================================================================== *
 *  로비
 * ========================================================================== */
function wireLobbyEvents() {
  state.socket.on('lobby', (l) => applyLobby(l));
  state.socket.on('briefing', (data) => {
    state.briefing = { id: data.id, page: 0, confirmed: false };
    state.game?.input.disable();
    state.game?.stop();
    state.hud.showTouch(false);
    renderBriefing();
    state.hud.show('briefing');
    $('briefTitle').focus();
  });
  state.socket.on('briefingCancelled', () => {
    state.briefing = null;
    state.hud.show('lobby');
    $('lobbyErr').textContent = '브리핑이 취소되었습니다. 준비 상태를 다시 확인해 주세요.';
  });
  state.socket.on('matchStart', () => { state.briefing = null; });

  state.socket.on('disconnect', (reason) => {
    console.warn('[net] disconnect', reason);
    // 작전 중이면 바로 메뉴로 보내지 않고 재연결을 시도한다.
    const hadLobby = state.lobby?.code;
    const inMatch = !!state.game && state.hud.screen !== 'menu' && state.hud.screen !== 'lobby';
    if (inMatch && hadLobby) {
      setMenuErr('');
      state.hud.banner('연결이 끊겼습니다. 재접속 중… (같은 이름·방 코드로 90초 안에 돌아오면 이어집니다)', 8000);
      // 소켓이 자동 재연결되면 joinRoom으로 슬롯을 이어받는다
      const tryRejoin = async () => {
        try {
          if (!state.socket) state.socket = await connect();
          if (!state.socket.connected) {
            await new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error('timeout')), 30000);
              state.socket.once('connect', () => { clearTimeout(t); res(); });
              state.socket.once('connect_error', (e) => { clearTimeout(t); rej(e); });
            });
          }
          wireLobbyEvents();
          const res = await new Promise((resolve) => {
            state.socket.timeout(15000).emit('joinRoom', {
              code: hadLobby, name: playerName(), weapon: state.weapon,
            }, (err, response) => resolve(err ? { ok: false, error: '응답 지연' } : response));
          });
          if (res?.ok) {
            state.myId = res.you;
            if (state.game) state.game.myId = state.myId;
            applyLobby(res.lobby);
            state.hud.banner('재접속 완료', 2500);
            return;
          }
          setMenuErr(res?.error || '재접속에 실패했습니다. 메뉴에서 같은 방 코드로 다시 참가해 주세요.');
        } catch (e) {
          console.error(e);
          setMenuErr('서버 재연결에 실패했습니다. 잠시 후 같은 방 코드로 다시 참가해 주세요.');
        }
        state.game?.dispose();
        state.game = null;
        state.ready = false;
        state.briefing = null;
        state.hud.showTouch(false);
        state.hud.show('menu');
      };
      // 약간의 딜레이 후 재시도 (Render 슬립 웨이크 시간 고려)
      setTimeout(tryRejoin, 2000);
      return;
    }
    state.game?.dispose();
    state.game = null;
    state.socket?.disconnect();
    state.socket = null;
    state.ready = false;
    state.briefing = null;
    state.hud.showTouch(false);
    state.hud.show('menu');
    setMenuErr('서버와 연결이 끊겼습니다. 방을 다시 만들거나 참가해 주세요.');
  });
}

function applyLobby(l) {
  if (!l) return;
  state.lobby = l;
  state.ready = !!l.players.find(p => p.id === state.myId)?.ready;
  $('btnReady').textContent = state.ready ? '준비 완료' : '준비';
  $('btnReady').classList.toggle('primary', state.ready);
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
  $('btnStart').textContent = allReady ? '작전 브리핑 시작' : '전원 준비 대기 중';
  if (state.briefing) updateBriefingStatus();
}

function updateBriefingStatus() {
  const players = state.lobby?.players || [];
  const ready = players.filter(p => p.briefingReady).length;
  $('briefStatus').textContent = state.briefing?.confirmed ?
    `진입 준비 ${ready} / ${players.length} · 나머지 대원의 확인을 기다리고 있습니다.` :
    '보고를 확인한 뒤 진입 준비를 눌러 주세요.';
  $('briefCancel').classList.toggle('hidden', state.lobby?.hostId !== state.myId);
}

function renderBriefing() {
  const briefing = state.briefing;
  if (!briefing) return;
  const page = MISSION.pages[briefing.page];
  $('missionTitle').textContent = MISSION.title;
  $('missionLocation').textContent = MISSION.location;
  $('missionTime').textContent = MISSION.time;
  $('briefStep').textContent = page.label;
  $('briefTitle').textContent = page.title;
  $('briefBody').textContent = page.body;
  $('briefDetail').textContent = page.detail;
  $('briefBack').disabled = briefing.page === 0 || briefing.confirmed;
  $('briefNext').disabled = briefing.confirmed;
  $('briefNext').textContent = briefing.confirmed ? '진입 준비 완료' :
    briefing.page === MISSION.pages.length - 1 ? '브리핑 확인 · 진입 준비' : '다음 보고';
  updateBriefingStatus();
}

function initLobby() {
  $('briefBack').addEventListener('click', () => {
    if (!state.briefing || state.briefing.confirmed) return;
    state.briefing.page = Math.max(0, state.briefing.page - 1);
    renderBriefing();
  });
  $('briefNext').addEventListener('click', () => {
    const briefing = state.briefing;
    if (!briefing || briefing.confirmed || !state.socket?.connected) return;
    if (briefing.page < MISSION.pages.length - 1) { briefing.page++; renderBriefing(); return; }
    briefing.confirmed = true;
    renderBriefing();
    state.socket.emit('briefingReady', { id: briefing.id });
  });
  $('briefCancel').addEventListener('click', () => state.socket?.emit('cancelBriefing'));
  $('briefLeave').addEventListener('click', () => {
    state.socket?.emit('leaveRoom');
    state.briefing = null; state.ready = false;
    state.hud.show('menu');
  });

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
  console.log(`[RAVENWOOD] 게임 서버: ${serverLabel}`);

  if (isTouchDevice) document.body.classList.add('touch');

  // iOS 사파리에서 주소창이 접히며 높이가 바뀌면 캔버스가 어긋난다
  addEventListener('orientationchange', () => setTimeout(() => dispatchEvent(new Event('resize')), 220));
}

boot();
