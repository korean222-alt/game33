/* =============================================================================
 *  game.js  -  인게임 루프와 서버 이벤트 연결
 *
 *  흐름
 *    matchStart -> 씬에 아바타/문/증거 배치, 루프 시작
 *    매 프레임  -> 입력 -> 이동 예측 -> 카메라 -> 렌더
 *    20Hz      -> 내 상태를 서버로 (input)
 *    스냅샷    -> 남의 위치 보간 버퍼에 적재 + 내 상태 보정
 *
 *  문·항복·체포·투척 장비는 전부 서버가 판정한다. 클라이언트는 요청만 보내고
 *  결과 이벤트로 화면을 맞춘다.
 * ========================================================================== */

import * as THREE from 'three';
import { QUALITY, NET, PLAYER, loadSettings, saveSettings, guessQuality } from './config.js';
import { rayObstacleDistance, isIndoors } from './map-data.js';
import { DOOR, DoorSet, rollDoorStates, DOOR_REACH } from './doors.js';
import { GRENADE_ORDER, GRENADES, startingGrenades } from './grenades.js';
import { AssetManager } from './assets.js';
import { World } from './world.js';
import { Entities } from './entities.js';
import { LocalPlayer } from './player.js';
import { Input, isTouchDevice } from './input.js';
import { Hud } from './hud.js';
import { VisualPipeline } from './visuals.js';

import { ShotState } from './shot-state.js';
import { traceShot } from './shot-trace.js';
import { MISSION } from './mission-story.js';
import { GameAudio } from './audio.js';
import { compatibleMatch, UPDATE_MESSAGE } from './protocol.js';

const DEFUSE_RANGE = 1.8;   // 서버 상수와 동일해야 한다
const PEEK_COOLDOWN = 900;

export class Game {
  constructor(socket, hud) {
    this.socket = socket;
    this.hud = hud || new Hud();
    this.settings = loadSettings();
    if (!this.settings._qualityPicked) {
      this.settings.quality = guessQuality();
      this.settings._qualityPicked = true;
      saveSettings(this.settings);
    }

    this.myId = null;
    this.running = false;
    this.matchActive = false;
    this.weapons = null;
    this.sites = [];
    this.siteProgress = new Map();
    this.remaining = 0;

    this.hp = 100;
    this.ammo = 30;
    this.reserve = 150;
    this.reloading = false;
    this.alive = true;
    this.downed = false;
    this.blindUntil = 0;
    this.gas = 0;

    this.doors = new DoorSet(rollDoorStates(() => 0.9));
    this.grenades = startingGrenades();
    this.selectedGrenade = GRENADE_ORDER[0];

    this.shots = new ShotState();
    this._matchVersion = 0;
    this._lastFrame = 0;
    this._netAccum = 0;
    this._fpsAccum = 0;
    this._fpsCount = 0;
    this._lowFpsTime = 0;
    this._defusingSite = null;
    this._lastPeek = 0;
  }

  /* ======================================================================= *
   *  초기화 (에셋 로딩까지)
   * ======================================================================= */
  async init(onProgress) {
    const q = QUALITY[this.settings.quality] || QUALITY.high;

    this.renderer = new THREE.WebGLRenderer({
      antialias: q.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(q.pixelRatio, devicePixelRatio || 1));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.canvas = this.renderer.domElement;
    document.getElementById('app').appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(
      this.settings.fov, innerWidth / innerHeight, 0.05, q.drawDistance,
    );

    this.assets = new AssetManager(this.renderer);
    this.assets.setAnisotropy(q.anisotropy);
    await this.assets.loadAll(undefined, onProgress);

    this.world = new World(this.renderer, this.assets).build(this.settings.quality);
    this.world.scene.add(this.camera);       // 뷰모델이 카메라에 붙어있으므로 씬에 넣어야 한다
    this.pipeline = new VisualPipeline(this.renderer, this.world.scene, this.camera, this.settings.quality);

    this.entities = new Entities(this.world.scene, this.assets);
    this.player = new LocalPlayer(this.camera, this.world.scene, this.assets, this.settings,
      () => this.doors.colliders());
    this.input = new Input(this.canvas, this.settings);
    this.audio = new GameAudio({ enabled: this.settings.soundEnabled !== false });
    this.audio.bind(document);

    // Prepare static and skinned shader variants while the loading screen is up.
    // Otherwise first-frame compilation can stall input while the server's AI runs.
    onProgress?.(1, 1, '화면 준비');
    const warmup = new THREE.Group();
    warmup.add(this.assets.instance('character', { skinned: true }));
    for (const weapon of ['rifle', 'smg', 'sniper']) warmup.add(this.assets.instance(weapon));
    this.world.scene.add(warmup);
    try {
      await this.renderer.compileAsync(this.world.scene, this.camera);
    } finally {
      this.world.scene.remove(warmup);
    }

    this.input.onLockChange((locked) => {
      if (!locked && this.matchActive) this.hud.banner('클릭하면 다시 조작합니다', 2500);
    });

    this._resizeHandler = () => this._onResize();
    addEventListener('resize', this._resizeHandler);
    this._wireSocket();

    // 디버그용. 브라우저 콘솔에서 __mr.player.pos 등으로 상태를 볼 수 있다.
    window.__mr = this;

    return this;
  }

  _onResize() {
    if (!this.renderer) return;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.pipeline?.resize();
  }

  /* ======================================================================= *
   *  서버 이벤트
   * ======================================================================= */
  _wireSocket() {
    this._socketHandlers = [];
    const s = { on: (event, fn) => { this._socketHandlers.push([event, fn]); this.socket.on(event, fn); } };

    s.on('matchStart', (d) => this._onMatchStart(d));
    s.on('snapshot', (d) => this._onSnapshot(d));
    s.on('matchEnd', (d) => this._onMatchEnd(d));
    s.on('radio', (d) => this.hud.radio(d?.text));
    s.on('phase', (d) => {
      this.hud.setObjectives(d);
      this.hud.banner(`${d.name} — ${d.title}`, 3200);
      this.world.setExtractionActive(d.id === 'extract');
    });

    s.on('playerShot', (d) => {
      if (!this.matchActive || d.id === this.myId) return;   // 내 총은 내가 이미 그렸다
      this._remoteGunshot(d.weapon || 'rifle', d);
      this.entities.effects.shot({ x: d.x, y: d.y, z: d.z }, { x: d.dx, y: d.dy, z: d.dz }, d.dist);
    });

    s.on('npcShot', (d) => {
      if (!this.matchActive) return;
      this._remoteGunshot('rifle', d);
      this.entities.npcs.get(d.id)?.rig.trigger('fire');
      const dx = d.tx - d.x, dy = d.ty - d.y, dz = d.tz - d.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      this.entities.effects.shot(
        { x: d.x, y: d.y, z: d.z }, { x: dx / len, y: dy / len, z: dz / len }, len,
      );
    });

    s.on('playerHit', (d) => {
      if (d.id !== this.myId) return;
      this.hp = d.hp;
      this.hud.setHp(d.hp);
      this.hud.flashDamage();
      this.audio?.hurt();
      if (Number.isFinite(d.fx)) this.hud.threat(this._bearingTo(d.fx, d.fz), 'hit', 1600);
    });

    // 용의자가 나를 발견했다. 총알보다 먼저 오는 유일한 경고다.
    s.on('spotted', (d) => {
      if (!this.matchActive || !this.alive) return;
      this.hud.threat(this._bearingTo(d.x, d.z), 'spot', 1900);
      this.hud.banner('발각됨 — 접촉', 1400);
      this.audio?.contact({ x: d.x, y: 1.5, z: d.z });
    });

    s.on('playerDown', (d) => {
      if (d.id === this.myId) {
        this.alive = false;
        this.downed = true;
        this.player.alive = false;
        this.hud.setDead(true, '쓰러짐 — 대원의 소생을 기다리는 중');
        this.hud.setHp(0);
        this.input.releasePointer();
      } else {
        this.hud.killfeed('팀원이 쓰러졌습니다 — 소생 필요');
      }
    });

    s.on('playerDead', (d) => {
      if (d.id === this.myId) this.hud.setDead(true, '전사 — 작전 종료를 기다리는 중');
      else this.hud.killfeed('팀원 전사');
    });

    s.on('playerRevived', (d) => {
      if (d.id !== this.myId) { this.hud.killfeed('팀원 소생'); return; }
      this.alive = true;
      this.downed = false;
      this.player.alive = true;
      this.hp = d.hp;
      this.hud.setDead(false);
      this.hud.setHp(d.hp);
      if (!isTouchDevice) this.input.requestPointer();
    });

    s.on('npcHit', (d) => {
      if (d.by !== this.myId) {
        this.entities.confirmNpcHealth(d.id, d.hp);
        this.entities.applyShotPredictions(this.shots.pending);
      }
    });

    s.on('npcDown', (d) => {
      if (d.civilian) this.hud.killfeed('⚠ 민간인 피해 발생');
      else if (d.by === this.myId) this.hud.killfeed('적 무력화');
      this.entities.markDown(d.id);
    });

    s.on('npcSurrender', () => this.hud.killfeed('적 항복 — F로 체포'));
    s.on('npcArrested', (d) => { if (d.by === this.myId) this.hud.killfeed('체포 완료'); });
    s.on('civilianSecured', (d) => { if (d.by === this.myId) this.hud.killfeed('민간인 확보'); });
    s.on('evidenceTaken', (d) => {
      this.world.setEvidenceTaken(d.id);
      this.hud.killfeed(`증거 회수 · ${d.label}`);
    });
    s.on('roeViolation', (d) => {
      if (d.by === this.myId) this.hud.banner(`교전 규칙 위반 — ${d.reason}`, 3000);
    });

    s.on('doorState', (d) => {
      const door = this.doors.get(d.id);
      if (door && door.state !== d.state) {
        this.audio?.door(door, d.state === DOOR.DESTROYED ? 'kick' : d.state === DOOR.OPEN ? 'open' : 'close');
      }
      this.doors.setState(d.id, d.state);
      this.world.setDoorState(d.id, d.state);
    });
    s.on('doorAction', (d) => {
      // 남이 문을 차는 소리도 들려야 한다. 위치는 그 문이다.
      const door = this.doors.get(d.id);
      if (door) this.audio?.door(door, d.action);
      if (d.by !== this.myId) return;
      this._doorBusyUntil = performance.now() + d.seconds * 1000;
      this._doorBusyTotal = d.seconds * 1000;
    });

    s.on('grenadeThrown', (d) => {
      this.entities.effects.grenade(d.id, d.type, d, GRENADES[d.type]?.color ?? 0x777777);
    });
    s.on('grenadeExploded', (d) => {
      this.entities.effects.removeGrenade(d.id);
      this.entities.effects.blast(d, d.type);
      this.audio?.blast(d.type, d, this._occluded(d));
    });
    s.on('gasCloud', (d) => {
      this.entities.effects.gas(d.id, d, d.seconds);
      this.audio?.blast('gas', d);
    });
    s.on('gasCleared', (d) => this.entities.effects.clearGas(d.id));
    s.on('flashed', (d) => {
      this.blindUntil = performance.now() + d.seconds * 1000;
      this._blindTotal = d.seconds * 1000;
    });

    s.on('siteProgress', (d) => {
      this.siteProgress.set(d.id, d.progress);
      this.hud.setSiteProgress(d.id, d.progress);
    });

    s.on('siteDefused', (d) => {
      this.siteProgress.set(d.id, 1);
      this.hud.setSiteDefused(d.id);
      this.world.setSiteDefused(d.id);
      this.hud.radio(d.id === 'A' ? MISSION.siteA : MISSION.siteB);
    });

    s.on('npcsJoined', (d) => this.entities.spawnNpcs(d.npcs || []));
    s.on('playerLeft', (d) => this.entities.removePlayer(d.id));

    s.on('disconnect', () => {
      if (!this.matchActive) return;
      this.hud.banner('서버와 연결이 끊겼습니다', 6000);
      this.stop();
    });
  }

  dispose() {
    this.matchActive = false;
    this._matchVersion++;
    this.stop();
    this.input?.dispose();
    this.audio?.dispose();
    removeEventListener('resize', this._resizeHandler);
    for (const [event, fn] of this._socketHandlers || []) this.socket.off(event, fn);
    this.entities?.clear();
    this.pipeline?.composer.passes.forEach((p) => p.dispose?.());
    this.pipeline?.composer.dispose();
    const disposed = new Set();
    const release = (resource) => {
      if (resource && !disposed.has(resource)) { disposed.add(resource); resource.dispose?.(); }
    };
    const releaseObject = (root) => root.traverse((o) => {
      release(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        Object.values(m).filter((v) => v?.isTexture).forEach(release); release(m);
      }
    });
    if (this.world) { releaseObject(this.world.scene); this.world.scene.userData.environmentTarget?.dispose(); }
    for (const entry of this.assets?.cache.values() || []) releaseObject(entry.scene);
    this.renderer?.dispose();
    this.canvas?.remove();
  }

  /* ---- 매치 시작 -------------------------------------------------------- */
  _onMatchStart(d) {
    if (!compatibleMatch(d, this.myId)) {
      this.matchActive = false;
      this.stop();
      this.input.disable();
      this.socket.emit('leaveRoom');
      this.hud.showTouch(false);
      this.hud.show('menu');
      document.getElementById('menuErr').textContent = UPDATE_MESSAGE;
      return;
    }
    this.audio?.stop();
    this._doorPending = false;
    this.weapons = d.weapons;
    this.sites = d.sites;
    this.defuseSeconds = d.defuseSeconds;
    this.remaining = d.endsAt - Date.now();
    this.siteProgress.clear();
    this.alive = true;
    this.downed = false;
    this.hp = 100;
    this.reloading = false;
    this._reloadAcked = false;
    this._reloadSentAt = 0;
    this._defusingSite = null;
    this._matchVersion++;
    this.shots.reset();
    this._lastSnapshotSeq = -1;
    this._viewClock = null;
    this._lastShotAt = -Infinity;
    this._netAccum = 0;
    this._lowFpsTime = 0;
    this.blindUntil = 0;
    this.gas = 0;
    this._doorBusyUntil = 0;
    this.grenades = startingGrenades();
    this.selectedGrenade = GRENADE_ORDER[0];

    this.doors = new DoorSet(rollDoorStates(() => 0.9));
    this.doors.apply(d.doors || []);
    this.entities.clear();
    this.entities.setMyId(this.myId);
    this.entities.spawnPlayers(d.players);
    this.entities.spawnNpcs(d.npcs || []);
    this.world.resetSites();
    this.world.applyDoorStates(d.doors || []);
    this.world.buildEvidence(d.evidence || []);
    this.world.setExtractionActive(false);

    const me = d.players.find((p) => p.id === this.myId);
    if (me) {
      this.player.spawn(me.x, me.z, me.yaw);
      this.player.setWeapon(me.weapon);
      const w = this.weapons[me.weapon];
      this.ammo = w.mag;
      this.shots.serverAmmo = w.mag;
      this.reserve = w.reserve;
      this.weaponName = w.name;
    }

    this.hud.resetForNewMatch();
    this.hud.buildSites(d.sites);
    this.hud.setObjectives(d.objectives);
    this.hud.setHp(100);
    this.hud.setAmmo(this.ammo, this.reserve, false, this.weaponName);
    this.hud.setGrenade(this.selectedGrenade, this.grenades, GRENADES[this.selectedGrenade]);
    this.hud.show(null);
    this.hud.showTouch(isTouchDevice);
    this.hud.radio(MISSION.entry);

    this.matchActive = true;
    this.input.enable();
    if (!isTouchDevice) this.input.requestPointer();
    this.start();
  }

  /* ---- 스냅샷 ----------------------------------------------------------- */
  _onSnapshot(snap) {
    if (!this.matchActive || snap.seq <= this._lastSnapshotSeq) return;
    this.remaining = snap.remaining;
    this._lastSnapshotSeq = snap.seq;
    this._viewClock = { server: snap.t, local: performance.now() };

    if (snap.doors) {
      this.doors.apply(snap.doors);
      this.world.applyDoorStates(snap.doors);
    }
    this.entities.onSnapshot(snap);
    this.entities.effects.syncGrenades(snap.grenades || []);
    for (const g of snap.grenades || []) {
      this.entities.effects.grenade(g.id, g.type, g, GRENADES[g.type]?.color ?? 0x777777);
    }

    const me = snap.players.find((p) => p.id === this.myId);
    if (!me) return;

    // 서버가 진실 - 탄약/체력/생존은 서버 값을 그대로 따른다
    if (me.shotSeq === undefined) this.shots.serverAmmo = me.ammo;
    else this.shots.acknowledge(me.shotSeq, me.ammo);
    this.ammo = this.shots.ammo;
    this.entities.applyShotPredictions(this.shots.pending);
    this.reserve = me.reserve;
    // 장전 소리가 시작하자마자 끊기던 문제.
    // 장전을 요청하면 화면은 바로 "장전 중" 으로 바꾸지만, 그 직후 도착하는
    // 스냅샷은 아직 요청이 반영되기 전 상태(reloading=0)다. 그걸 "장전이
    // 취소됐다" 로 읽어서 소리를 즉시 멈추고 있었다. 서버가 한 번이라도
    // 장전 중이라고 알려 준 뒤에만 취소로 본다.
    if (me.reloading) this._reloadAcked = true;
    const awaitingAck = this.reloading && !this._reloadAcked
      && performance.now() - (this._reloadSentAt || 0) < RELOAD_ACK_GRACE;
    if (this.reloading && !me.reloading && !awaitingAck) this.audio?.cancelReload();
    this.reloading = !!me.reloading || awaitingAck;
    this.hp = me.hp;
    if (!me.alive) this.audio?.cancelReload();
    this.gas = me.gas || 0;
    if (me.grenades) this.grenades = me.grenades;
    if (me.sel && me.sel !== this.selectedGrenade) this.selectedGrenade = me.sel;
    if (me.blind > 0) this.blindUntil = Math.max(this.blindUntil, performance.now() + me.blind);

    const wasDowned = this.downed;
    this.downed = !!me.downed;
    if (this.alive && !me.alive) {
      this.alive = false;
      this.player.alive = false;
      this.hud.setDead(true, me.downed ? '쓰러짐 — 대원의 소생을 기다리는 중' : '전사 — 작전 종료를 기다리는 중');
    } else if (!this.alive && me.alive) {
      this.alive = true;
      this.player.alive = true;
      this.hud.setDead(false);
      if (wasDowned && !isTouchDevice) this.input.requestPointer();
    }

    if (me.alive) this.player.reconcile(me.x, me.z, me.y, me.inputSeq);

    this.hud.setHp(me.hp);
    this.hud.setAmmo(this.ammo, me.reserve, me.reloading, this.weaponName);
    this.hud.setGrenade(this.selectedGrenade, this.grenades, GRENADES[this.selectedGrenade]);
    this._serverHold = { progress: me.hold || 0, label: me.holdLabel || '' };
  }

  /* ---- 매치 종료 -------------------------------------------------------- */
  _onMatchEnd(d) {
    this.matchActive = false;
    this._matchVersion++;
    this.input.disable();
    this.stop();
    this.hud.showTouch(false);
    this.hud.showResult(d, this.myId);
  }

  /* ======================================================================= *
   *  루프
   * ======================================================================= */
  start() {
    if (this.running) return;
    this.running = true;
    this._lastFrame = performance.now();
    this._loop();
  }

  stop() {
    this.running = false;
    this.audio?.stop();
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _loop = () => {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);

    const now = performance.now();
    let dt = (now - this._lastFrame) / 1000;
    this._lastFrame = now;
    dt = Math.min(dt, 0.1);      // 탭 복귀 시 한 번에 크게 튀지 않도록

    this._step(dt, now);
    this.pipeline.render();
    this._trackFps(dt);
  };

  _step(dt, now) {
    const input = this.input;
    const blinded = now < this.blindUntil;

    // 시점
    const look = input.consumeLook();
    if (this.alive && (look.dx || look.dy)) this.player.look(look.dx, look.dy);

    // 이동 예측
    this.player.update(dt, input);
    this.audio?.setListener(this.camera.position, this.player.yaw);
    this._stepAudio(dt);
    this.hud.setAim(this.player.adsAmount, this.player.weapon, this.alive && !blinded);
    this.hud.setFlash(blinded ? Math.min(1, (this.blindUntil - now) / (this._blindTotal || 1) * 1.4) : 0);
    this.hud.setGas(this.gas);

    // 사격 / 장전 / 상호작용
    if (this.alive) {
      if (input.fire && !blinded) this._tryShoot(now);
      if (input.consumeReload()) this._tryReload();
      this._updateGrenades(input, now, blinded);
      this._updateDoor(input, now);
      this._updateUse(input);
      if (input.consumeShout()) this.socket.emit('shout');
    } else {
      input.consumeReload(); input.consumeDoor(); input.consumeKick();
      input.consumeShout(); input.consumeThrow(); input.consumeGrenadeSlot();
      this.hud.setDoor(null);
    }

    this.world.update(dt);
    this.entities.update(dt, this.camera);

    // 남은 시간 (스냅샷 사이는 클라가 감산)
    this.remaining = Math.max(0, this.remaining - dt * 1000);
    this.hud.setTimer(this.remaining);

    // 20Hz 로 서버에 내 상태 보고
    this._netAccum += dt;
    const step = 1 / NET.inputHz;
    if (this._netAccum >= step) {
      this._netAccum %= step;
      if (this.alive && this.socket.connected) this.socket.volatile.emit('input', this.player.netState());
    }
  }

  /* ---- 사격 ------------------------------------------------------------- */
  _tryShoot(now) {
    const w = this.weapons?.[this.player.weapon];
    if (!w || !this.matchActive || !this.alive || !this.socket.connected) return;
    if (now - this._lastShotAt < 60000 / w.rpm) return;
    if (this.reloading || this.ammo <= 0) {
      if (this.ammo <= 0 && !this.reloading) { this.audio?.dryFire(); this._tryReload(); }
      return;
    }
    this._lastShotAt = now;
    const dir = this.player.aimDirection();
    const from = this.player.muzzlePosition();
    const origin = {
      x: this.player.pos.x,
      y: this.player.pos.y + PLAYER.eyeHeight - (this.player.crouching ? .45 : 0),
      z: this.player.pos.z,
    };
    const colliders = this.doors.colliders();
    const predicted = traceShot(origin, dir, w.range, this.entities.shotTargets(),
      (o, d, max) => rayObstacleDistance(o, d, max, colliders));
    const prediction = predicted.hit ? {
      targetId: predicted.targetId,
      damage: Math.round(w.damage * (predicted.part === 'head' ? w.headMul : 1)),
    } : null;
    const shotId = this.shots.fire(prediction);
    this.ammo = this.shots.ammo;
    this.hud.setAmmo(this.ammo, this.reserve, false, this.weaponName);
    this.player.kick();
    this.audio?.shot(this.player.weapon, null, false, isIndoors(this.player.pos.x, this.player.pos.z));
    this.player.addShotSpread();
    // 느린 연결에서도 조준한 곳까지 즉시 그린다.
    const impact = new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(dir, predicted.dist);
    const impactPoint = impact.clone();
    const tracer = impact.sub(new THREE.Vector3(from.x, from.y, from.z));
    this.entities.effects.shot(from, tracer.clone().normalize(), tracer.length());
    if (!predicted.hit) this.audio?.impact(impactPoint);
    if (predicted.hit) this.hud.flashHit();
    this.entities.applyShotPredictions(this.shots.pending);

    const version = this._matchVersion;
    const viewTime = this._viewClock
      ? this._viewClock.server + now - this._viewClock.local - NET.interpDelayMs : undefined;
    this.socket.timeout(5000).emit('shoot', {
      shotId, dx: dir.x, dy: dir.y, dz: dir.z, viewTime, input: this.player.netState(),
    }, (error, res) => {
      if (version !== this._matchVersion || !this.matchActive || shotId <= this.shots.ackId) return;
      if (error) {
        this.shots.expire(shotId);
        this.hud.banner('서버 응답 지연 · 명중 확인 중', 1800);
      } else if (res && this.shots.acknowledge(res.shotSeq ?? shotId, res.ammo)) {
        if (res.hit) {
          this.entities.confirmNpcHealth(res.targetId, res.targetHp);
          if (!predicted.hit) this.hud.flashHit();
        }
      } else {
        this.shots.expire(shotId);
      }
      this.ammo = this.shots.ammo;
      this.entities.applyShotPredictions(this.shots.pending);
      this.hud.setAmmo(this.ammo, this.reserve, this.reloading, this.weaponName);
    });
  }

  _tryReload() {
    const w = this.weapons?.[this.player.weapon];
    if (!w || this.reloading || this.ammo >= w.mag || this.reserve <= 0) return;
    this.reloading = true;
    this._reloadAcked = false;
    this._reloadSentAt = performance.now();
    this.hud.setAmmo(this.ammo, this.reserve, true, this.weaponName);
    this.audio?.reload(w.reload);
    this.socket.emit('reload');
  }

  /* ---- 투척 장비 -------------------------------------------------------- */
  _updateGrenades(input, now, blinded) {
    const slot = input.consumeGrenadeSlot();
    if (slot) {
      const index = slot === -1
        ? (GRENADE_ORDER.indexOf(this.selectedGrenade) + 1) % GRENADE_ORDER.length
        : slot - 1;
      const type = GRENADE_ORDER[index];
      if (type) {
        this.selectedGrenade = type;
        this.socket.emit('selectGrenade', { type });
        this.hud.setGrenade(type, this.grenades, GRENADES[type]);
      }
    }
    if (!input.consumeThrow() || blinded) return;
    if ((this.grenades?.[this.selectedGrenade] ?? 0) <= 0) {
      this.hud.banner(`${GRENADES[this.selectedGrenade]?.label ?? '장비'} 없음`, 1400);
      return;
    }
    // 카메라 정면에서 살짝 위로. 나머지 궤적은 서버가 계산한다.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    dir.y += 0.18;
    dir.normalize();
    this.socket.emit('throw', {
      type: this.selectedGrenade, dx: dir.x, dy: dir.y, dz: dir.z, power: 1,
    }, (res) => {
      if (res?.grenades) {
        this.grenades = res.grenades;
        this.hud.setGrenade(this.selectedGrenade, this.grenades, GRENADES[this.selectedGrenade]);
      }
    });
  }

  /* ---- 문 -------------------------------------------------------------- */
  _updateDoor(input, now) {
    const near = this.doors.nearest(this.player.pos.x, this.player.pos.z, DOOR_REACH);
    const busy = this._doorPending || now < (this._doorBusyUntil || 0);

    if (!near) {
      this.hud.setDoor(null);
      input.consumeDoor(); input.consumeKick();
      return;
    }
    const door = near.door;
    const actions = this.doors.available(door);
    // 부서진 문에는 할 수 있는 것이 없다. 안내를 띄우면 눌러도 반응이 없다.
    if (actions.length === 0) {
      this.hud.setDoor(null);
      input.consumeDoor(); input.consumeKick();
      return;
    }
    const primary = actions.includes('open') ? 'open'
      : actions.includes('close') ? 'close'
        : actions.includes('unlock') ? 'unlock' : null;
    const available = {
      primary, peek: actions.includes('peek'), kick: actions.includes('kick'),
    };
    const hint = busy ? '작업 중…'
      : [primary ? `${isTouchDevice ? PRIMARY_LABEL[primary] : `E ${PRIMARY_LABEL[primary]}`}` : null,
        available.peek ? `${isTouchDevice ? '문틈 확인' : 'Q 문틈 확인'}` : null,
        available.kick ? `${isTouchDevice ? '강제 개방' : 'B 강제 개방'}(시끄럽다)` : null]
        .filter(Boolean).join(' · ');
    this.hud.setDoor(door, hint, available);

    if (busy) { input.consumeDoor(); input.consumeKick(); return; }

    if (input.consumeDoor() && primary) this._sendDoor(door.id, primary);
    else if (input.consumeKick() && actions.includes('kick')) this._sendDoor(door.id, 'kick');
    else if (input.peek && actions.includes('peek') && now - this._lastPeek > PEEK_COOLDOWN) {
      this._lastPeek = now;
      this._sendDoor(door.id, 'peek');
    }
  }

  _sendDoor(id, action) {
    if (!this.socket.connected || this._doorPending) return;
    this._doorPending = true;
    const version = this._matchVersion;
    // Reliable ordered input reaches the server before the action at the door.
    this.socket.emit('input', this.player.netState());
    this.socket.timeout(4000).emit('door', { id, action }, (error, res) => {
      if (version !== this._matchVersion || !this.matchActive) return;
      this._doorPending = false;
      if (error) { this.hud.banner('문 동작 응답이 없습니다. 연결 상태를 확인해 주세요.', 2400); return; }
      if (res?.ok) {
        this._doorBusyUntil = performance.now() + (res.seconds || (action === 'peek' ? 0.7 : 0)) * 1000;
        if (action === 'peek') this.hud.showPeek(res);
        return;
      }
      const messages = {
        'not-allowed': '문 상태가 바뀌었습니다. 가능한 동작을 다시 확인해 주세요.',
        far: '문에 더 가까이 다가가세요.',
        busy: '문 작업 중입니다. 잠시 기다려 주세요.',
        'no-door': '문 정보를 갱신하지 못했습니다. 방에 다시 참가해 주세요.',
      };
      this.hud.banner(messages[res?.error] || '지금은 문을 조작할 수 없습니다.', 2000);
    });
  }

  /** 내 시점 기준으로 (x,z) 가 어느 쪽인지. 0 = 정면, + = 오른쪽 (라디안). */
  _bearingTo(x, z) {
    const dx = x - this.player.pos.x, dz = z - this.player.pos.z;
    if (Math.hypot(dx, dz) < 0.05) return 0;
    const yaw = this.player.yaw;
    const forward = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
    const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
    return Math.atan2(right, forward);
  }

  /**
   * 발소리. 걸은 거리로 박자를 잡는다(시간이 아니라 거리라서 속도가 바뀌어도
   * 보폭이 일정하다). 앉아서 움직이면 거의 들리지 않는다 - 조용히 접근할 수
   * 있다는 규칙이 소리로도 지켜져야 한다.
   */
  _stepAudio(dt) {
    if (!this.alive || !this.player.onGround) return;
    const speed = Math.hypot(this.player.vel.x, this.player.vel.z);
    if (speed < 0.4) { this._stepDistance = 0; return; }
    this._stepDistance = (this._stepDistance || 0) + speed * dt;
    const stride = this.player.crouching ? 1.0 : this.player.sprinting ? 2.1 : 1.65;
    if (this._stepDistance < stride) return;
    this._stepDistance = 0;
    this.audio?.footstep({ crouch: this.player.crouching, sprint: this.player.sprinting });
  }

  /** 소리가 나는 지점과 내 귀 사이에 벽이 있는가. 있으면 먹먹하게 들린다. */
  _occluded(position) {
    const listener = this.camera.position;
    const dx = listener.x - position.x, dy = listener.y - (position.y ?? 0), dz = listener.z - position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 0.01) return false;
    return rayObstacleDistance(position,
      { x: dx / distance, y: dy / distance, z: dz / distance },
      distance, this.doors.colliders()) < distance - 0.05;
  }

  _remoteGunshot(weapon, position) {
    this.audio?.shot(weapon, position, this._occluded(position),
      isIndoors(this.camera.position.x, this.camera.position.z));
  }

  /* ---- 해체 / 체포 / 확보 / 소생 ---------------------------------------- */
  _updateUse(input) {
    // 서버가 진행도를 계산한다. 가장 가까운 장치가 있으면 해체를 우선한다.
    let near = null, nearD = Infinity;
    for (const s of this.sites) {
      if (this.siteProgress.get(s.id) >= 1) continue;
      const d = Math.hypot(this.player.pos.x - s.x, this.player.pos.z - s.z);
      if (d <= DEFUSE_RANGE && d < nearD) { near = s; nearD = d; }
    }

    if (near) {
      const holding = input.use;
      const progress = this.siteProgress.get(near.id) || 0;
      this.hud.setDefuse(true, holding ? `${near.label} 해체 중…`
        : `${near.label} — ${isTouchDevice ? '사용 버튼' : 'F'} 길게`, progress);
      if (holding && this._defusingSite !== near.id) {
        this.socket.emit('defuse', { siteId: near.id, active: true });
        this._defusingSite = near.id;
      } else if (!holding && this._defusingSite) {
        this.socket.emit('defuse', { active: false });
        this._defusingSite = null;
      }
      return;
    }

    if (this._defusingSite) { this.socket.emit('defuse', { active: false }); this._defusingSite = null; }

    const hold = this._serverHold;
    if (hold?.label) {
      this.hud.setDefuse(true, input.use ? `${hold.label} 진행 중…`
        : `${hold.label} — ${isTouchDevice ? '사용 버튼' : 'F'} 길게`, hold.progress);
    } else {
      this.hud.setDefuse(false);
    }
  }

  /* ---- FPS 측정 + 자동 품질 조정 ---------------------------------------- */
  _trackFps(dt) {
    this._fpsAccum += dt;
    this._fpsCount++;
    if (this._fpsAccum < 0.5) return;

    const fps = Math.round(this._fpsCount / this._fpsAccum);
    this._fpsAccum = 0;
    this._fpsCount = 0;
    this.hud.setFps(fps, this.settings.showFps);

    if (!this.settings.autoScale) return;
    if (fps < 45) {
      this._lowFpsTime += 0.5;
      if (this._lowFpsTime >= 3) { this._lowFpsTime = 0; this._downgrade(); }
    } else {
      this._lowFpsTime = 0;
    }
  }

  /** 프레임이 계속 낮으면 한 단계 낮춘다 (씬은 그대로 두고 렌더러만 조정) */
  _downgrade() {
    const order = ['ultra', 'high', 'medium', 'low'];
    const i = order.indexOf(this.settings.quality);
    if (i < 0 || i >= order.length - 1) return;

    const next = order[i + 1];
    this.settings.quality = next;
    // 자동 조정은 이번 세션에만 적용한다. 한 번 느렸다고 사용자가 고른 품질을
    // 영구히 낮추지는 않는다.

    const q = QUALITY[next];
    this.renderer.setPixelRatio(Math.min(q.pixelRatio, devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = q.shadows;
    this.pipeline.setQuality(next);
    if (this.world.keyLight) {
      this.world.keyLight.castShadow = q.shadows;
      const shadow = this.world.keyLight.shadow;
      shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      shadow.map?.dispose(); shadow.map = null;
    }
    this.camera.far = q.drawDistance;
    this.camera.updateProjectionMatrix();
    if (this.world.scene.fog) this.world.scene.fog.density = Math.max(q.fogDensity, 0.012);
    for (let j = q.pointLights; j < this.world.pointLights.length; j++) {
      this.world.pointLights[j].visible = false;
    }
    this.hud.banner(`그래픽 품질을 '${q.label}'로 낮췄습니다`, 2200);
  }
}

const PRIMARY_LABEL = { open: '열기', close: '닫기', unlock: '해정 시도' };
/* 장전 요청이 서버에 닿아 스냅샷에 반영될 때까지 기다려 주는 시간(ms). */
const RELOAD_ACK_GRACE = 700;
