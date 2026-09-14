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

  shot(weapon = 'rifle', position = null, occluded = false) {
    const bus = this._bus(position, occluded);
    if (!bus) return;
    const heavy = weapon === 'sniper', light = weapon === 'smg';
    this._voice(bus, { duration: heavy ? 0.28 : light ? 0.09 : 0.16, level: heavy ? 0.9 : 0.65, frequency: light ? 2200 : 1300 });
    this._voice(bus, { duration: heavy ? 0.3 : 0.13, level: 0.45, frequency: heavy ? 95 : 150, tone: true });
    this._voice(bus, { at: 0.018, duration: 0.04, level: 0.18, frequency: 3600 });
  }

  reload(seconds = 2.3) {
    this.cancelReload();
    const bus = this._bus();
    if (!bus) return;
    const total = Math.max(0.5, Math.min(8, Number(seconds) || 2.3));
    for (const [fraction, frequency, level] of [[0, 1600, 0.22], [0.2, 650, 0.3], [0.65, 1100, 0.4], [0.9, 2800, 0.32]]) {
      this._voice(bus, { at: total * fraction, duration: 0.085, frequency, level }, true);
    }
  }

  door(position) {
    const bus = this._bus(position);
    if (bus) {
      this._voice(bus, { duration: 0.12, level: 0.25, frequency: 450 });
      this._voice(bus, { at: 0.05, duration: 0.18, level: 0.12, frequency: 120, tone: true });
    }
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
