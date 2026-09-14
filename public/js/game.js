/* =============================================================================
 *  game.js  -  인게임 루프와 서버 이벤트 연결
 *
 *  흐름
 *    matchStart -> 씬에 아바타 배치, 루프 시작
 *    매 프레임  -> 입력 -> 이동 예측 -> 카메라 -> 렌더
 *    20Hz      -> 내 상태를 서버로 (input)
 *    스냅샷    -> 남의 위치 보간 버퍼에 적재 + 내 위치 보정
 * ========================================================================== */

import * as THREE from 'three';
import { QUALITY, NET, PLAYER, loadSettings, saveSettings, guessQuality } from './config.js';
import { BOMB_SITES, MAP, rayObstacleDistance } from './map-data.js';
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

const DEFUSE_RANGE = 1.6;   // 서버 상수와 동일해야 한다

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

    this.shots = new ShotState();
    this._matchVersion = 0;
    this._lastFrame = 0;
    this._netAccum = 0;
    this._fpsAccum = 0;
    this._fpsCount = 0;
    this._lowFpsTime = 0;
    this._defusingSite = null;
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
    this.renderer.toneMappingExposure = 1.05;

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
    this.player = new LocalPlayer(this.camera, this.world.scene, this.assets, this.settings);
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

    s.on('playerShot', (d) => {
      if (d.id === this.myId) return;   // 내 총은 내가 이미 그렸다
      this.entities.effects.shot({ x: d.x, y: d.y, z: d.z }, { x: d.dx, y: d.dy, z: d.dz }, d.dist);
    });

    s.on('botShot', (d) => {
      const dx = d.tx - d.x, dy = d.ty - d.y, dz = d.tz - d.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      this.entities.effects.shot(
        { x: d.x, y: d.y, z: d.z },
        { x: dx / len, y: dy / len, z: dz / len },
        len,
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
        this.player.alive = false;
        this.hud.setDead(true);
        this.hud.setHp(0);
        this.input.releasePointer();
      } else {
        this.hud.killfeed('팀원이 쓰러졌습니다');
      }
    });

    s.on('botHit', (d) => {
      if (d.by !== this.myId) {
        this.entities.confirmBotHealth(d.id, d.hp);
        this.entities.applyShotPredictions(this.shots.pending);
      }
    });

    s.on('botDown', (d) => {
      if (d.by === this.myId) this.hud.killfeed('적 제압');
      const bot = this.entities.bots.get(d.id);
      if (bot) { bot.alive = false; bot.confirmedDead = true; bot.group.visible = false; }
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
    this.pipeline?.composer.passes.forEach(p => p.dispose?.());
    this.pipeline?.composer.dispose();
    const disposed = new Set();
    const release = resource => { if (resource && !disposed.has(resource)) { disposed.add(resource); resource.dispose?.(); } };
    const releaseObject = root => root.traverse(o => {
      release(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        Object.values(m).filter(v => v?.isTexture).forEach(release); release(m);
      }
    });
    if (this.world) { releaseObject(this.world.scene); this.world.scene.userData.environmentTarget?.dispose(); }
    for (const entry of this.assets?.cache.values() || []) releaseObject(entry.scene);
    this.renderer?.dispose();
    this.canvas?.remove();
  }

  _siteLabel(id) {
    return this.sites.find((s) => s.id === id)?.label || id;
  }

  /* ---- 매치 시작 -------------------------------------------------------- */
  _onMatchStart(d) {
    this.weapons = d.weapons;
    this.sites = d.sites;
    this.defuseSeconds = d.defuseSeconds;
    this.remaining = d.endsAt - Date.now();
    this.siteProgress.clear();
    this.alive = true;
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

    this.entities.clear();
    this.entities.setMyId(this.myId);
    this.entities.spawnPlayers(d.players);
    this.entities.spawnBots(d.bots);
    this.world.resetSites();

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
    this.hud.setHp(100);
    this.hud.setAmmo(this.ammo, this.reserve, false, this.weaponName);
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

    const me = snap.players.find((p) => p.id === this.myId);
    if (!me) return;

    // 서버가 진실 - 탄약/체력/생존은 서버 값을 그대로 따른다
    if (me.shotSeq === undefined) this.shots.serverAmmo = me.ammo;
    else this.shots.acknowledge(me.shotSeq, me.ammo);
    this.ammo = this.shots.ammo;
    this.entities.onSnapshot(snap);
    this.entities.applyShotPredictions(this.shots.pending);
    this.reserve = me.reserve;
    this.reloading = !!me.reloading;
    this.hp = me.hp;

    if (this.alive && !me.alive) {
      this.alive = false;
      this.player.alive = false;
      this.hud.setDead(true);
    } else if (!this.alive && me.alive) {
      this.alive = true;
      this.player.alive = true;
      this.hud.setDead(false);
    }

    if (me.alive) this.player.reconcile(me.x, me.z, me.y, me.inputSeq);

    this.hud.setHp(me.hp);
    this.hud.setAmmo(this.ammo, me.reserve, me.reloading, this.weaponName);
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

    // 시점
    const look = input.consumeLook();
    if (this.alive && (look.dx || look.dy)) this.player.look(look.dx, look.dy);

    // 이동 예측
    this.player.update(dt, input);
    this.hud.setAim(this.player.adsAmount, this.player.weapon, this.alive);

    // 사격 / 장전 / 해체
    if (this.alive) {
      if (input.fire) this._tryShoot(now);
      if (input.consumeReload()) this._tryReload();
      this._updateDefuse(input);
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
    const origin = { x: this.player.pos.x, y: this.player.pos.y + PLAYER.eyeHeight -
      (this.player.crouching ? .45 : 0), z: this.player.pos.z };
    const predicted = traceShot(origin, dir, w.range, this.entities.shotTargets(), rayObstacleDistance);
    const prediction = predicted.hit ? { targetId: predicted.targetId,
      damage: Math.round(w.damage * (predicted.part === 'head' ? w.headMul : 1)) } : null;
    const shotId = this.shots.fire(prediction);
    this.ammo = this.shots.ammo;
    this.hud.setAmmo(this.ammo, this.reserve, false, this.weaponName);
    this.player.kick();
    this.player.addShotSpread();
    // Draw to the predicted aim impact immediately, including on slow connections.
    const impact = new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(dir, predicted.dist);
    const tracer = impact.sub(new THREE.Vector3(from.x, from.y, from.z));
    this.entities.effects.shot(from, tracer.clone().normalize(), tracer.length());
    if (predicted.hit) this.hud.flashHit();
    this.entities.applyShotPredictions(this.shots.pending);

    const version = this._matchVersion;
    const viewTime = this._viewClock ? this._viewClock.server + now - this._viewClock.local - NET.interpDelayMs : undefined;
    this.socket.timeout(5000).emit('shoot', {
      shotId, dx: dir.x, dy: dir.y, dz: dir.z, viewTime, input: this.player.netState(),
    }, (error, res) => {
      if (version !== this._matchVersion || !this.matchActive || shotId <= this.shots.ackId) return;
      if (error) {
        this.shots.expire(shotId);
        this.hud.banner('서버 응답 지연 · 명중 확인 중', 1800);
      } else if (res && this.shots.acknowledge(res.shotSeq ?? shotId, res.ammo)) {
        if (res.hit) {
          this.entities.confirmBotHealth(res.targetId, res.targetHp);
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

  /* ---- 폭발물 해체 ------------------------------------------------------ */
  _updateDefuse(input) {
    // 가장 가까운 미해체 지점
    let near = null, nearD = Infinity;
    for (const s of this.sites) {
      if (this.siteProgress.get(s.id) >= 1) continue;
      const d = Math.hypot(this.player.pos.x - s.x, this.player.pos.z - s.z);
      if (d <= DEFUSE_RANGE && d < nearD) { near = s; nearD = d; }
    }

    if (!near) {
      if (this._defusingSite) { this.socket.emit('defuse', { active: false }); this._defusingSite = null; }
      this.hud.setDefuse(false);
      return;
    }

    const holding = input.use;
    const progress = this.siteProgress.get(near.id) || 0;
    this.hud.setDefuse(
      true,
      holding ? `${near.label} 해체 중…` : `${near.label} — ${isTouchDevice ? '해체 버튼' : 'F'} 길게`,
      progress,
    );

    if (holding && this._defusingSite !== near.id) {
      this.socket.emit('defuse', { siteId: near.id, active: true });
      this._defusingSite = near.id;
    } else if (!holding && this._defusingSite) {
      this.socket.emit('defuse', { active: false });
      this._defusingSite = null;
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
    // Automatic changes apply only to this session; one slow load should not
    // permanently lower the quality the user selected.

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
    if (this.world.scene.fog) this.world.scene.fog.density = q.fogDensity;
    for (let j = q.pointLights; j < this.world.pointLights.length; j++) {
      this.world.pointLights[j].visible = false;
    }
    this.hud.banner(`그래픽 품질을 '${q.label}'로 낮췄습니다`, 2200);
  }
}
