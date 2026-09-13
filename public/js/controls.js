/* =============================================================================
 *  controls.js  -  입력 (모바일 터치 + PC 키보드/마우스)
 *
 *  바깥에서는 이 객체의 상태만 읽으면 된다:
 *    move   { x, y }   -1~1   (y = +1 이 앞)
 *    look   { dx, dy }        이번 프레임에 돌려야 할 각도(라디안). 읽으면 0 으로 리셋
 *    fire, ads, sprint, crouch, jump, use   (boolean)
 *
 *  모바일 설계 핵심
 *    - 왼쪽 아래를 "처음 누른 자리" 에 조이스틱이 생긴다 (고정형보다 훨씬 편하다)
 *    - 오른쪽은 드래그한 만큼 시점이 돈다. 손가락을 떼면 멈춘다.
 *    - 손가락 여러 개를 동시에 추적한다(이동+시점+발사 동시 가능).
 *    - 발사 버튼은 "누르고 있는 동안" 연사된다.
 * ========================================================================== */

const JOY_RADIUS = 58;        // 조이스틱 최대 반경(px)
const JOY_DEAD = 6;           // 데드존(px)
const LOOK_SCALE = 0.0042;    // 터치 1px 당 회전량(라디안)
const MOUSE_SCALE = 0.0022;

export class Controls {
  constructor(settings) {
    this.settings = settings;

    /* --- 바깥에서 읽는 상태 --- */
    this.move = { x: 0, y: 0 };
    this.look = { dx: 0, dy: 0 };
    this.fire = false;
    this.ads = false;
    this.sprint = false;
    this.crouch = false;
    this.jump = false;        // 한 프레임만 true (읽으면 소비)
    this.use = false;

    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.pointerLocked = false;
    this.enabled = false;

    /* --- 내부 --- */
    this._touches = new Map();     // pointerId -> { role, startX, startY, x, y }
    this._keys = new Set();
    this._sprintToggle = false;
    this._crouchToggle = false;
    this._listeners = [];

    this._el = {
      touch:   document.getElementById('touch'),
      look:    document.getElementById('lookZone'),
      moveZone:document.getElementById('moveZone'),
      stick:   document.getElementById('stick'),
      knob:    document.getElementById('stickKnob'),
      fire:    document.getElementById('btnFire'),
      ads:     document.getElementById('btnAds'),
      reload:  document.getElementById('btnReload'),
      use:     document.getElementById('btnUse'),
      jump:    document.getElementById('btnJump'),
      crouch:  document.getElementById('btnCrouch'),
      sprint:  document.getElementById('btnSprint'),
      menu:    document.getElementById('btnMenu'),
    };

    /* --- 콜백 (game.js 가 채운다) --- */
    this.onReload = null;
    this.onMenu = null;
    this.onFirstInput = null;    // iOS 오디오 깨우기용

    this._bindTouch();
    this._bindKeyboard();
    this._bindMouse();
  }

  /* ======================================================================= *
   *  켜기 / 끄기
   * ==================================================================== */
  setEnabled(on) {
    this.enabled = on;
    this._el.touch.hidden = !(on && this.isTouch);
    if (!on) this.reset();
  }

  reset() {
    this.move.x = this.move.y = 0;
    this.look.dx = this.look.dy = 0;
    this.fire = this.ads = this.jump = this.use = false;
    this.sprint = this._sprintToggle = false;
    this.crouch = this._crouchToggle = false;
    this._touches.clear();
    this._keys.clear();
    this._el.stick.classList.remove('on');
    for (const k of ['fire', 'ads', 'use', 'jump', 'crouch', 'sprint']) {
      this._el[k]?.classList.remove('held', 'toggled');
    }
  }

  /** 이번 프레임의 시점 변화량을 가져가고 0 으로 만든다 */
  consumeLook() {
    const d = { dx: this.look.dx, dy: this.look.dy };
    this.look.dx = this.look.dy = 0;
    return d;
  }

  /** 점프는 한 번만 먹는다 */
  consumeJump() {
    const j = this.jump;
    this.jump = false;
    return j;
  }

  _touched() {
    if (this.onFirstInput) { this.onFirstInput(); this.onFirstInput = null; }
  }

  /* ======================================================================= *
   *  터치
   * ==================================================================== */
  _bindTouch() {
    const E = this._el;

    /* --- 왼쪽: 조이스틱 --- */
    const moveStart = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this._touched();
      const id = e.pointerId;
      this._touches.set(id, { role: 'move', sx: e.clientX, sy: e.clientY });
      E.stick.style.left = `${e.clientX}px`;
      E.stick.style.top = `${e.clientY}px`;
      E.stick.classList.add('on');
      E.knob.style.transform = 'translate(-50%, -50%)';
      E.moveZone.setPointerCapture?.(id);
    };
    const moveMove = (e) => {
      const t = this._touches.get(e.pointerId);
      if (!t || t.role !== 'move') return;
      e.preventDefault();
      let dx = e.clientX - t.sx;
      let dy = e.clientY - t.sy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_RADIUS) { dx = (dx / len) * JOY_RADIUS; dy = (dy / len) * JOY_RADIUS; }

      E.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

      if (len < JOY_DEAD) { this.move.x = 0; this.move.y = 0; return; }
      this.move.x = dx / JOY_RADIUS;
      this.move.y = -dy / JOY_RADIUS;     // 화면 위로 밀면 앞으로
    };
    const moveEnd = (e) => {
      const t = this._touches.get(e.pointerId);
      if (!t || t.role !== 'move') return;
      this._touches.delete(e.pointerId);
      this.move.x = this.move.y = 0;
      E.stick.classList.remove('on');
      // 조이스틱을 놓으면 달리기도 자동 해제 (실수 방지)
      if (this._sprintToggle) {
        this._sprintToggle = false;
        this.sprint = false;
        E.sprint?.classList.remove('toggled');
      }
    };

    this._on(E.moveZone, 'pointerdown', moveStart);
    this._on(E.moveZone, 'pointermove', moveMove);
    this._on(E.moveZone, 'pointerup', moveEnd);
    this._on(E.moveZone, 'pointercancel', moveEnd);

    /* --- 오른쪽: 시점 --- */
    const lookStart = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this._touched();
      this._touches.set(e.pointerId, { role: 'look', x: e.clientX, y: e.clientY });
      E.look.setPointerCapture?.(e.pointerId);
    };
    const lookMove = (e) => {
      const t = this._touches.get(e.pointerId);
      if (!t || t.role !== 'look') return;
      e.preventDefault();
      const sens = this.settings.sensitivity * (this.ads ? 0.55 : 1);
      this.look.dx += (e.clientX - t.x) * LOOK_SCALE * sens;
      this.look.dy += (e.clientY - t.y) * LOOK_SCALE * sens * (this.settings.invertY ? -1 : 1);
      t.x = e.clientX; t.y = e.clientY;
    };
    const lookEnd = (e) => {
      if (this._touches.get(e.pointerId)?.role === 'look') this._touches.delete(e.pointerId);
    };

    this._on(E.look, 'pointerdown', lookStart);
    this._on(E.look, 'pointermove', lookMove);
    this._on(E.look, 'pointerup', lookEnd);
    this._on(E.look, 'pointercancel', lookEnd);

    /* --- 버튼들 --- */
    this._holdButton(E.fire, (on) => { this.fire = on; });
    this._holdButton(E.use, (on) => { this.use = on; });

    this._tapButton(E.reload, () => this.onReload?.());
    this._tapButton(E.jump, () => { this.jump = true; });

    // 정조준: 누르고 있는 동안 (레디오어낫 느낌엔 홀드가 맞다)
    this._holdButton(E.ads, (on) => { this.ads = on; });

    // 달리기 / 앉기는 토글
    this._toggleButton(E.sprint, (on) => {
      this._sprintToggle = on;
      this.sprint = on;
      if (on) { this._crouchToggle = false; this.crouch = false; E.crouch?.classList.remove('toggled'); }
    });
    this._toggleButton(E.crouch, (on) => {
      this._crouchToggle = on;
      this.crouch = on;
      if (on) { this._sprintToggle = false; this.sprint = false; E.sprint?.classList.remove('toggled'); }
    });

    this._tapButton(E.menu, () => this.onMenu?.());
  }

  /** 누르고 있는 동안 true */
  _holdButton(el, set) {
    if (!el) return;
    const down = (e) => {
      if (!this.enabled) return;
      e.preventDefault(); e.stopPropagation();
      this._touched();
      el.classList.add('held');
      set(true);
      el.setPointerCapture?.(e.pointerId);
    };
    const up = (e) => {
      e.preventDefault(); e.stopPropagation();
      el.classList.remove('held');
      set(false);
    };
    this._on(el, 'pointerdown', down);
    this._on(el, 'pointerup', up);
    this._on(el, 'pointercancel', up);
    this._on(el, 'pointerleave', up);
  }

  /** 한 번 누르면 한 번 실행 */
  _tapButton(el, fn) {
    if (!el) return;
    this._on(el, 'pointerdown', (e) => {
      if (!this.enabled && el !== this._el.menu) return;
      e.preventDefault(); e.stopPropagation();
      this._touched();
      el.classList.add('held');
      fn();
    });
    const up = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('held'); };
    this._on(el, 'pointerup', up);
    this._on(el, 'pointercancel', up);
  }

  /** 켜짐/꺼짐 토글 */
  _toggleButton(el, set) {
    if (!el) return;
    this._on(el, 'pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault(); e.stopPropagation();
      this._touched();
      const on = !el.classList.contains('toggled');
      el.classList.toggle('toggled', on);
      set(on);
    });
  }

  /* ======================================================================= *
   *  키보드 (PC)
   * ==================================================================== */
  _bindKeyboard() {
    this._on(window, 'keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      this._keys.add(k);
      this._touched();

      if (!this.enabled) return;
      if (k === 'Space') { this.jump = true; e.preventDefault(); }
      if (k === 'KeyR') this.onReload?.();
      if (k === 'KeyE') this.use = true;
      if (k === 'Escape') this.onMenu?.();
      if (k === 'KeyC') {
        this._crouchToggle = !this._crouchToggle;
        this.crouch = this._crouchToggle;
      }
      this._syncKeyMove();
    });

    this._on(window, 'keyup', (e) => {
      this._keys.delete(e.code);
      if (e.code === 'KeyE') this.use = false;
      this._syncKeyMove();
    });

    // 창이 포커스를 잃으면 눌린 키가 영원히 눌린 상태로 남는다 -> 전부 해제
    this._on(window, 'blur', () => {
      this._keys.clear();
      this._syncKeyMove();
      this.fire = false;
    });
  }

  _syncKeyMove() {
    const K = this._keys;
    const f = (K.has('KeyW') || K.has('ArrowUp')) ? 1 : 0;
    const b = (K.has('KeyS') || K.has('ArrowDown')) ? 1 : 0;
    const l = (K.has('KeyA') || K.has('ArrowLeft')) ? 1 : 0;
    const r = (K.has('KeyD') || K.has('ArrowRight')) ? 1 : 0;
    this.move.y = f - b;
    this.move.x = r - l;
    // 대각선이 빨라지지 않게 정규화
    const len = Math.hypot(this.move.x, this.move.y);
    if (len > 1) { this.move.x /= len; this.move.y /= len; }

    this.sprint = (K.has('ShiftLeft') || K.has('ShiftRight')) && this.move.y > 0.1;
    if (this.sprint) { this.crouch = false; this._crouchToggle = false; }
    else if (!this.isTouch) this.crouch = this._crouchToggle;
  }

  /* ======================================================================= *
   *  마우스 (PC) - 포인터 락
   * ==================================================================== */
  _bindMouse() {
    const canvasHost = document.body;

    this._on(document, 'pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvasHost;
      if (this.pointerLocked) this.onLockChange?.(true);
      else this.onLockChange?.(false);
    });

    // 자동 잠금이 거부됐을 때를 위한 보험: 화면을 클릭하면 그 제스처로 잠근다
    this._on(window, 'pointerdown', (e) => {
      if (this.isTouch || !this.enabled || this.pointerLocked) return;
      // UI 버튼을 누른 거면 건드리지 않는다
      if (e.target.closest('button, input, a, .card')) return;
      this.requestPointerLock();
    }, { passive: true });

    this._on(window, 'mousemove', (e) => {
      if (!this.enabled || !this.pointerLocked) return;
      const s = this.settings.sensitivity * (this.ads ? 0.55 : 1);
      this.look.dx += e.movementX * MOUSE_SCALE * s;
      this.look.dy += e.movementY * MOUSE_SCALE * s * (this.settings.invertY ? -1 : 1);
    });

    this._on(window, 'mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.pointerLocked) return;
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.ads = true;
    });
    this._on(window, 'mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.ads = false;
    });
    this._on(window, 'contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
  }

  /**
   * 마우스 잠그기.
   *
   * ★ 브라우저는 "사용자가 방금 클릭한" 흐름에서만 포인터 락을 허용한다.
   *   방장이 작전을 시작하면 나머지 인원은 아무 클릭도 안 한 상태라 거부당하고,
   *   콘솔에 "A user gesture is required" 오류가 찍힌다.
   *   그래서 실패해도 조용히 넘기고, 다음 클릭 때 자동으로 다시 잠근다.
   *
   * @returns {boolean} 지금 당장 잠글 수 있었는지
   */
  requestPointerLock() {
    if (this.isTouch) return true;
    this._wantLock = true;
    try {
      const r = document.body.requestPointerLock?.();
      // 최신 크롬은 Promise 를 준다 - 거부돼도 콘솔에 안 찍히게 잡아준다
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* 제스처가 없으면 거부된다 - 다음 클릭에서 다시 시도 */ }
    return !!document.pointerLockElement;
  }

  /** 게임 중인데 아직 마우스가 안 잠겼는가 (PC 한정) */
  needsClickToLock() {
    return !this.isTouch && this.enabled && this._wantLock && !this.pointerLocked;
  }

  exitPointerLock() {
    this._wantLock = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  /* ======================================================================= */
  _on(target, type, fn, opt = { passive: false }) {
    target.addEventListener(type, fn, opt);
    this._listeners.push([target, type, fn, opt]);
  }

  dispose() {
    for (const [t, ty, fn, o] of this._listeners) t.removeEventListener(ty, fn, o);
    this._listeners.length = 0;
  }
}
