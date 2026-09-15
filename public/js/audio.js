/* =============================================================================
 *  audio.js  -  소리
 *
 *  기본은 합성이다. 파일을 하나도 내려받지 않고 총성·문·수갑·목소리를 그 자리에서
 *  만든다. 그래서 저장소가 가볍고 외부 요청이 없다.
 *
 *  다만 합성으로 만든 사람 목소리는 한계가 뚜렷하다. 성대와 입 모양을 흉내 낼
 *  수는 있어도 "사람이 지른 소리" 로는 들리지 않는다. 그래서 녹음 파일을 넣을
 *  자리를 열어 두었다.
 *
 *      public/assets/audio/  에 파일을 넣고  npm run import:audio
 *
 *  목록(manifest.json)에 적힌 이름이 있으면 그 파일을 쓰고, 없으면 지금처럼
 *  합성음을 낸다. 파일을 하나만 넣어도 그 소리만 바뀐다.
 *  넣는 방법과 받을 곳은 public/assets/audio/README.md 에 적어 두었다.
 *
 *  AudioContext 는 사용자가 화면을 한 번 만진 뒤에만 만들고 깨운다(iOS 포함).
 * ========================================================================== */

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
const VOX_MAKEUP = 1.8;   // 대역통과를 지나며 잃는 만큼 목소리에 더 준다
/* 포먼트 세 개를 섞는 비율. 첫 번째(F1)가 모음을 정하고, 뒤로 갈수록 "밝기" 만
 * 더한다. 전부 같은 크기로 섞으면 쇳소리가 난다. */
const FORMANT_MIX = [1, 0.72, 0.34];

/* 내려받아 넣은 소리 파일이 있는 곳. 없어도 된다. */
const AUDIO_DIR = '/assets/audio/';
const AUDIO_MANIFEST = `${AUDIO_DIR}manifest.json`;

/* 목소리 종류별 모양.
 *
 *   duration  길이(초)
 *   pitch     시간에 따른 성대 진동수. 사람은 한 음으로 소리치지 않는다.
 *   formants  입 모양. 낮을수록 "오/우", 높을수록 "에/이" 에 가깝다.
 *   vibrato   떨림. 겁먹었거나 힘을 줄수록 커진다.
 *   rasp      쉰 정도. 크게 지를수록 목이 갈라진다.
 */
const VOX_SHAPES = {
  pain: { duration: 0.34, level: 0.56, pitch: [300, 360, 170], formants: [640, 1100, 2400],
    vibrato: 6.5, rasp: 0.35, breath: 0.22 },
  scream: { duration: 0.86, level: 0.6, pitch: [430, 660, 580, 230], formants: [840, 1320, 2800],
    vibrato: 7.5, rasp: 0.5, breath: 0.3 },
  death: { duration: 1.05, level: 0.45, pitch: [330, 250, 120], formants: [520, 980, 2100],
    vibrato: 4.2, rasp: 0.45, breath: 0.34 },
  panic: { duration: 0.62, level: 0.38, pitch: [520, 720, 430], formants: [900, 1500, 3000],
    vibrato: 8.5, rasp: 0.2, breath: 0.26 },
  cuffed: { duration: 0.44, level: 0.32, pitch: [250, 300, 190], formants: [600, 1050, 2200],
    vibrato: 5, rasp: 0.3, breath: 0.2 },
  // 구두 경고를 외치는 소리 (말은 speak 가 따로 한다)
  shout: { duration: 0.42, level: 0.72, pitch: [300, 430, 260], formants: [720, 1250, 2600],
    vibrato: 5.5, rasp: 0.45, breath: 0.24 },
  // 경고를 듣고도 덤비는 소리
  defy: { duration: 0.55, level: 0.72, pitch: [260, 400, 320], formants: [660, 1150, 2500],
    vibrato: 6, rasp: 0.55, breath: 0.26 },
  surrender: { duration: 0.6, level: 0.4, pitch: [380, 300, 240], formants: [700, 1180, 2400],
    vibrato: 7, rasp: 0.25, breath: 0.24 },
};

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
    this.blocked = false;
    this.pack = new Map();        // 이름 -> AudioBuffer 배열 (넣어 둔 녹음)
    this._packLoaded = null;
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
    // 목소리 목록은 처음 물어볼 때는 비어 있고 잠시 뒤에 채워진다. 미리 한 번
    // 불러 두지 않으면 첫 구두 경고에서 "목소리가 없다" 고 잘못 판단한다.
    try { globalThis.speechSynthesis?.getVoices?.(); } catch { /* 없어도 된다 */ }
  }

  /** 소리가 실제로 나고 있는가 (안 나면 화면에 안내를 띄운다). */
  get running() { return this.context?.state === 'running'; }

  async unlock() {
    if (!this.enabled || this.closed) return;
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
      void this.loadPack();
    } catch { /* Unsupported/blocked audio must not stop gameplay. */ }
  }

  /* ======================================================================= *
   *  내려받아 넣은 녹음
   *
   *  목록 파일이 없으면 아무 일도 없다 (합성음 그대로). 있으면 적힌 파일만
   *  받아서 풀어 둔다. 한 이름에 여러 파일을 적으면 그중 하나를 무작위로
   *  고르므로, 같은 비명이 반복될 때 티가 덜 난다.
   * ======================================================================= */
  loadPack(url = AUDIO_MANIFEST) {
    if (this._packLoaded) return this._packLoaded;
    this._packLoaded = (async () => {
      if (!this.context) return false;
      let clips;
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) return false;
        clips = (await response.json()).clips;
      } catch { return false; }     // 목록이 없는 것이 기본 상태다
      if (!clips || typeof clips !== 'object') return false;

      await Promise.all(Object.entries(clips).map(async ([name, files]) => {
        const list = Array.isArray(files) ? files : [files];
        const decoded = await Promise.all(list.map((file) => this._decode(file)));
        const usable = decoded.filter(Boolean);
        if (usable.length) this.pack.set(name, usable);
      }));
      return this.pack.size > 0;
    })();
    return this._packLoaded;
  }

  async _decode(file) {
    try {
      const response = await fetch(`${AUDIO_DIR}${file}`, { cache: 'force-cache' });
      if (!response.ok) return null;
      return await this.context.decodeAudioData(await response.arrayBuffer());
    } catch {
      // 파일 하나가 깨져도 나머지 소리는 그대로 나야 한다.
      console.warn(`[audio] 소리 파일을 읽지 못했습니다: ${file}`);
      return null;
    }
  }

  /**
   * 넣어 둔 녹음을 낸다. 그 이름의 파일이 없으면 false 를 돌려주고, 부르는
   * 쪽은 합성음으로 넘어간다.
   */
  _sample(name, {
    position = null, occluded = false, level = 1, rate = 1, seconds = 0, reload = false,
  } = {}) {
    const buffers = this.pack.get(name);
    if (!buffers?.length || !this.context) return false;
    const bus = this._bus(position, occluded);
    if (!bus) return false;
    const source = this.context.createBufferSource();
    const buffer = buffers[Math.floor(Math.random() * buffers.length)];
    source.buffer = buffer;
    // seconds 를 주면 그 길이에 맞춰 늘리고 줄인다 (총마다 장전 시간이 다르다).
    // 그렇지 않으면 같은 파일이 반복돼도 티가 덜 나게 속도만 조금 흔든다.
    source.playbackRate.value = seconds > 0 && buffer.duration > 0
      ? Math.max(0.5, Math.min(2, buffer.duration / seconds))
      : rate * (0.94 + Math.random() * 0.12);
    const gain = this.context.createGain();
    gain.gain.value = Math.min(1.4, level * BOOST * 0.5);
    source.connect(gain);
    gain.connect(bus.gain);

    bus.pending++;
    this.sources.add(source);
    if (reload) this.reloadSources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.reloadSources.delete(source);
      source.disconnect(); gain.disconnect();
      if (--bus.pending === 0) {
        for (const node of bus.nodes) { node.disconnect(); this.nodes.delete(node); }
      }
    };
    source.start(this.context.currentTime);
    return true;
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
    if (this._sample(`gun/${weapon}`, { position, occluded })) return;
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
    if (this._sample('player/hurt')) return;
    const bus = this._bus();
    if (!bus) return;
    this._voice(bus, { duration: 0.14, level: 0.85, frequency: 190 });
    this._voice(bus, { at: 0.02, duration: 0.3, level: 0.3, frequency: 90, tone: true });
  }

  /**
   * 용의자가 나를 발견하고 외치는 소리. 총알보다 먼저 도착한다.
   *
   * 예전에는 높은 음 두 개를 이어 붙였다. 사람이 외치는 소리가 아니라 게임기
   * 알림음처럼 들렸다. 목소리로 짧게 두 번 외치게 한다.
   */
  contact(position = null, occluded = false) {
    if (this._sample('voice/contact', { position, occluded, level: 0.9 })) return;
    const bus = this._bus(position, occluded);
    if (!bus) return;
    this._vox(bus, {
      duration: 0.22, level: 0.7, pitch: [330, 470, 400], formants: [760, 1280, 2500],
    });
    this._vox(bus, {
      at: 0.28, duration: 0.3, level: 0.62, pitch: [300, 420, 250], formants: [700, 1180, 2400],
    });
  }

  /** 폭발 / 섬광 / 가스 분출. */
  blast(type = 'frag', position = null, occluded = false) {
    if (this._sample(`grenade/${type}`, { position, occluded })) return;
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
    if (this._sample('gun/reload', { position, seconds, reload: !position })) return;
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
    if (this._sample(`door/${action}`, { position })) return;
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
    pitch = [420, 520, 240], formants = [780, 1180, 2500], type = 'sawtooth',
    vibrato = 5.4, rasp = 0.3, breath = 0.18,
  } = {}) {
    const context = this.context;
    const start = context.currentTime + at;
    const stop = start + duration + 0.03;
    const chain = [];
    const track = (node) => { chain.push(node); return node; };

    /* 성대. 두 겹을 아주 조금 어긋나게 겹친다.
     * 한 겹짜리 톱니파는 음정이 수학적으로 정확해서 악기처럼 들린다. 사람의
     * 성대는 두 장이고 완전히 같이 떨지 않는다. 그 어긋남이 "사람 소리" 다. */
    const voices = [];
    for (let i = 0; i < 2; i++) {
      const osc = track(context.createOscillator());
      osc.type = i === 0 ? type : 'square';
      osc.detune.value = i === 0 ? 0 : 11;
      osc.frequency.setValueAtTime(Math.max(40, pitch[0]), start);
      for (let k = 1; k < pitch.length; k++) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(40, pitch[k]), start + duration * (k / (pitch.length - 1)));
      }
      voices.push(osc);
    }

    /* 떨림(비브라토). 사람은 소리를 일정하게 끌지 못한다. 이것 하나만 넣어도
     * 합성기 소리와 목소리가 확연히 갈린다. */
    if (vibrato > 0) {
      const lfo = track(context.createOscillator());
      lfo.frequency.value = vibrato;
      const depth = track(context.createGain());
      depth.gain.value = pitch[0] * 0.035;
      lfo.connect(depth);
      for (const osc of voices) depth.connect(osc.frequency);
      lfo.start(start);
      lfo.stop(stop);
    }

    const glottis = track(context.createGain());
    glottis.gain.value = 1;
    for (const osc of voices) osc.connect(glottis);

    // 거친 숨. 목이 쉰 소리와 "하—" 하는 바람 소리를 만든다.
    let noise = null;
    if (breath > 0 && this.noise) {
      noise = track(context.createBufferSource());
      noise.buffer = this.noise;
      noise.loop = true;
      const level2 = track(context.createGain());
      level2.gain.value = breath;
      noise.connect(level2);
      level2.connect(glottis);
    }

    /* 입 모양(포먼트). 병렬로 걸어서 섞는다. 직렬로 걸면 두 번째 필터가 첫
     * 번째가 남긴 좁은 대역을 다시 깎아서 소리가 얇아진다. */
    const mix = track(context.createGain());
    /* 병렬로 건 경로가 많을수록 합쳐진 신호가 커진다. 그만큼 되돌려 놓지 않으면
     * 모양(formants/rasp)을 손볼 때마다 크기가 널뛰고, 1.0 을 넘으면 찌그러진다.
     * 성대도 두 겹이므로 같이 나눈다. */
    const spread = FORMANT_MIX.slice(0, formants.length).reduce((a, b) => a + b, 0) + rasp;
    mix.gain.value = 1 / Math.max(0.5, spread * voices.length);
    formants.forEach((frequency, i) => {
      const filter = track(context.createBiquadFilter());
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(frequency, start);
      // 소리치는 동안 입 모양이 조금 닫힌다.
      filter.frequency.linearRampToValueAtTime(frequency * 0.86, start + duration);
      filter.Q.value = 3 + i * 1.6;
      const gain = track(context.createGain());
      gain.gain.value = FORMANT_MIX[i] ?? 0.2;
      glottis.connect(filter);
      filter.connect(gain);
      gain.connect(mix);
    });
    // 포먼트를 거치지 않은 원음을 조금 섞어 저음(가슴 울림)을 남긴다.
    const body = track(context.createGain());
    body.gain.value = rasp;
    glottis.connect(body);
    body.connect(mix);

    const envelope = track(context.createGain());
    const peak = level * BOOST * VOX_MAKEUP;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(peak, start + Math.min(0.045, duration * 0.18));
    envelope.gain.linearRampToValueAtTime(peak * 0.72, start + duration * 0.62);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    mix.connect(envelope);
    envelope.connect(bus.gain);

    bus.pending++;
    const started = [...voices, noise].filter(Boolean);
    for (const source of started) this.sources.add(source);
    let left = started.length;
    for (const source of started) {
      source.onended = () => {
        this.sources.delete(source);
        if (--left > 0) return;
        for (const node of chain) node.disconnect();
        if (--bus.pending === 0) {
          for (const node of bus.nodes) { node.disconnect(); this.nodes.delete(node); }
        }
      };
      source.start(start);
      source.stop(stop);
    }
  }

  /**
   * 비명 / 신음.
   * @param kind  'pain'  맞았다 ("윽")      'scream' 크게 맞았다 ("으아악")
   *              'death' 쓰러진다           'panic'  민간인의 겁먹은 소리
   *              'cuffed' 체포될 때의 항의
   */
  scream(position = null, kind = 'scream', occluded = false) {
    // 내려받은 목소리가 있으면 그쪽이 언제나 낫다.
    if (this._sample(`voice/${kind}`, { position, occluded })) return;
    const bus = this._bus(position, occluded);
    if (!bus) return;
    const shape = VOX_SHAPES[kind] || VOX_SHAPES.scream;
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
    if (this._sample('gear/cuff', { position })) return;
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
    if (this._sample('voice/cough', { position })) return;
    const bus = this._bus(position);
    if (!bus) return;
    this._vox(bus, { duration: 0.16, level: 0.3, pitch: [220, 160], formants: [520, 900] });
    this._voice(bus, { at: 0.16, duration: 0.2, level: 0.14, frequency: 1800 });
  }

  /**
   * 말소리. 브라우저에 내장된 음성 합성을 쓴다(내려받는 파일 없음).
   * 구두 경고는 실제로 들려야 압박이 된다. 자막은 HUD 가 따로 보여 준다.
   *
   * 예전에는 lang 만 'en-US' 로 적어 두고 목소리는 고르지 않았다. 한국어로
   * 맞춰 둔 기기에서는 영어 목소리가 없어서, 한국어 목소리가 영어 문장을
   * 철자대로 읽는 일이 벌어졌다. 그래서 목소리를 직접 고른다.
   *   1. 요청한 언어와 정확히 맞는 목소리
   *   2. 같은 언어의 다른 지역 목소리 (ko-KR -> ko)
   *   3. 없으면 아무 목소리 (읽기는 한다)
   */
  speak(text, { rate = 1.1, pitch = 1, volume = 1, lang = 'ko-KR' } = {}) {
    if (!this.enabled || !this.speechEnabled || this.closed || !text) return false;
    const synth = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (!synth || typeof Utterance !== 'function') return false;
    try {
      const utterance = new Utterance(text);
      utterance.lang = lang;
      const voice = this._pickVoice(lang);
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = Math.max(0, Math.min(1, volume));
      synth.speak(utterance);
      return true;
    } catch { return false; }
  }

  /** 이 언어를 읽을 수 있는 목소리. 없으면 null. */
  _pickVoice(lang) {
    let voices = [];
    try { voices = globalThis.speechSynthesis?.getVoices?.() || []; } catch { return null; }
    if (!voices.length) return null;
    const want = String(lang).toLowerCase();
    const base = want.split('-')[0];
    const of = (v) => String(v.lang || '').toLowerCase().replace('_', '-');
    return voices.find((v) => of(v) === want)
      || voices.find((v) => of(v).split('-')[0] === base)
      || null;
  }

  /** 이 언어를 읽을 수 있는 목소리가 기기에 있는가. */
  canSpeak(lang = 'ko-KR') {
    if (!globalThis.speechSynthesis) return false;
    return !!this._pickVoice(lang);
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
