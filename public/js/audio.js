// Original procedural effects; no downloaded recordings or external requests.
// AudioContext is created/resumed only by a user gesture (including iOS).

/*
 * 출력 크기.
 *
 * 헤드리스 브라우저에서 오프라인 렌더링으로 재 보니 총성이 최대 0.25(-12dBFS),
 * 비명·수갑·장전은 0.03~0.08(-30~-22dBFS)밖에 나오지 않았다. 소리가 "안 나는"
 * 게 아니라 들리지 않을 만큼 작았다. 전체를 올리고, 목소리 계열은 필터가 먹는
 * 만큼 따로 더 올린다.
 *   npm run audio:levels 로 언제든 다시 잴 수 있다.
 */
const BOOST = 2.0;        // 모든 소리 공통 배율
const VOX_MAKEUP = 4;     // 대역통과 두 겹을 지나며 잃는 만큼 목소리에 더 준다

export class GameAudio {
  constructor({ enabled = true, volume = 0.8, contextFactory } = {}) {
    this.enabled = enabled;
    this.volume = volume;
    this.contextFactory = contextFactory || (() => {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      return Context ? new Context() : null;
    });
    this.sources = new Set();
    this.nodes = new Set();
    this.reloadSources = new Set();
    this.loops = new Map();
    this.speechEnabled = true;
    this._englishVoiceCache = null;
    this._speechPrimed = false;
    this._badVoices = new Set();   // 골랐지만 소리가 나지 않았던 목소리
    this.blocked = false;
    this.position = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.closed = false;
  }

  /**
   * 소리를 켜 줄 첫 제스처를 기다린다.
   *
   * 브라우저는 사용자가 한 번 만지기 전에는 소리를 내지 못하게 막는다. 예전에는
   * pointerdown / keydown 만 들었는데, 터치 기기에서 touchstart 만 오고
   * pointerdown 이 오지 않는 경우(그리고 포인터 잠금 중의 click) 소리가 영영
   * 켜지지 않았다. 들을 수 있는 제스처를 전부 듣는다.
   */
  bind(target) {
    this.events = new AbortController();
    const unlock = () => { void this.unlock(); };
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown']) {
      target.addEventListener(type, unlock, { signal: this.events.signal, passive: true });
    }
  }

  /** 소리가 실제로 나고 있는가 (안 나면 화면에 안내를 띄운다). */
  get running() { return this.context?.state === 'running'; }

  async unlock() {
    if (!this.enabled || this.closed) return;
    // 목소리 목록은 준비되는 데 시간이 걸린다. 첫 제스처에 미리 불러 둔다.
    this._primeSpeech();
    try {
      if (!this.context) {
        this.context = this.contextFactory();
        if (!this.context) return;
        this.master = this.context.createGain();
        this.master.gain.value = this.volume;
        /* 리미터(DynamicsCompressor)를 한 번 넣어 봤다가 뺐다. 어떤 설정을
         * 줘도 그 노드를 지나는 것만으로 12dB 가까이 깎여서(총성 0.66 -> 0.15),
         * 크기를 올린 의미가 사라졌다. 오프라인 렌더링으로 확인했다.
         * 대신 소리마다 최대 크기를 1.0 아래로 맞춰 뒀다. */
        this.master.connect(this.context.destination);
        const length = this.context.sampleRate;
        this.noise = this.context.createBuffer(1, length, length);
        const samples = this.noise.getChannelData(0);
        for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
      }
      // iOS 는 전화가 오면 'interrupted' 로 간다. 'suspended' 만 보면 그 뒤로
      // 소리가 영영 돌아오지 않는다.
      if (this.context.state !== 'running') await this.context.resume();
      this.blocked = this.context.state !== 'running';
    } catch { /* Unsupported/blocked audio must not stop gameplay. */ }
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
    if (!this.enabled) { this.stop(); this.cancelSpeech(); }
    else void this.unlock();
  }

  /** 0~1. 메뉴의 소리 크기 조절. */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1.5, Number(volume) || 0));
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
  }

  setListener(position, yaw) {
    this.position = { x: position.x, y: position.y, z: position.z };
    this.yaw = yaw;
  }

  _bus(position, occluded = false) {
    const context = this.context;
    // 멈춘 컨텍스트를 그냥 지나치면 한 번 막힌 소리가 끝까지 돌아오지 않는다.
    // 다음 소리를 위해 깨우기를 다시 시도한다.
    if (this.enabled && !this.closed && context && context.state !== 'running') void this.unlock();
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
    const peak = level * BOOST;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(peak, start + 0.003);
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
    this._voice(bus, { duration: 0.035, level: 0.5, frequency: 2600 });
    this._voice(bus, { at: 0.03, duration: 0.03, level: 0.3, frequency: 1500 });
  }

  /** 탄착. 재질에 따라 밝기를 달리한다. */
  impact(position = null, material = 'concrete') {
    const bus = this._bus(position);
    if (!bus) return;
    const bright = material === 'metal' ? 4200 : material === 'wood' ? 1500 : 2400;
    this._voice(bus, { duration: 0.06, level: 0.45, frequency: bright });
    this._voice(bus, { at: 0.01, duration: 0.09, level: 0.22, frequency: 260, tone: true });
  }

  /** 내가 맞았을 때. 둔탁한 충격 + 짧은 이명. */
  hurt() {
    const bus = this._bus();
    if (!bus) return;
    this._voice(bus, { duration: 0.14, level: 0.85, frequency: 190 });
    this._voice(bus, { at: 0.02, duration: 0.3, level: 0.3, frequency: 90, tone: true });
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
    this._voice(bus, { duration: flash ? 0.22 : 0.5, level: 0.8, frequency: flash ? 1800 : 700 });
    this._voice(bus, { duration: flash ? 0.3 : 0.8, level: 0.5, frequency: flash ? 140 : 70, tone: true });
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
      level: crouch ? 0.12 : sprint ? 0.4 : 0.26,
      frequency: crouch ? 420 : 620,
    });
  }

  /**
   * 장전. 탄창 해제 걸쇠 -> 빈 탄창 낙하 -> 새 탄창 삽입 -> 노리쇠 전진 순으로
   * 네 박자를 찍는다. 총마다 장전 시간이 달라서 박자 간격도 달라진다.
   */
  reload(seconds = 2.3, position = null) {
    // 남의 장전은 내 장전을 끊지 않는다. 위치가 있으면 그 사람의 장전이다.
    if (!position) this.cancelReload();
    const bus = this._bus(position);
    if (!bus) return;
    const total = Math.max(0.5, Math.min(8, Number(seconds) || 2.3));
    const stages = [
      [0, 1600, 0.5, 0.06],      // 탄창 멈치
      [0.2, 650, 0.62, 0.11],    // 빈 탄창이 빠져 바닥에 떨어진다
      [0.65, 1100, 0.8, 0.09],   // 새 탄창 삽입
      [0.9, 2800, 0.7, 0.07],    // 노리쇠 전진
    ];
    const mine = !position;
    for (const [fraction, frequency, level, duration] of stages) {
      this._voice(bus, { at: total * fraction, duration, frequency, level }, mine);
    }
    // 빈 탄창이 바닥에 닿는 소리
    this._voice(bus, { at: total * 0.34, duration: 0.09, frequency: 300, level: 0.3 }, mine);
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
        this._voice(bus, { at: 0.1 + i * 0.16, duration: 0.03, level: 0.3, frequency: 3000 + i * 260 });
      }
      return;
    }
    if (action === 'peek') {
      this._voice(bus, { duration: 0.2, level: 0.12, frequency: 900 });
      return;
    }
    // 손잡이가 돌아가고 경첩이 운다.
    this._voice(bus, { duration: 0.05, level: 0.42, frequency: 2600 });
    this._voice(bus, { at: 0.06, duration: 0.26, level: 0.34, frequency: 430 });
    this._voice(bus, { at: 0.08, duration: 0.2, level: 0.26, frequency: 120, tone: true });
    if (action === 'close') this._voice(bus, { at: 0.3, duration: 0.08, level: 0.5, frequency: 260 });
  }

  /* ======================================================================= *
   *  사람 소리
   *
   *  사람 목소리는 성대(주기적인 진동)와 입 모양(공명)으로 만들어진다. 톱니파를
   *  성대로 쓰고 대역통과 필터 두 개를 입으로 써서 "아" 에 가까운 소리를 만든다.
   *  녹음 파일을 받아 오지 않고도 비명과 신음을 낼 수 있다.
   * ======================================================================= */
  _vox(bus, {
    at = 0, duration = 0.5, level = 0.4,
    pitch = [420, 520, 240], formants = [780, 1180], type = 'sawtooth',
  } = {}) {
    const context = this.context;
    const start = context.currentTime + at;
    const source = context.createOscillator();
    source.type = type;
    source.frequency.setValueAtTime(Math.max(40, pitch[0]), start);
    for (let i = 1; i < pitch.length; i++) {
      source.frequency.exponentialRampToValueAtTime(
        Math.max(40, pitch[i]), start + duration * (i / (pitch.length - 1)));
    }

    const chain = [];
    let tail = source;
    for (let i = 0; i < formants.length; i++) {
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = formants[i];
      filter.Q.value = i === 0 ? 2.6 : 3.6;
      tail.connect(filter);
      chain.push(filter);
      tail = filter;
    }

    const envelope = context.createGain();
    const peak = level * BOOST * VOX_MAKEUP;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(peak, start + Math.min(0.045, duration * 0.18));
    envelope.gain.linearRampToValueAtTime(peak * 0.72, start + duration * 0.62);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    tail.connect(envelope);
    envelope.connect(bus.gain);
    chain.push(envelope);

    bus.pending++;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      for (const node of chain) node.disconnect();
      if (--bus.pending === 0) {
        for (const node of bus.nodes) { node.disconnect(); this.nodes.delete(node); }
      }
    };
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  /**
   * 비명 / 신음.
   * @param kind  'pain'  맞았다 ("윽")      'scream' 크게 맞았다 ("으아악")
   *              'death' 쓰러진다           'panic'  민간인의 겁먹은 소리
   *              'cuffed' 체포될 때의 항의
   */
  scream(position = null, kind = 'scream', occluded = false) {
    const bus = this._bus(position, occluded);
    if (!bus) return;
    const shapes = {
      pain: { duration: 0.34, level: 0.42, pitch: [300, 360, 170], formants: [640, 1100] },
      scream: { duration: 0.86, level: 0.6, pitch: [430, 660, 580, 230], formants: [840, 1320] },
      death: { duration: 1.05, level: 0.45, pitch: [330, 250, 120], formants: [520, 980] },
      panic: { duration: 0.62, level: 0.38, pitch: [520, 720, 430], formants: [900, 1500] },
      cuffed: { duration: 0.44, level: 0.32, pitch: [250, 300, 190], formants: [600, 1050] },
      /* 아래 셋은 "말"이 아니라 말 대신 내는 소리다. 이 소리는 모음만 있는
       * 웅얼거림이라서, 대사가 실제로 발음될 때는(speak 가 true) 겹쳐 내지
       * 않는다. 영어 목소리가 없거나 너무 멀어 말이 안 들릴 때만 쓴다. */
      shout: { duration: 0.42, level: 0.5, pitch: [300, 430, 260], formants: [720, 1250] },
      defy: { duration: 0.55, level: 0.55, pitch: [260, 400, 320], formants: [660, 1150] },
      surrender: { duration: 0.6, level: 0.4, pitch: [380, 300, 240], formants: [700, 1180] },
    };
    const shape = shapes[kind] || shapes.scream;
    this._vox(bus, shape);
    // 숨소리 한 겹. 목소리만 있으면 악기처럼 들린다.
    this._voice(bus, {
      at: shape.duration * 0.55, duration: shape.duration * 0.5,
      level: shape.level * 0.22, frequency: 1500,
    });
  }

  /**
   * 수갑. 래칫이 촘촘히 돌아가는 소리 -> 잠금쇠가 물리는 소리.
   * 체포가 끝났다는 것을 화면을 안 봐도 알 수 있어야 한다.
   */
  cuff(position = null) {
    const bus = this._bus(position);
    if (!bus) return;
    for (let i = 0; i < 7; i++) {
      this._voice(bus, { at: 0.02 + i * 0.032, duration: 0.025, level: 0.5, frequency: 4200 + i * 180 });
    }
    this._voice(bus, { at: 0.3, duration: 0.06, level: 0.62, frequency: 2600 });
    this._voice(bus, { at: 0.34, duration: 0.11, level: 0.34, frequency: 480, tone: true });
  }

  /**
   * 손으로 하는 작업 한 박자. 길게 누르는 동안 게임이 반복해서 부른다.
   * @param kind 'defuse' 공구  'evidence' 종이/가방  'revive' 장비 뒤적임
   */
  work(position = null, kind = 'defuse') {
    const bus = this._bus(position);
    if (!bus) return;
    if (kind === 'evidence') {
      this._voice(bus, { duration: 0.12, level: 0.36, frequency: 5200 });
      this._voice(bus, { at: 0.08, duration: 0.1, level: 0.24, frequency: 3400 });
      return;
    }
    if (kind === 'revive') {
      this._voice(bus, { duration: 0.09, level: 0.32, frequency: 900 });
      this._voice(bus, { at: 0.07, duration: 0.07, level: 0.24, frequency: 2200 });
      return;
    }
    // 해체: 금속 공구가 나사를 돌리는 소리 + 회로 신호음
    this._voice(bus, { duration: 0.05, level: 0.38, frequency: 3000 });
    this._voice(bus, { at: 0.05, duration: 0.07, level: 0.26, frequency: 1400 });
    this._voice(bus, { at: 0.13, duration: 0.04, level: 0.22, frequency: 2000, tone: true });
  }

  /** 확인음. 해체 완료처럼 "됐다"를 알린다. ok=false 면 실패음. */
  beep(position = null, ok = true) {
    const bus = this._bus(position);
    if (!bus) return;
    const base = ok ? 900 : 320;
    this._voice(bus, { duration: 0.1, level: 0.22, frequency: base, tone: true });
    this._voice(bus, { at: 0.12, duration: 0.16, level: 0.22, frequency: ok ? base * 1.6 : base * 0.6, tone: true });
  }

  /** 증거를 집어 가방에 넣는다. */
  pickup(position = null) {
    const bus = this._bus(position);
    if (!bus) return;
    this._voice(bus, { duration: 0.16, level: 0.4, frequency: 4800 });
    this._voice(bus, { at: 0.14, duration: 0.18, level: 0.32, frequency: 2600 });
    this._voice(bus, { at: 0.3, duration: 0.06, level: 0.26, frequency: 700 });
  }

  /** 투척물 안전핀과 던지는 동작. */
  pin() {
    const bus = this._bus();
    if (!bus) return;
    this._voice(bus, { duration: 0.03, level: 0.5, frequency: 5200 });
    this._voice(bus, { at: 0.05, duration: 0.04, level: 0.34, frequency: 3200 });
    this._voice(bus, { at: 0.16, duration: 0.12, level: 0.26, frequency: 900 });
  }

  /**
   * 섬광탄을 맞은 뒤의 이명. 화면이 하얀 동안 계속 울린다.
   * 소리로도 "지금 아무것도 못 한다"는 것을 알려 준다.
   */
  tinnitus(seconds = 3) {
    const bus = this._bus();
    if (!bus) return;
    const duration = Math.max(0.5, Math.min(8, Number(seconds) || 3));
    this._voice(bus, { duration, level: 0.16, frequency: 4400, tone: true });
    this._voice(bus, { at: 0.04, duration: duration * 0.8, level: 0.08, frequency: 6200, tone: true });
  }

  /** 가스를 마셨다. */
  cough(position = null) {
    const bus = this._bus(position);
    if (!bus) return;
    this._vox(bus, { duration: 0.16, level: 0.3, pitch: [220, 160], formants: [520, 900] });
    this._voice(bus, { at: 0.16, duration: 0.2, level: 0.14, frequency: 1800 });
  }

  /* ----------------------------------------------------------------------- *
   *  말소리
   *
   *  대사가 "우물우물" 들렸던 이유가 여기 있었다. utterance.lang 에 'en-US' 를
   *  적어 두기만 하고 목소리(voice)를 고르지 않으면, 브라우저는 그냥 기본 목소리로
   *  읽는다. 한국어 환경의 브라우저에서는 그게 한국어 목소리라서 "Police! Drop the
   *  weapon!" 을 한글 발음 규칙으로 뭉개 읽는다 - 그게 그 웅얼거림이다.
   *
   *  그래서 영어 목소리를 직접 찾아 지정하고, 영어 목소리가 아예 없는 기기에서는
   *  말하지 않는다(한국어 목소리로 영어를 읽느니 자막이 낫다).
   * ----------------------------------------------------------------------- */

  /**
   * 목소리 목록을 미리 불러 둔다.
   *
   * Chrome 은 getVoices() 를 처음 부를 때 빈 배열을 주고, 목록이 준비되면
   * voiceschanged 를 쏜다. 첫 경고를 외칠 때 목록이 비어 있으면 목소리를 못 고르므로
   * 소리를 켜는 시점(첫 제스처)에 미리 한 번 찔러 둔다.
   */
  _primeSpeech() {
    const synth = globalThis.speechSynthesis;
    if (!synth || this._speechPrimed) return;
    this._speechPrimed = true;
    try {
      synth.getVoices();
      synth.addEventListener?.('voiceschanged', () => { this._englishVoiceCache = null; });
    } catch { /* 음성 합성이 없어도 게임은 돌아간다 */ }
  }

  /**
   * 영어 목소리 고르기. 없으면 null.
   *
   * 같은 영어라도 기기마다 목록이 다르다. 미국 영어를 먼저 보고, 그중에서도
   * 자연스럽게 읽는 쪽(Google/Neural/Natural 계열)을 올려 준다.
   */
  _englishVoice() {
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof synth.getVoices !== 'function') return null;
    let voices = [];
    try { voices = synth.getVoices() || []; } catch { return null; }
    // 목록이 바뀌면(voiceschanged, 다른 기기) 캐시를 버린다.
    if (this._englishVoiceCache && voices.includes(this._englishVoiceCache)) {
      return this._englishVoiceCache;
    }
    let best = null, bestScore = 0;
    for (const voice of voices) {
      const lang = String(voice?.lang || '').replace('_', '-');
      if (!/^en(-|$)/i.test(lang)) continue;        // 영어가 아니면 후보가 아니다
      if (this._badVoices.has(voice.name)) continue; // 한 번 소리가 안 났던 목소리
      let score = /^en-US$/i.test(lang) ? 4 : 2;
      if (/google|neural|natural|premium|enhanced/i.test(voice.name || '')) score += 2;
      if (voice.localService === false) score += 1;  // 서버 목소리가 대체로 또렷하다
      if (score > bestScore) { best = voice; bestScore = score; }
    }
    this._englishVoiceCache = best;
    return best;
  }

  /**
   * 대사 한 줄. 브라우저에 내장된 음성 합성을 쓴다(내려받는 파일 없음).
   * 실제로 말했으면 true. 자막은 HUD 가 따로 보여 준다.
   */
  speak(text, { rate = 1.05, pitch = 1, volume = 1 } = {}) {
    if (!this.enabled || !this.speechEnabled || this.closed || !text) return false;
    const synth = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== 'function') return false;
    const voice = this._englishVoice();
    if (!voice) return false;   // 영어 목소리가 없으면 말하지 않는다 (자막으로 간다)
    try {
      // 탭을 옮겨 다니면 Chrome 의 음성 합성이 pause 상태로 굳는 일이 있다.
      synth.resume?.();
      const utterance = new Utterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang || 'en-US';
      // 너무 빠르면 또 뭉개진다. 외치는 말이라 조금만 빠르게.
      utterance.rate = Math.max(0.7, Math.min(1.4, rate));
      utterance.pitch = Math.max(0.5, Math.min(1.6, pitch));
      utterance.volume = Math.max(0, Math.min(1, volume));
      /* 서버에서 받아 오는 목소리(Google 계열)는 망이 막히면 아무 소리 없이
       * 실패한다. 그런 목소리는 한 번 걸러 내고 다음 대사부터 다른 목소리로 읽는다.
       * 우리가 직접 끊은 것(cancel)은 실패가 아니다. */
      utterance.onerror = (event) => {
        const reason = event?.error;
        if (reason === 'interrupted' || reason === 'canceled') return;
        this._badVoices.add(voice.name);
        this._englishVoiceCache = null;
      };
      synth.speak(utterance);
      return true;
    } catch { return false; }
  }

  cancelSpeech() {
    try { globalThis.speechSynthesis?.cancel(); } catch { /* 음성 합성이 없어도 된다 */ }
  }

  cancelReload() {
    for (const source of this.reloadSources) { try { source.stop(); } catch {} }
    this.reloadSources.clear();
  }

  stop() {
    for (const source of this.sources) { try { source.stop(); } catch {} }
    this.sources.clear();
    this.reloadSources.clear();
    this.cancelSpeech();
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
