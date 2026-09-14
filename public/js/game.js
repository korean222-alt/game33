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
import { rayObstacleDistance } from './map-data.js';
import { DoorSet, rollDoorStates, DOOR_REACH } from './doors.js';
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
      if (d.id === this.myId) return;   // 내 총은 내가 이미 그렸다
      this.entities.effects.shot({ x: d.x, y: d.y, z: d.z }, { x: d.dx, y: d.dy, z: d.dz }, d.dist);
    });

    s.on('npcShot', (d) => {
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
      this.doors.setState(d.id, d.state);
      this.world.setDoorState(d.id, d.state);
    });
    s.on('doorAction', (d) => {
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
    });
    s.on('gasCloud', (d) => this.entities.effects.gas(d.id, d, d.seconds));
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
    this.weapons = d.weapons;
    this.sites = d.sites;
    this.defuseSeconds = d.defuseSeconds;
    this.remaining = d.endsAt - Date.now();
    this.siteProgress.clear();
    this.alive = true;
    this.downed = false;
    this.hp = 100;
    this.reloading = false;
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
    this.reloading = !!me.reloading;
    this.hp = me.hp;
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
      if (this.ammo <= 0 && !this.reloading) this._tryReload();
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
    this.player.addShotSpread();
    // 느린 연결에서도 조준한 곳까지 즉시 그린다.
    const impact = new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(dir, predicted.dist);
    const tracer = impact.sub(new THREE.Vector3(from.x, from.y, from.z));
    this.entities.effects.shot(from, tracer.clone().normalize(), tracer.length());
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
    this.hud.setAmmo(this.ammo, this.reserve, true, this.weaponName);
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
    const busy = now < (this._doorBusyUntil || 0);

    if (!near) {
      this.hud.setDoor(null);
      input.consumeDoor(); input.consumeKick();
      return;
    }
    const door = near.door;
    const actions = this.doors.available(door);
    const primary = actions.includes('open') ? 'open'
      : actions.includes('close') ? 'close'
        : actions.includes('unlock') ? 'unlock' : null;
    const hint = busy ? '작업 중…'
      : [primary ? `${isTouchDevice ? '문' : 'E'} ${PRIMARY_LABEL[primary]}` : null,
        actions.includes('peek') ? `${isTouchDevice ? '확인' : 'Q'} 문틈 확인` : null,
        actions.includes('kick') ? `${isTouchDevice ? '돌입' : 'B'} 강제 개방(시끄럽다)` : null]
        .filter(Boolean).join(' · ');
    this.hud.setDoor(door, hint);

    if (busy) { input.consumeDoor(); input.consumeKick(); return; }

    if (input.consumeDoor() && primary) this._sendDoor(door.id, primary);
    else if (input.consumeKick() && actions.includes('kick')) this._sendDoor(door.id, 'kick');
    else if (input.peek && actions.includes('peek') && now - this._lastPeek > PEEK_COOLDOWN) {
      this._lastPeek = now;
      this.socket.emit('door', { id: door.id, action: 'peek' }, (res) => this.hud.showPeek(res));
    }
  }

  _sendDoor(id, action) {
    this.socket.emit('door', { id, action }, (res) => {
      if (res?.ok) return;
      if (res?.error === 'not-allowed') this.hud.banner('그 방법으로는 열리지 않는다', 1600);
      else if (res?.error === 'far') this.hud.banner('문에 더 붙어야 한다', 1400);
    });
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
