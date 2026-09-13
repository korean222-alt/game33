/* =============================================================================
 *  audio.js  -  WebAudio 로 효과음을 "합성" 한다
 *
 *  왜 합성하나?
 *    - mp3/wav 파일을 안 받아도 되니까 첫 로딩이 0초다 (모바일에서 중요)
 *    - 총소리/발소리를 매번 조금씩 다르게 만들 수 있어서 덜 지겹다
 *
 *  소리 파일을 쓰고 싶으면 loadSample() 로 버퍼를 넣고
 *  play() 안에서 해당 키만 갈아끼우면 된다.
 *
 *  ※ iOS 는 "사용자가 화면을 만지기 전" 에는 소리를 못 낸다.
 *    그래서 resume() 을 첫 터치/클릭에서 반드시 불러줘야 한다.
 * ========================================================================== */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.ready = false;
    this.samples = new Map();   // 직접 넣은 오디오 파일이 있으면 여기에
    this._noise = null;
    this._ambient = null;
  }

  /** 첫 사용자 입력에서 호출 (iOS 필수) */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this._noise = this._makeNoiseBuffer(2.0);
      this.ready = true;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /* --------------------------------------------------------------------- */
  _makeNoiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 화이트노이즈 소스 하나 생성 */
  _noiseSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    return s;
  }

  /**
   * 3D 위치감: 거리에 따라 볼륨을 줄이고 좌우로 배치한다.
   * listener 는 { x, z, yaw }.  pos 는 { x, z }.
   */
  _spatial(pos, listener, maxDist = 26) {
    const g = this.ctx.createGain();
    if (!pos || !listener) { g.gain.value = 1; g.connect(this.master); return g; }

    const dx = pos.x - listener.x;
    const dz = pos.z - listener.z;
    const d = Math.hypot(dx, dz);

    // 거리 감쇠 (선형에 가깝게 - 실내라 멀리 안 간다)
    const att = Math.max(0, 1 - d / maxDist);
    g.gain.value = att * att;

    // 좌우 정위: 내 시선 기준으로 소리가 왼쪽인지 오른쪽인지
    const pan = this.ctx.createStereoPanner
      ? this.ctx.createStereoPanner()
      : null;
    if (pan) {
      const fwdX = -Math.sin(listener.yaw), fwdZ = -Math.cos(listener.yaw);
      const rightX = -fwdZ, rightZ = fwdX;
      const side = d > 0.01 ? (dx * rightX + dz * rightZ) / d : 0;
      pan.pan.value = Math.max(-1, Math.min(1, side));
      g.connect(pan); pan.connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  /* =========================================================================
   *  총성
   *
   *  구조:  [짧고 센 저역 '퍽'] + [필터 걸린 노이즈 '탕'] + [잔향 꼬리]
   * ====================================================================== */
  shot(weapon = 'rifle', pos = null, listener = null, mine = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;

    const spec = {
      rifle:  { punch: 118, noiseHz: 2100, q: 0.7, dur: 0.20, tail: 0.34, gain: 0.85 },
      smg:    { punch: 145, noiseHz: 2600, q: 0.8, dur: 0.15, tail: 0.24, gain: 0.70 },
      sniper: { punch:  78, noiseHz: 1500, q: 0.5, dur: 0.34, tail: 0.62, gain: 1.00 },
    }[weapon] || { punch: 118, noiseHz: 2100, q: 0.7, dur: 0.20, tail: 0.34, gain: 0.85 };

    const out = this._spatial(pos, listener, 34);
    // 내 총은 항상 또렷하게
    if (mine) out.gain.value = 1.0;

    /* 1) 저역 '퍽' - 총구 압력 */
    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(spec.punch, t);
    osc.frequency.exponentialRampToValueAtTime(spec.punch * 0.35, t + spec.dur);
    og.gain.setValueAtTime(spec.gain * 0.9, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
    osc.connect(og); og.connect(out);
    osc.start(t); osc.stop(t + spec.dur + 0.02);

    /* 2) 노이즈 '탕' */
    const n = this._noiseSource();
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.setValueAtTime(spec.noiseHz, t);
    nf.frequency.exponentialRampToValueAtTime(spec.noiseHz * 0.28, t + spec.tail);
    nf.Q.value = spec.q;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(spec.gain, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + spec.tail);
    n.connect(nf); nf.connect(ng); ng.connect(out);
    n.start(t); n.stop(t + spec.tail + 0.02);

    /* 3) 실내 잔향 꼬리 - 좁은 시장 안이라 제법 울린다 */
    const rv = this._noiseSource();
    const rf = this.ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 900;
    const rg = this.ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.linearRampToValueAtTime(spec.gain * 0.30, t + 0.03);
    rg.gain.exponentialRampToValueAtTime(0.0001, t + spec.tail * 2.1);
    rv.connect(rf); rf.connect(rg); rg.connect(out);
    rv.start(t); rv.stop(t + spec.tail * 2.2);
  }

  /** 딸깍 (탄창 비었을 때) */
  dryFire() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 2600;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    n.connect(f); f.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 0.05);
  }

  /** 재장전: 탄창 빼고 - 넣고 - 노리쇠 (3박자) */
  reload(duration = 2.3) {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime;
    const beats = [
      { at: 0.05,               f: 520,  g: 0.24, d: 0.07 },
      { at: duration * 0.48,    f: 360,  g: 0.30, d: 0.09 },
      { at: duration * 0.86,    f: 900,  g: 0.26, d: 0.06 },
    ];
    for (const b of beats) {
      const t = t0 + b.at;
      const n = this._noiseSource();
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = b.f; f.Q.value = 2.2;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(b.g, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + b.d);
      n.connect(f); f.connect(g); g.connect(this.master);
      n.start(t); n.stop(t + b.d + 0.01);
    }
  }

  /** 총알이 벽/물체에 맞는 소리 */
  impact(pos, listener, material = 'concrete') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._spatial(pos, listener, 22);
    const hz = material === 'metal' ? 3200 : material === 'wood' ? 1400 : 2200;

    const n = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = hz * (0.8 + Math.random() * 0.4); f.Q.value = 1.4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t); n.stop(t + 0.1);
  }

  /** 살에 맞는 소리 (둔탁) */
  flesh(pos, listener) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._spatial(pos, listener, 20);
    const n = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 520;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t); n.stop(t + 0.14);
  }

  /** 내가 맞았을 때 - 귀울림 + 신음 느낌의 저역 */
  hurt() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.25);
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.3);
  }

  /** 발소리 */
  step(pos, listener, running = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this._spatial(pos, listener, 14);
    const n = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = (running ? 900 : 640) * (0.8 + Math.random() * 0.4);
    f.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(running ? 0.20 : 0.11, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t); n.stop(t + 0.08);
  }

  /** 해체 진행 비프 (progress 0~1 에 따라 음이 올라간다) */
  beep(progress = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = 620 + progress * 620;
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.08);
  }

  /** 목표 달성 / 실패 화음 */
  jingle(win = true) {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime;
    const notes = win ? [523.25, 659.25, 783.99, 1046.5] : [392, 349.23, 293.66, 220];
    notes.forEach((hz, i) => {
      const t = t0 + i * 0.13;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.45);
    });
  }

  /** 실내 배경음 (형광등 웅웅 + 아주 낮은 잡음) - 한 번만 켠다 */
  startAmbient() {
    if (!this.ready || this._ambient) return;
    const g = this.ctx.createGain();
    g.gain.value = 0.035;
    g.connect(this.master);

    const n = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 340;
    n.connect(f); f.connect(g);
    n.start();

    // 형광등 60Hz 험
    const hum = this.ctx.createOscillator();
    const hg = this.ctx.createGain();
    hum.type = 'sine'; hum.frequency.value = 60;
    hg.gain.value = 0.012;
    hum.connect(hg); hg.connect(this.master);
    hum.start();

    this._ambient = { n, hum, g, hg };
  }

  stopAmbient() {
    if (!this._ambient) return;
    try { this._ambient.n.stop(); this._ambient.hum.stop(); } catch { /* 이미 멈춤 */ }
    this._ambient = null;
  }
}

export const audio = new AudioEngine();
