/* =============================================================================
 *  hud.js  -  화면 UI 전부 (로비 / HUD / 설정 / 결과)
 *
 *  3D 와 DOM 을 섞으면 금방 지저분해지므로, "DOM 을 만지는 코드는 여기만" 으로
 *  몰아뒀다. game.js 는 hud.setHealth(80) 처럼 부르기만 한다.
 *
 *  성능 주의: 매 프레임 textContent 를 바꾸면 모바일에서 레이아웃이 계속 다시
 *  계산된다. 그래서 값이 "실제로 바뀌었을 때만" 쓴다(_set 헬퍼).
 * ========================================================================== */

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      boot: $('boot'), bootBar: $('bootBar'), bootMsg: $('bootMsg'),
      menu: $('menu'), lobby: $('lobby'), hud: $('hud'),
      pause: $('pause'), end: $('end'),

      nick: $('nick'), joinCode: $('joinCode'),
      menuErr: $('menuErr'), lobbyErr: $('lobbyErr'),
      roomCode: $('roomCode'), playerList: $('playerList'), playerCount: $('playerCount'),
      hostNote: $('hostNote'),

      crosshair: $('crosshair'), hitmark: $('hitmark'),
      vignette: $('vignette'), lowhp: $('lowhp'), dmgDirs: $('dmgDirs'),
      timer: $('timer'), siteList: $('siteList'), team: $('team'),
      hpFill: $('hpFill'), hpNum: $('hpNum'),
      ammoMag: $('ammoMag'), ammoRes: $('ammoRes'), wname: $('wname'),
      reloadHint: $('reloadHint'),
      interact: $('interact'), interactText: $('interactText'),
      interactBar: $('interactBar').firstElementChild,
      toasts: $('toasts'), fps: $('fps'),

      endTitle: $('endTitle'), endReason: $('endReason'), endStats: $('endStats'),
      tuner: $('tuner'), tunerOut: $('tunerOut'),
    };

    this._cache = new Map();
    this._siteEls = new Map();
    this._mateEls = new Map();
    this._toastTimers = [];
    this._crosshairSpread = -1;

    this.onAction = {};   // game.js 가 채운다
    this._bindUi();
  }

  /* ======================================================================= *
   *  화면 전환
   * ==================================================================== */
  show(which) {
    for (const k of ['boot', 'menu', 'lobby', 'pause', 'end']) {
      this.el[k].hidden = (k !== which);
    }
    // HUD 는 게임 중에만
    this.el.hud.hidden = (which !== 'game' && which !== 'pause');
    if (which === 'game') {
      this.el.pause.hidden = true;
      this.el.end.hidden = true;
    }
  }

  showHudOnly() {
    for (const k of ['boot', 'menu', 'lobby', 'pause', 'end']) this.el[k].hidden = true;
    this.el.hud.hidden = false;
  }

  /* --- 로딩 --- */
  bootProgress(done, total, label) {
    this.el.bootBar.style.width = `${Math.round((done / total) * 100)}%`;
    this.el.bootMsg.textContent = label;
  }

  /* ======================================================================= *
   *  로비
   * ==================================================================== */
  renderLobby(lobby, myId) {
    this.el.roomCode.textContent = lobby.code;
    this.el.playerCount.textContent = `${lobby.players.length}/4`;

    const isHost = lobby.hostId === myId;
    this.el.hostNote.textContent = isHost ? '(방장인 나만 바꿀 수 있음)' : '(방장만 변경 가능)';
    $('btnStart').disabled = !isHost;

    // 방장이 아니면 설정 칩 비활성
    for (const c of document.querySelectorAll('#botPick .chip, #diffPick .chip')) {
      c.disabled = !isHost;
      c.style.opacity = isHost ? '' : '0.45';
    }

    // 인원 목록
    const list = this.el.playerList;
    list.innerHTML = '';
    for (const p of lobby.players) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot' + (p.ready ? ' ready' : '');
      const nm = document.createElement('span');
      nm.textContent = p.name + (p.id === myId ? ' (나)' : '');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = (p.id === lobby.hostId ? '방장 · ' : '') + weaponLabel(p.weapon);
      li.append(dot, nm, tag);
      list.appendChild(li);
    }

    // 현재 설정 칩 반영
    setPressed('#botPick .chip', (c) => +c.dataset.n === lobby.botCount);
    setPressed('#diffPick .chip', (c) => c.dataset.d === lobby.difficulty);
  }

  /* ======================================================================= *
   *  인게임 HUD
   * ==================================================================== */
  setHealth(hp) {
    hp = Math.max(0, Math.round(hp));
    if (this._set('hp', hp)) {
      this.el.hpNum.textContent = hp;
      this.el.hpFill.style.width = `${hp}%`;
      this.el.hpFill.style.background =
        hp > 60 ? '#4fd1a1' : hp > 30 ? '#e0b341' : '#e5484d';
      this.el.lowhp.style.opacity = hp < 35 ? String((35 - hp) / 45) : '0';
    }
  }

  setAmmo(mag, reserve, weaponName) {
    if (this._set('mag', mag)) {
      this.el.ammoMag.textContent = mag;
      this.el.ammoMag.classList.toggle('empty', mag === 0);
    }
    if (this._set('res', reserve)) this.el.ammoRes.textContent = ` / ${reserve}`;
    if (weaponName && this._set('wname', weaponName)) this.el.wname.textContent = weaponName;
  }

  setReloading(on) {
    if (this._set('reloading', on)) this.el.reloadHint.hidden = !on;
  }

  setTimer(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const s = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    if (this._set('timer', s)) {
      this.el.timer.textContent = s;
      this.el.timer.classList.toggle('urgent', total <= 60);
    }
  }

  /** 목표 목록 만들기 (판 시작할 때 한 번) */
  initSites(sites) {
    this.el.siteList.innerHTML = '';
    this._siteEls.clear();
    for (const s of sites) {
      const row = document.createElement('div');
      row.className = 'site';
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = s.id;
      const label = document.createElement('span');
      label.textContent = s.label || `지점 ${s.id}`;
      const prog = document.createElement('span');
      prog.className = 'prog';
      const bar = document.createElement('i');
      prog.appendChild(bar);
      row.append(pill, label, prog);
      this.el.siteList.appendChild(row);
      this._siteEls.set(s.id, { row, bar });
    }
  }

  setSiteProgress(id, progress) {
    const e = this._siteEls.get(id);
    if (!e) return;
    e.bar.style.width = `${Math.round(progress * 100)}%`;
  }

  setSiteDefused(id) {
    const e = this._siteEls.get(id);
    if (!e) return;
    e.row.classList.add('done');
    e.bar.style.width = '100%';
  }

  /** 팀원 상태 (매 스냅샷) */
  setTeam(players, myId) {
    const box = this.el.team;

    // 인원이 바뀌었을 때만 다시 만든다
    const key = players.map((p) => p.id).join(',');
    if (this._set('teamKey', key)) {
      box.innerHTML = '';
      this._mateEls.clear();
      for (const p of players) {
        const d = document.createElement('div');
        d.className = 'mate' + (p.id === myId ? ' me' : '');
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = p.name;
        const bar = document.createElement('span');
        bar.className = 'hpbar';
        const fill = document.createElement('i');
        bar.appendChild(fill);
        d.append(nm, bar);
        box.appendChild(d);
        this._mateEls.set(p.id, { row: d, fill });
      }
    }

    for (const p of players) {
      const e = this._mateEls.get(p.id);
      if (!e) continue;
      e.fill.style.width = `${Math.max(0, p.hp)}%`;
      e.fill.style.background = p.hp > 50 ? '#4fd1a1' : p.hp > 25 ? '#e0b341' : '#e5484d';
      e.row.classList.toggle('down', !p.alive);
    }
  }

  /* --- 조준점: 탄 퍼짐에 따라 벌어진다 --- */
  setCrosshair(spreadRad, ads, hidden) {
    this.el.crosshair.classList.toggle('hidden', !!hidden || !!ads);
    if (hidden || ads) return;
    // 라디안 -> 픽셀 (대충 화면 절반 기준)
    const px = Math.min(26, 4 + spreadRad * 620);
    if (Math.abs(px - this._crosshairSpread) < 0.4) return;
    this._crosshairSpread = px;
    const c = this.el.crosshair;
    c.querySelector('.t').style.transform = `translateY(${-px}px)`;
    c.querySelector('.b').style.transform = `translateY(${px}px)`;
    c.querySelector('.l').style.transform = `translateX(${-px}px)`;
    c.querySelector('.r').style.transform = `translateX(${px}px)`;
  }

  hitMarker(kill = false) {
    const h = this.el.hitmark;
    h.classList.toggle('kill', kill);
    h.classList.remove('show');
    void h.offsetWidth;      // 애니메이션 재시작 강제
    h.classList.add('show');
  }

  /** 피격 - 화면 붉게 + 맞은 방향 표시 */
  damageFlash(strength = 0.5, angleRad = null) {
    const v = this.el.vignette;
    v.style.opacity = String(Math.min(0.85, strength));
    clearTimeout(this._vigTimer);
    this._vigTimer = setTimeout(() => { v.style.opacity = '0'; }, 160);

    if (angleRad !== null) {
      const d = document.createElement('div');
      d.className = 'dmgdir';
      d.style.transform = `rotate(${angleRad}rad)`;
      this.el.dmgDirs.appendChild(d);
      setTimeout(() => d.remove(), 1200);
    }
  }

  /* --- 상호작용 프롬프트 --- */
  setInteract(text, progress) {
    const on = !!text;
    if (this._set('interactOn', on)) this.el.interact.hidden = !on;
    if (!on) return;
    if (this._set('interactText', text)) this.el.interactText.textContent = text;
    this.el.interactBar.style.width = `${Math.round((progress || 0) * 100)}%`;
  }

  /* --- 토스트 --- */
  toast(msg, kind = '', ms = 2200) {
    const d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
    d.textContent = msg;
    this.el.toasts.appendChild(d);
    setTimeout(() => {
      d.style.transition = 'opacity 0.3s';
      d.style.opacity = '0';
      setTimeout(() => d.remove(), 320);
    }, ms);
    // 너무 많이 쌓이면 오래된 것부터 지운다
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  setFps(v, show) {
    this.el.fps.hidden = !show;
    if (!show) return;
    if (this._set('fps', v)) this.el.fps.textContent = `${v} FPS`;
  }

  /* ======================================================================= *
   *  결과 화면
   * ==================================================================== */
  showEnd(data, myId) {
    const win = data.result === 'won';
    this.el.endTitle.textContent = win ? '작전 성공' : '작전 실패';
    this.el.endTitle.className = win ? 'win' : 'lose';
    this.el.endReason.textContent = data.reason || '';

    this.el.endStats.innerHTML = '';
    for (const s of (data.stats || [])) {
      const li = document.createElement('li');
      const nm = document.createElement('span');
      nm.textContent = s.name + (s.id === myId ? ' (나)' : '');
      const st = document.createElement('span');
      st.style.color = s.alive ? '#4fd1a1' : '#e5484d';
      st.textContent = s.alive ? '생존' : '전사';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = `${s.kills} 제압`;
      li.append(nm, st, k);
      this.el.endStats.appendChild(li);
    }
    this.show('end');
  }

  /* ======================================================================= *
   *  설정 화면 값 채우기
   * ==================================================================== */
  syncSettings(s) {
    setPressed('#qualityPick .chip', (c) => c.dataset.q === s.quality);
    $('setSens').value = s.sensitivity;  $('setSensVal').textContent = s.sensitivity.toFixed(2);
    $('setFov').value = s.fov;           $('setFovVal').textContent = s.fov;
    $('setVol').value = s.volume ?? 0.7; $('setVolVal').textContent = `${Math.round((s.volume ?? 0.7) * 100)}%`;
    $('setAuto').checked = s.autoScale;
    $('setInvert').checked = s.invertY;
    $('setFps').checked = s.showFps;
    $('setLeft').checked = s.leftHanded;
  }

  /* ======================================================================= *
   *  이벤트 연결
   * ==================================================================== */
  _bindUi() {
    const A = this.onAction;

    /* --- 메뉴 --- */
    $('btnCreate').onclick = () => A.create?.();
    $('btnJoin').onclick = () => A.join?.();
    $('btnSolo').onclick = () => A.solo?.();
    $('btnSettings').onclick = () => A.openSettings?.();
    this.el.joinCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') A.join?.();
    });

    chipGroup('#weaponPick', (el) => A.weapon?.(el.dataset.w));
    chipGroup('#weaponPick2', (el) => A.weapon?.(el.dataset.w));
    chipGroup('#botPick', (el) => A.botCount?.(+el.dataset.n));
    chipGroup('#diffPick', (el) => A.difficulty?.(el.dataset.d));
    chipGroup('#qualityPick', (el) => A.quality?.(el.dataset.q));

    /* --- 로비 --- */
    $('btnCopy').onclick = async () => {
      const code = this.el.roomCode.textContent;
      try {
        await navigator.clipboard.writeText(code);
        this.el.lobbyErr.style.color = '#4fd1a1';
        this.el.lobbyErr.textContent = '복사했습니다: ' + code;
      } catch {
        this.el.lobbyErr.style.color = '#8b93a3';
        this.el.lobbyErr.textContent = '복사 실패 - 직접 적어주세요: ' + code;
      }
    };
    $('btnLeave').onclick = () => A.leave?.();
    $('btnReady').onclick = () => A.ready?.();
    $('btnStart').onclick = () => A.start?.();

    /* --- 일시정지 / 설정 --- */
    $('btnResume').onclick = () => A.resume?.();
    $('btnQuit').onclick = () => A.quit?.();

    bindRange('setSens', 'setSensVal', (v) => v.toFixed(2), (v) => A.setting?.('sensitivity', v));
    bindRange('setFov', 'setFovVal', (v) => String(Math.round(v)), (v) => A.setting?.('fov', Math.round(v)));
    bindRange('setVol', 'setVolVal', (v) => `${Math.round(v * 100)}%`, (v) => A.setting?.('volume', v));

    bindCheck('setAuto', (v) => A.setting?.('autoScale', v));
    bindCheck('setInvert', (v) => A.setting?.('invertY', v));
    bindCheck('setFps', (v) => A.setting?.('showFps', v));
    bindCheck('setLeft', (v) => A.setting?.('leftHanded', v));

    /* --- 결과 --- */
    $('btnAgain').onclick = () => A.again?.();
    $('btnToMenu').onclick = () => A.toMenu?.();
  }

  /* --- 값이 바뀔 때만 true --- */
  _set(key, val) {
    if (this._cache.get(key) === val) return false;
    this._cache.set(key, val);
    return true;
  }

  /** 새 판 시작할 때 캐시 비우기 */
  resetCache() { this._cache.clear(); this._crosshairSpread = -1; }

  error(where, msg) {
    const el = where === 'lobby' ? this.el.lobbyErr : this.el.menuErr;
    el.style.color = '#e5484d';
    el.textContent = msg || '';
  }
}

/* ========================================================================== *
 *  작은 헬퍼
 * ========================================================================== */
function chipGroup(selector, onPick) {
  const group = document.querySelector(selector);
  if (!group) return;
  group.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.disabled) return;
    for (const c of group.querySelectorAll('.chip')) {
      c.setAttribute('aria-pressed', String(c === chip));
    }
    onPick(chip);
  });
}

function setPressed(selector, test) {
  for (const c of document.querySelectorAll(selector)) {
    c.setAttribute('aria-pressed', String(!!test(c)));
  }
}

function bindRange(id, valId, fmt, fn) {
  const el = document.getElementById(id);
  const out = document.getElementById(valId);
  if (!el) return;
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    out.textContent = fmt(v);
    fn(v);
  });
}

function bindCheck(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => fn(el.checked));
}

export function weaponLabel(key) {
  return { rifle: 'M416', smg: 'UMP9', sniper: 'AWM' }[key] || key;
}
