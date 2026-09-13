/* =============================================================================
 *  net.js  -  서버와의 통신
 *
 *  중요한 개념 두 가지
 *
 *  1) 시계 맞추기(clock offset)
 *     서버가 보내는 스냅샷에는 "서버 시각" 이 찍혀 있다. 내 브라우저 시각과는
 *     다를 수 있으므로, 핑을 재서 offset 을 구해두고 보간할 때 쓴다.
 *       serverNow() = Date.now() + offset
 *
 *  2) 보간 지연(interpolation delay)
 *     남의 캐릭터는 "지금" 이 아니라 "110ms 전" 모습을 그린다.
 *     그래야 패킷이 조금 늦게 와도 끊기지 않고 부드럽게 움직인다.
 *
 *  모든 이벤트는 on(name, fn) 으로 구독한다.
 * ========================================================================== */

import { NET } from './config.js';

export class NetClient {
  constructor() {
    /** @type {import('socket.io-client').Socket} */
    this.socket = null;
    this.id = null;
    this.room = null;
    this.connected = false;

    this.clockOffset = 0;     // 서버시각 - 내시각
    this.rtt = 0;
    this._offsetSamples = [];

    this._handlers = new Map();
    this._inputTimer = null;
    this._pingTimer = null;
  }

  /* ======================================================================= *
   *  연결
   * ==================================================================== */
  connect() {
    return new Promise((resolve, reject) => {
      if (typeof io === 'undefined') {
        reject(new Error('socket.io 를 못 불러왔습니다. 서버가 켜져 있는지 확인하세요.'));
        return;
      }
      // eslint-disable-next-line no-undef
      this.socket = io({ transports: ['websocket', 'polling'] });

      const fail = (err) => reject(new Error('서버에 연결할 수 없습니다: ' + (err?.message || err)));

      this.socket.on('connect', () => {
        this.connected = true;
        this.id = this.socket.id;
        this._bindAll();
        this._startPing();
        resolve(this);
      });
      this.socket.on('connect_error', fail);
      this.socket.on('disconnect', (reason) => {
        this.connected = false;
        this._emit('disconnect', reason);
      });
    });
  }

  /* --- 서버 -> 클라 이벤트를 전부 중계 --- */
  _bindAll() {
    const passthrough = [
      'lobby', 'matchStart', 'snapshot', 'matchEnd',
      'playerShot', 'botShot', 'playerHit', 'playerDown', 'playerReload', 'playerLeft',
      'botHit', 'botDown', 'siteProgress', 'siteDefused',
    ];
    for (const name of passthrough) {
      this.socket.on(name, (data) => {
        if (name === 'snapshot') this._onSnapshot(data);
        this._emit(name, data);
      });
    }
  }

  _onSnapshot(snap) {
    // 스냅샷이 올 때마다 시계 오차를 살짝씩 보정한다 (핑 측정을 못 믿을 때 대비)
    const est = snap.t - Date.now() + this.rtt / 2;
    this.clockOffset += (est - this.clockOffset) * 0.05;
  }

  /* ======================================================================= *
   *  핑 / 시계
   * ==================================================================== */
  _startPing() {
    const ping = () => {
      const t0 = Date.now();
      this.socket.emit('ping:rtt', t0, (echo) => {
        const now = Date.now();
        this.rtt = now - echo;
        // 첫 몇 번은 빠르게 수렴시킨다
        this._offsetSamples.push(this.rtt);
        if (this._offsetSamples.length > 8) this._offsetSamples.shift();
      });
    };
    ping();
    this._pingTimer = setInterval(ping, 2000);
  }

  /** 지금의 서버 시각(추정) */
  serverNow() { return Date.now() + this.clockOffset; }

  /** 남의 캐릭터를 그릴 시각 */
  renderTime() { return this.serverNow() - NET.interpDelayMs; }

  /* ======================================================================= *
   *  방
   * ==================================================================== */
  createRoom(name, weapon) {
    return new Promise((resolve) => {
      this.socket.emit('createRoom', { name, weapon }, (res) => {
        if (res?.ok) { this.room = res.lobby.code; this.id = res.you; }
        resolve(res);
      });
    });
  }

  joinRoom(code, name, weapon) {
    return new Promise((resolve) => {
      this.socket.emit('joinRoom', { code, name, weapon }, (res) => {
        if (res?.ok) { this.room = res.lobby.code; this.id = res.you; }
        resolve(res);
      });
    });
  }

  leaveRoom() {
    this.stopInputLoop();
    this.socket?.emit('leaveRoom');
    this.room = null;
  }

  setLoadout(weapon, ready) { this.socket?.emit('setLoadout', { weapon, ready }); }
  setRoomConfig(cfg)        { this.socket?.emit('setRoomConfig', cfg); }
  startMatch()              { this.socket?.emit('startMatch'); }
  reload()                  { this.socket?.emit('reload'); }
  defuse(siteId, active)    { this.socket?.emit('defuse', { siteId, active }); }

  /**
   * 사격 보고. 서버가 맞았는지 최종 판정해서 콜백으로 알려준다.
   * (클라가 "맞췄다" 고 우기지 못하게 방향만 보낸다)
   */
  shoot(dir, cb) {
    this.socket?.emit('shoot', { dx: dir.x, dy: dir.y, dz: dir.z }, cb);
  }

  /* ======================================================================= *
   *  내 위치를 주기적으로 보내기
   * ==================================================================== */
  startInputLoop(getState) {
    this.stopInputLoop();
    const period = 1000 / NET.inputHz;
    this._inputTimer = setInterval(() => {
      if (!this.connected) return;
      const s = getState();
      if (s) this.socket.emit('input', s);
    }, period);
  }

  stopInputLoop() {
    if (this._inputTimer) { clearInterval(this._inputTimer); this._inputTimer = null; }
  }

  /* ======================================================================= *
   *  간단한 이벤트 버스
   * ==================================================================== */
  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
    return () => this._handlers.get(name)?.delete(fn);
  }

  _emit(name, data) {
    const set = this._handlers.get(name);
    if (!set) return;
    for (const fn of set) {
      try { fn(data); } catch (err) { console.error(`[net] ${name} 처리 중 오류`, err); }
    }
  }

  dispose() {
    this.stopInputLoop();
    if (this._pingTimer) clearInterval(this._pingTimer);
    this.socket?.disconnect();
    this._handlers.clear();
  }
}
