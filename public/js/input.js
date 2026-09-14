/* =============================================================================
 *  input.js  -  입력 (PC 키보드+마우스 / 모바일 터치)
 *
 *  게임 로직은 이 클래스가 내놓는 "의도"만 본다. 어떤 기기로 조작하든 결과는 같다.
 *    move   : {x, y}  좌우 / 앞뒤 (-1 ~ 1)
 *    look   : {dx, dy} 이번 프레임에 돌린 양 (라디안). 읽으면 0으로 초기화된다.
 *    fire / ads / sprint / crouch / use : 누르는 동안 true
 *    jump / reload / door / peek / kick / shout / throwGrenade : 한 번만 소비된다
 *    grenadeSlot : 1~3 (섬광 / 가스 / 파편)
 * ========================================================================== */

const MOUSE_SENS = 0.0022;    // 라디안 / px
const TOUCH_SENS = 0.0040;

export const isTouchDevice =
  matchMedia('(hover: none) and (pointer: coarse)').matches || 'ontouchstart' in window;

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;

    this.move = { x: 0, y: 0 };
    this.look = { dx: 0, dy: 0 };
    this.fire = false;
    this.ads = false;
    this.sprint = false;
    this.crouch = false;
    this.use = false;
    this.peek = false;

    this.jump = false;
    this.reload = false;
    this.door = false;
    this.kick = false;
    this.shout = false;
    this.throwGrenade = false;
    this.grenadeSlot = 0;

    this.enabled = false;
    this.locked = false;

    this._keys = new Set();
    this._lookTouchId = null;
    this._stickTouchId = null;
    this._onLockChange = null;
    this._resetButtons = [];
    this._abort = new AbortController();

    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
  }

  _listen(target, type, listener, options = {}) {
    target.addEventListener(type, listener, { ...options, signal: this._abort.signal });
  }

  dispose() { this.disable(); this._abort.abort(); }

  enable() { this.enabled = true; }
  disable() {
    this.enabled = false;
    this.reset();
    this.releasePointer();
  }

  reset() {
    this._keys.clear();
    this.move.x = this.move.y = 0;
    this.fire = this.ads = this.sprint = this.crouch = this.use = this.peek = false;
    this.jump = this.reload = this.door = this.kick = this.shout = this.throwGrenade = false;
    this.grenadeSlot = 0;
    this.look.dx = this.look.dy = 0;
    this._lookTouchId = this._stickTouchId = null;
    const knob = document.getElementById('knob');
    if (knob) knob.style.transform = '';
    this._resetButtons.forEach((reset) => reset());
  }

  /** 이번 프레임 시점 이동량을 읽고 비운다 */
  consumeLook() {
    const d = { dx: this.look.dx, dy: this.look.dy };
    this.look.dx = this.look.dy = 0;
    return d;
  }

  /** 한 번만 처리해야 하는 입력을 읽고 비운다 */
  consumeJump() { const v = this.jump; this.jump = false; return v; }
  consumeReload() { const v = this.reload; this.reload = false; return v; }
  consumeDoor() { const v = this.door; this.door = false; return v; }
  consumeKick() { const v = this.kick; this.kick = false; return v; }
  consumeShout() { const v = this.shout; this.shout = false; return v; }
  consumeThrow() { const v = this.throwGrenade; this.throwGrenade = false; return v; }
  consumeGrenadeSlot() { const v = this.grenadeSlot; this.grenadeSlot = 0; return v; }

  /* ---- PC: 키보드 ------------------------------------------------------- */
  _bindKeyboard() {
    const down = (e) => {
      if (!this.enabled) return;
      const k = e.code;
      if (HANDLED_KEYS.has(k)) e.preventDefault();
      if (this._keys.has(k)) return;   // 키 반복 무시
      this._keys.add(k);

      if (k === 'Space') this.jump = true;
      if (k === 'KeyR') this.reload = true;
      if (k === 'KeyE') this.door = true;
      if (k === 'KeyB') this.kick = true;
      if (k === 'KeyV') this.shout = true;
      if (k === 'KeyG') this.throwGrenade = true;
      if (k === 'Digit1') this.grenadeSlot = 1;
      if (k === 'Digit2') this.grenadeSlot = 2;
      if (k === 'Digit3') this.grenadeSlot = 3;
      this._syncKeys();
    };
    const up = (e) => {
      this._keys.delete(e.code);
      this._syncKeys();
    };
    this._listen(window, 'keydown', down);
    this._listen(window, 'keyup', up);
    // 탭 전환 등으로 keyup 을 놓치면 키가 눌린 채로 남는다
    this._listen(window, 'blur', () => this.reset());
    this._listen(document, 'visibilitychange', () => { if (document.hidden) this.reset(); });
  }

  _syncKeys() {
    const k = this._keys;
    let x = 0, y = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }

    // 터치 조이스틱이 잡고 있으면 키보드가 덮어쓰지 않게 한다
    if (this._stickTouchId === null) { this.move.x = x; this.move.y = y; }

    this.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    this.crouch = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC');
    this.use = k.has('KeyF');
    this.peek = k.has('KeyQ');
  }

  /* ---- PC: 마우스 + 포인터 락 ------------------------------------------- */
  _bindMouse() {
    this._listen(this.canvas, 'mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) { this.requestPointer(); return; }
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.ads = true;
    });
    this._listen(window, 'mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.ads = false;
    });
    this._listen(this.canvas, 'contextmenu', (e) => e.preventDefault());

    this._listen(window, 'mousemove', (e) => {
      if (!this.enabled || !this.locked) return;
      const s = this.settings.sensitivity ?? 1;
      this.look.dx += e.movementX * MOUSE_SENS * s;
      this.look.dy += e.movementY * MOUSE_SENS * s * (this.settings.invertY ? -1 : 1);
    });

    this._listen(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.reset();
      this._onLockChange?.(this.locked);
    });
  }

  onLockChange(fn) { this._onLockChange = fn; }

  requestPointer() {
    if (isTouchDevice) return;
    try { this.canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* Click to retry. */ }
  }

  releasePointer() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
  }

  /* ---- 모바일: 조이스틱 + 화면 드래그 ----------------------------------- */
  _bindTouch() {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('knob');
    if (!stick) return;

    const RADIUS = 48;
    let origin = { x: 0, y: 0 };

    const stickStart = (e) => {
      if (!this.enabled) return;
      const t = e.changedTouches[0];
      this._stickTouchId = t.identifier;
      const r = stick.getBoundingClientRect();
      origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      e.preventDefault();
    };
    const stickMove = (e) => {
      if (this._stickTouchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== this._stickTouchId) continue;
        let dx = t.clientX - origin.x;
        let dy = t.clientY - origin.y;
        const len = Math.hypot(dx, dy);
        if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        this.move.x = dx / RADIUS;
        this.move.y = -dy / RADIUS;    // 화면 위로 밀면 전진
        e.preventDefault();
      }
    };
    const stickEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._stickTouchId) continue;
        this._stickTouchId = null;
        knob.style.transform = '';
        this.move.x = this.move.y = 0;
      }
    };
    this._listen(stick, 'touchstart', stickStart, { passive: false });
    this._listen(stick, 'touchmove', stickMove, { passive: false });
    this._listen(stick, 'touchend', stickEnd);
    this._listen(stick, 'touchcancel', stickEnd);

    // 화면 오른쪽 빈 곳을 끌면 시점 회전
    let last = { x: 0, y: 0 };
    this._listen(this.canvas, 'touchstart', (e) => {
      if (!this.enabled || this._lookTouchId !== null) return;
      const t = e.changedTouches[0];
      this._lookTouchId = t.identifier;
      last = { x: t.clientX, y: t.clientY };
    }, { passive: true });

    this._listen(this.canvas, 'touchmove', (e) => {
      if (this._lookTouchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== this._lookTouchId) continue;
        const s = this.settings.sensitivity ?? 1;
        this.look.dx += (t.clientX - last.x) * TOUCH_SENS * s;
        this.look.dy += (t.clientY - last.y) * TOUCH_SENS * s * (this.settings.invertY ? -1 : 1);
        last = { x: t.clientX, y: t.clientY };
      }
      e.preventDefault();
    }, { passive: false });

    const lookEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._lookTouchId) this._lookTouchId = null;
      }
    };
    this._listen(this.canvas, 'touchend', lookEnd);
    this._listen(this.canvas, 'touchcancel', lookEnd);

    // 버튼들
    this._holdBtn('bFire', (v) => { this.fire = v; });
    this._holdBtn('bAds', (v) => { this.ads = v; }, true);
    this._holdBtn('bSpr', (v) => { this.sprint = v; }, true);
    this._holdBtn('bCrch', (v) => { this.crouch = v; }, true);
    this._holdBtn('bUse', (v) => { this.use = v; });
    this._holdBtn('bPeek', (v) => { this.peek = v; });
    this._tapBtn('bJump', () => { this.jump = true; });
    this._tapBtn('bRel', () => { this.reload = true; });
    this._tapBtn('bDoor', () => { this.door = true; });
    this._tapBtn('bKick', () => { this.kick = true; });
    this._tapBtn('bShout', () => { this.shout = true; });
    this._tapBtn('bNade', () => { this.throwGrenade = true; });
    this._tapBtn('bNadeSel', () => { this.grenadeSlot = -1; });   // -1 = 다음 장비
  }

  /** 누르는 동안 true. toggle=true 면 탭할 때마다 on/off */
  _holdBtn(id, set, toggle = false) {
    const el = document.getElementById(id);
    if (!el) return;
    let on = false;
    this._resetButtons.push(() => { on = false; set(false); el.classList.remove('on'); });
    this._listen(el, 'touchstart', (e) => {
      if (!this.enabled) return;
      if (toggle) { on = !on; set(on); el.classList.toggle('on', on); }
      else { set(true); el.classList.add('on'); }
      e.preventDefault();
    }, { passive: false });
    const off = (e) => {
      if (!toggle) { set(false); el.classList.remove('on'); }
      e.preventDefault();
    };
    this._listen(el, 'touchend', off);
    this._listen(el, 'touchcancel', off);
  }

  _tapBtn(id, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    this._listen(el, 'touchstart', (e) => {
      if (!this.enabled) return;
      fn();
      el.classList.add('on');
      setTimeout(() => el.classList.remove('on'), 110);
      e.preventDefault();
    }, { passive: false });
  }
}

const HANDLED_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyC', 'KeyE', 'KeyQ', 'KeyB', 'KeyV', 'KeyG',
  'Space', 'Digit1', 'Digit2', 'Digit3',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
]);
