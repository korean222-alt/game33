// Original procedural effects; no downloaded recordings or external requests.
// AudioContext is created/resumed only by a user gesture (including iOS).
export class GameAudio {
  constructor({ enabled = true, volume = 0.55, contextFactory } = {}) {
    this.enabled = enabled;
    this.volume = volume;
    this.contextFactory = contextFactory || (() => {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      return Context ? new Context() : null;
    });
    this.sources = new Set();
    this.nodes = new Set();
    this.reloadSources = new Set();
    this.position = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.closed = false;
  }

  bind(target) {
    this.events = new AbortController();
    const unlock = () => { void this.unlock(); };
    target.addEventListener('pointerdown', unlock, { signal: this.events.signal });
    target.addEventListener('keydown', unlock, { signal: this.events.signal });
  }

  async unlock() {
    if (!this.enabled || this.closed) return;
    try {
      if (!this.context) {
        this.context = this.contextFactory();
        if (!this.context) return;
        this.master = this.context.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.context.destination);
        const length = this.context.sampleRate;
        this.noise = this.context.createBuffer(1, length, length);
        const samples = this.noise.getChannelData(0);
        for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
      }
      if (this.context.state === 'suspended') await this.context.resume();
    } catch { /* Unsupported/blocked audio must not stop gameplay. */ }
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
    if (!this.enabled) this.stop();
    else void this.unlock();
  }

  setListener(position, yaw) {
    this.position = { x: position.x, y: position.y, z: position.z };
    this.yaw = yaw;
  }

  _bus(position, occluded = false) {
    const context = this.context;
    if (!this.enabled || context?.state !== 'running') return null;
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = occluded ? 700 : 18000;
    gain.connect(filter);
    const dx = (position?.x ?? this.position.x) - this.position.x;
    const dz = (position?.z ?? this.position.z) - this.position.z;
    const distance = position ? Math.hypot(dx, dz, (position.y ?? 0) - this.position.y) : 0;
    gain.gain.value = (occluded ? 0.3 : 1) / (1 + distance * 0.09);
    let pan = null;
    if (context.createStereoPanner) {
      pan = context.createStereoPanner();
      // Camera right is (cos(yaw), 0, -sin(yaw)).
      pan.pan.value = distance > 0.01 ? Math.max(-1, Math.min(1,
        (dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) / distance)) : 0;
      filter.connect(pan);
      pan.connect(this.master);
    } else filter.connect(this.master);
    for (const node of [gain, filter, pan].filter(Boolean)) this.nodes.add(node);
    return { gain, nodes: [gain, filter, pan].filter(Boolean), pending: 0 };
  }

  _voice(bus, { at = 0, duration = 0.08, level = 0.3, frequency = 900, tone = false }, reload = false) {
    const context = this.context;
    const source = tone ? context.createOscillator() : context.createBufferSource();
    if (tone) {
      source.frequency.setValueAtTime(frequency, context.currentTime + at);
      source.frequency.exponentialRampToValueAtTime(Math.max(30, frequency * 0.3), context.currentTime + at + duration);
    } else source.buffer = this.noise;
    const filter = context.createBiquadFilter();
    filter.type = tone ? 'lowpass' : 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 0.6;
    const envelope = context.createGain();
    const start = context.currentTime + at;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(level, start + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter); filter.connect(envelope); envelope.connect(bus.gain);
    bus.pending++;
    this.sources.add(source);
    if (reload) this.reloadSources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.reloadSources.delete(source);
      source.disconnect(); filter.disconnect(); envelope.disconnect();
      if (--bus.pending === 0) {
        for (const node of bus.nodes) { node.disconnect(); this.nodes.delete(node); }
      }
    };
    source.start(start);
    source.stop(start + duration + 0.015);
  }

  /**
   * 총성. 세 겹으로 만든다.
   *   1) 총구 파열음(밴드패스 노이즈)  2) 저역 충격  3) 금속 찰칵
   * 실내(indoor)면 잔향 꼬리를 붙인다. 같은 총도 방 안과 밖이 다르게 들려야
   * 소리만으로 위치를 짐작할 수 있다.
   */
  shot(weapon = 'rifle', position = null, occluded = false, indoor = true) {
    const bus = this._bus(position, occluded);
    if (!bus) return;
    const heavy = weapon === 'sniper', light = weapon === 'smg';
    this._voice(bus, { duration: heavy ? 0.28 : light ? 0.09 : 0.16, level: heavy ? 0.9 : 0.65, frequency: light ? 2200 : 1300 });
    this._voice(bus, { duration: heavy ? 0.3 : 0.13, level: 0.45, frequency: heavy ? 95 : 150, tone: true });
    this._voice(bus, { at: 0.018, duration: 0.04, level: 0.18, frequency: 3600 });
    // 잔향: 벽에 부딪혀 돌아오는 소리. 실내가 더 길고 낮다.
    this._voice(bus, {
      at: indoor ? 0.035 : 0.02,
      duration: indoor ? (heavy ? 0.62 : 0.42) : 0.16,
      level: indoor ? 0.2 : 0.08, frequency: indoor ? 520 : 900,
    });
    // 탄피. 내 총일 때만 들릴 만큼 작게.
    if (!position) {
      this._voice(bus, { at: 0.24, duration: 0.05, level: 0.07, frequency: 5200 });
      this._voice(bus, { at: 0.31, duration: 0.04, level: 0.05, frequency: 4200 });
    }
  }

  /** 빈 약실. 방아쇠는 당겼는데 탄이 없다. */
  dryFire() {
    const bus = this._bus();
    if (!bus) return;
    this._voice(bus, { duration: 0.035, level: 0.22, frequency: 2600 });
    this._voice(bus, { at: 0.03, duration: 0.03, level: 0.12, frequency: 1500 });
  }

  /** 탄착. 재질에 따라 밝기를 달리한다. */
  impact(position = null, material = 'concrete') {
    const bus = this._bus(position);
    if (!bus) return;
    const bright = material === 'metal' ? 4200 : material === 'wood' ? 1500 : 2400;
    this._voice(bus, { duration: 0.06, level: 0.3, frequency: bright });
    this._voice(bus, { at: 0.01, duration: 0.09, level: 0.14, frequency: 260, tone: true });
  }

  /** 내가 맞았을 때. 둔탁한 충격 + 짧은 이명. */
  hurt() {
    const bus = this._bus();
    if (!bus) return;
    this._voice(bus, { duration: 0.14, level: 0.5, frequency: 190 });
    this._voice(bus, { at: 0.02, duration: 0.3, level: 0.1, frequency: 90, tone: true });
  }

  /** 용의자가 나를 발견하고 외치는 소리. 총알보다 먼저 도착한다. */
  contact(position = null) {
    const bus = this._bus(position);
    if (!bus) return;
    this._voice(bus, { duration: 0.16, level: 0.4, frequency: 720, tone: true });
    this._voice(bus, { at: 0.17, duration: 0.13, level: 0.3, frequency: 520, tone: true });
  }

  /** 폭발 / 섬광 / 가스 분출. */
  blast(type = 'frag', position = null, occluded = false) {
    const bus = this._bus(position, occluded);
    if (!bus) return;
    if (type === 'gas') {
      this._voice(bus, { duration: 1.4, level: 0.24, frequency: 1800 });
      return;
    }
    const flash = type === 'flash';
    this._voice(bus, { duration: flash ? 0.22 : 0.5, level: 1, frequency: flash ? 1800 : 700 });
    this._voice(bus, { duration: flash ? 0.3 : 0.8, level: 0.6, frequency: flash ? 140 : 70, tone: true });
    this._voice(bus, { at: 0.06, duration: flash ? 0.5 : 1.1, level: 0.22, frequency: 380 });
  }

  /** 투척물이 바닥/벽에 튀는 소리. */
  bounce(position = null) {
    const bus = this._bus(position);
    if (!bus) return;
    this._voice(bus, { duration: 0.05, level: 0.18, frequency: 3200 });
  }

  /** 발소리. 앉아 걸으면 거의 들리지 않는다. */
  footstep({ crouch = false, sprint = false } = {}) {
    const bus = this._bus();
    if (!bus) return;
    this._voice(bus, {
      duration: 0.07,
      level: crouch ? 0.05 : sprint ? 0.16 : 0.1,
      frequency: crouch ? 420 : 620,
    });
  }

  /**
   * 장전. 탄창 해제 걸쇠 -> 빈 탄창 낙하 -> 새 탄창 삽입 -> 노리쇠 전진 순으로
   * 네 박자를 찍는다. 총마다 장전 시간이 달라서 박자 간격도 달라진다.
   */
  reload(seconds = 2.3) {
    this.cancelReload();
    const bus = this._bus();
    if (!bus) return;
    const total = Math.max(0.5, Math.min(8, Number(seconds) || 2.3));
    const stages = [
      [0, 1600, 0.22, 0.06],     // 탄창 멈치
      [0.2, 650, 0.3, 0.11],     // 빈 탄창이 빠져 바닥에 떨어진다
      [0.65, 1100, 0.4, 0.09],   // 새 탄창 삽입
      [0.9, 2800, 0.32, 0.07],   // 노리쇠 전진
    ];
    for (const [fraction, frequency, level, duration] of stages) {
      this._voice(bus, { at: total * fraction, duration, frequency, level }, true);
    }
    // 빈 탄창이 바닥에 닿는 소리
    this._voice(bus, { at: total * 0.34, duration: 0.09, frequency: 300, level: 0.12 }, true);
  }

  /**
   * 문. 동작마다 다르게 들려야 한다. 강제 개방은 방 전체가 알아챌 만큼 크다.
   * @param position  문 위치 (없으면 내 위치)
   * @param action    'open' | 'close' | 'kick' | 'unlock' | 'peek'
   */
  door(position, action = 'open') {
    const bus = this._bus(position);
    if (!bus) return;
    if (action === 'kick' || action === 'breach') {
      this._voice(bus, { duration: 0.1, level: 0.85, frequency: 320 });
      this._voice(bus, { at: 0.01, duration: 0.34, level: 0.5, frequency: 80, tone: true });
      this._voice(bus, { at: 0.12, duration: 0.22, level: 0.2, frequency: 1400 });
      return;
    }
    if (action === 'unlock') {
      for (let i = 0; i < 4; i++) {
        this._voice(bus, { at: 0.1 + i * 0.16, duration: 0.03, level: 0.13, frequency: 3000 + i * 260 });
      }
      return;
    }
    if (action === 'peek') {
      this._voice(bus, { duration: 0.2, level: 0.05, frequency: 900 });
      return;
    }
    // 손잡이가 돌아가고 경첩이 운다.
    this._voice(bus, { duration: 0.05, level: 0.2, frequency: 2600 });
    this._voice(bus, { at: 0.06, duration: 0.26, level: 0.16, frequency: 430 });
    this._voice(bus, { at: 0.08, duration: 0.2, level: 0.12, frequency: 120, tone: true });
    if (action === 'close') this._voice(bus, { at: 0.3, duration: 0.08, level: 0.3, frequency: 260 });
  }

  cancelReload() {
    for (const source of this.reloadSources) { try { source.stop(); } catch {} }
    this.reloadSources.clear();
  }

  stop() {
    for (const source of this.sources) { try { source.stop(); } catch {} }
    this.sources.clear();
    this.reloadSources.clear();
  }

  dispose() {
    this.closed = true;
    this.events?.abort();
    this.stop();
    for (const node of this.nodes) node.disconnect();
    this.nodes.clear();
    this.master?.disconnect();
    void this.context?.close().catch(() => {});
  }
}
