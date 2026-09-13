/* =============================================================================
 *  input.js  -  입력 (PC 키보드+마우스 / 모바일 터치)
 *
 *  게임 로직은 이 클래스가 내놓는 "의도"만 본다. 어떤 기기로 조작하든 결과는 같다.
 *    move   : {x, y}  좌우 / 앞뒤 (-1 ~ 1)
 *    look   : {dx, dy} 이번 프레임에 돌린 양 (라디안). 읽으면 0으로 초기화된다.
 *    fire / ads / sprint / crouch / jump / reload / use : boolean
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
    this.jump = false;
    this.reload = false;
    this.use = false;

    this.enabled = false;
    this.locked = false;

    this._keys = new Set();
    this._lookTouchId = null;
    this._stickTouchId = null;
    this._onLockChange = null;

    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
  }

  enable()  { this.enabled = true; }
  disable() {
    this.enabled = false;
    this._keys.clear();
    this.move.x = this.move.y = 0;
    this.fire = this.ads = this.sprint = this.crouch = this.jump = this.reload = this.use = false;
    this.releasePointer();
  }

  /** 이번 프레임 시점 이동량을 읽고 비운다 */
  consumeLook() {
    const d = { dx: this.look.dx, dy: this.look.dy };
    this.look.dx = this.look.dy = 0;
    return d;
  }

  /** 한 번만 처리해야 하는 입력(점프/장전)을 읽고 비운다 */
  consumeJump()   { const v = this.jump;   this.jump = false;   return v; }
  consumeReload() { const v = this.reload; this.reload = false; return v; }

  /* ---- PC: 키보드 ------------------------------------------------------- */
  _bindKeyboard() {
    const down = (e) => {
      if (!this.enabled) return;
      const k = e.code;
      if (HANDLED_KEYS.has(k)) e.preventDefault();
      if (this._keys.has(k)) return;   // 키 반복 무시
      this._keys.add(k);

      if (k === 'Space')  this.jump = true;
      if (k === 'KeyR')   this.reload = true;
      this._syncKeys();
    };
    const up = (e) => {
      this._keys.delete(e.code);
      this._syncKeys();
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    // 탭 전환 등으로 keyup 을 놓치면 키가 눌린 채로 남는다
    addEventListener('blur', () => { this._keys.clear(); this._syncKeys(); });
  }

  _syncKeys() {
    const k = this._keys;
    let x = 0, y = 0;
    if (k.has('KeyW') || k.has('ArrowUp'))    y += 1;
    if (k.has('KeyS') || k.has('ArrowDown'))  y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft'))  x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }

    // 터치 조이스틱이 잡고 있으면 키보드가 덮어쓰지 않게 한다
    if (this._stickTouchId === null) { this.move.x = x; this.move.y = y; }

    this.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    this.crouch = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC');
    this.use    = k.has('KeyF');
  }

  /* ---- PC: 마우스 + 포인터 락 ------------------------------------------- */
  _bindMouse() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) { this.requestPointer(); return; }
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.ads = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.ads = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('mousemove', (e) => {
      if (!this.enabled || !this.locked) return;
      const s = this.settings.sensitivity ?? 1;
      this.look.dx += e.movementX * MOUSE_SENS * s;
      this.look.dy += e.movementY * MOUSE_SENS * s * (this.settings.invertY ? -1 : 1);
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.fire = false; this.ads = false; }
      this._onLockChange?.(this.locked);
    });
  }

  onLockChange(fn) { this._onLockChange = fn; }

  requestPointer() {
    if (isTouchDevice) return;
    this.canvas.requestPointerLock?.();
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
    stick.addEventListener('touchstart', stickStart, { passive: false });
    stick.addEventListener('touchmove', stickMove, { passive: false });
    stick.addEventListener('touchend', stickEnd);
    stick.addEventListener('touchcancel', stickEnd);

    // 화면 오른쪽 빈 곳을 끌면 시점 회전
    let last = { x: 0, y: 0 };
    this.canvas.addEventListener('touchstart', (e) => {
      if (!this.enabled || this._lookTouchId !== null) return;
      const t = e.changedTouches[0];
      this._lookTouchId = t.identifier;
      last = { x: t.clientX, y: t.clientY };
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
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
    this.canvas.addEventListener('touchend', lookEnd);
    this.canvas.addEventListener('touchcancel', lookEnd);

    // 버튼들
    this._holdBtn('bFire',  (v) => { this.fire = v; });
    this._holdBtn('bAds',   (v) => { this.ads = v; }, true);
    this._holdBtn('bSpr',   (v) => { this.sprint = v; }, true);
    this._holdBtn('bCrch',  (v) => { this.crouch = v; }, true);
    this._holdBtn('bUse',   (v) => { this.use = v; });
    this._tapBtn('bJump',   () => { this.jump = true; });
    this._tapBtn('bRel',    () => { this.reload = true; });
  }

  /** 누르는 동안 true. toggle=true 면 탭할 때마다 on/off */
  _holdBtn(id, set, toggle = false) {
    const el = document.getElementById(id);
    if (!el) return;
    let on = false;
    el.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      if (toggle) { on = !on; set(on); el.classList.toggle('on', on); }
      else { set(true); el.classList.add('on'); }
      e.preventDefault();
    }, { passive: false });
    const off = (e) => {
      if (!toggle) { set(false); el.classList.remove('on'); }
      e.preventDefault();
    };
    el.addEventListener('touchend', off);
    el.addEventListener('touchcancel', off);
  }

  _tapBtn(id, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      fn();
      el.classList.add('on');
      setTimeout(() => el.classList.remove('on'), 110);
      e.preventDefault();
    }, { passive: false });
  }
}

const HANDLED_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyC', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
]);
