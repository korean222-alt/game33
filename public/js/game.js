/* =============================================================================
 *  game.js  -  전체를 묶는 진입점
 *
 *  흐름
 *    1) 렌더러/씬 준비  ->  GLB 전부 로딩  ->  메뉴
 *    2) 방 만들기/입장  ->  로비  ->  작전 개시
 *    3) 매 프레임: 입력 -> 플레이어 물리 -> 서버 전송 -> 보간 -> 렌더
 *    4) 승패 -> 결과 화면 -> 다시 로비
 *
 *  성능 관리
 *    - 평균 FPS 가 45 아래로 3초 이상 유지되면 자동으로 품질을 한 단계 낮춘다.
 *    - 품질은 QUALITY 프리셋(config.js)으로만 바꾼다.
 * ========================================================================== */

import * as THREE from 'three';

import { QUALITY, loadSettings, saveSettings, guessQuality, MODELS } from './config.js';
import { AssetManager } from './assets.js';
import { World } from './world.js';
import { Effects } from './effects.js';
import { EntityManager } from './entities.js';
import { LocalPlayer } from './player.js';
import { Controls } from './controls.js';
import { NetClient } from './net.js';
import { Hud } from './hud.js';
import { audio } from './audio.js';

/* ========================================================================== *
 *  게임
 * ========================================================================== */
class Game {
  constructor() {
    this.settings = loadSettings();
    // 처음 켰다면 기기에 맞는 품질을 추천
    if (!localStorage.getItem('market-raid-settings')) {
      this.settings.quality = guessQuality();
    }
    this.quality = QUALITY[this.settings.quality] || QUALITY.high;

    this.state = 'boot';          // boot | menu | lobby | playing | paused | ended
    this.myId = null;
    this.lobby = null;
    this.weapons = null;          // 서버가 준 무기 스펙 표
    this.myWeapon = 'rifle';
    this.matchEndsAt = 0;
    this.lastSnapshot = null;
    this.defusingSite = null;
    this.siteProgress = new Map();

    this.hud = new Hud();
    this.net = new NetClient();

    this._frames = 0;
    this._fpsAccum = 0;
    this._fpsTimer = 0;
    this._lowFpsTime = 0;
    this._lastTime = performance.now();
  }

  /* ======================================================================= *
   *  부팅
   * ==================================================================== */
  async boot() {
    this.hud.bootProgress(0, 10, '렌더러 준비 중…');

    /* --- 렌더러 --- */
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.quality.pixelRatio));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 실내 어두운 장면 - 톤매핑이 있어야 밝은 전구 주변이 안 타버린다
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.autoClear = false;      // 뷰모델을 덧그리기 위해
    document.body.appendChild(this.renderer.domElement);

    /* --- 씬 / 카메라 --- */
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.settings.fov, innerWidth / innerHeight, 0.06, this.quality.drawDistance
    );

    /* --- 에셋 --- */
    this.assets = new AssetManager(this.renderer);
    this.assets.setAnisotropy(this.quality.anisotropy);

    const keys = Object.keys(MODELS);
    await this.assets.loadAll(keys, (done, total, key) => {
      this.hud.bootProgress(done, total, `모델 불러오는 중… (${done}/${total}) ${key}`);
    });

    if (this.assets.missing.length) {
      this.hud.bootProgress(1, 1,
        `임시 도형으로 대체: ${this.assets.missing.join(', ')}`);
    } else {
      this.hud.bootProgress(1, 1, '준비 완료');
    }

    /* --- 월드 / 이펙트 / 캐릭터 --- */
    this.world = new World(this.scene, this.assets).build(this.quality);
    this.fx = new Effects(this.scene);
    this.entities = new EntityManager(this.scene, this.assets);
    this.entities.onStep = (pos, run) => audio.step(pos, this._listener(), run);

    /* --- 플레이어 / 입력 --- */
    this.player = new LocalPlayer(this.camera, this.assets, this.fx, this.settings);
    this.controls = new Controls(this.settings);
    this._wirePlayer();

    /* --- 화면 크기 --- */
    addEventListener('resize', () => this._resize());
    addEventListener('orientationchange', () => setTimeout(() => this._resize(), 250));
    this._resize();

    /* --- UI 연결 --- */
    this._wireHud();
    this._wireNet();
    this.hud.syncSettings(this.settings);

    /* --- 서버 연결 --- */
    try {
      await this.net.connect();
    } catch (err) {
      this.hud.bootProgress(1, 1, '서버 연결 실패 - 새로고침 해보세요');
      this.hud.error('menu', err.message);
    }

    this.myId = this.net.id;
    this.hud.el.nick.value = localStorage.getItem('market-raid-nick') || '';

    this.state = 'menu';
    this.hud.show('menu');

    /* --- 렌더 루프 시작 --- */
    this._loop();
  }

  /* ======================================================================= *
   *  플레이어 콜백
   * ==================================================================== */
  _wirePlayer() {
    const p = this.player;

    p.onShoot = (origin, dir) => {
      audio.shot(p.weapon, null, null, true);
      this.net.shoot(dir, (res) => {
        if (!res?.ok) {
          // 서버가 거부 (탄약/연사속도 불일치) -> 서버 값으로 되돌린다
          if (res?.reason === 'empty') { p.ammo = 0; }
          return;
        }
        p.ammo = res.ammo;
        if (res.hit) {
          this.hud.hitMarker(res.part === 'head');
          audio.flesh(null, null);
        }
      });
    };

    p.onReloadStart = (dur) => {
      this.net.reload();
      audio.reload(dur);
    };

    p.onStep = (pos, run) => audio.step(pos, this._listener(), run);
    p.onDryFire = () => audio.dryFire();

    this.controls.onReload = () => p.reload();
    this.controls.onMenu = () => this._togglePause();
    this.controls.onFirstInput = () => {
      audio.resume();
      audio.setVolume(this.settings.volume ?? 0.7);
    };

    this.controls.onLockChange = (locked) => {
      // 게임 중에 마우스 잠금이 풀리면(창 전환 등) 조준점을 숨겨서 상태를 알린다
      if (!locked && this.state === 'playing' && this.hud.el.pause.hidden) {
        this.hud.toast('화면을 클릭하면 다시 조준할 수 있습니다', '', 3200);
      }
    };
  }

  _listener() {
    return { x: this.player.pos.x, z: this.player.pos.z, yaw: this.player.yaw };
  }

  /* ======================================================================= *
   *  UI 콜백
   * ==================================================================== */
  _wireHud() {
    const A = this.hud.onAction;

    A.weapon = (w) => {
      this.myWeapon = w;
      if (this.net.room) this.net.setLoadout(w, undefined);
      // 로비/메뉴 양쪽 칩을 같이 맞춰준다
      for (const sel of ['#weaponPick', '#weaponPick2']) {
        for (const c of document.querySelectorAll(`${sel} .chip`)) {
          c.setAttribute('aria-pressed', String(c.dataset.w === w));
        }
      }
    };

    A.create = async () => {
      const name = this._nick();
      this.hud.error('menu', '');
      const res = await this.net.createRoom(name, this.myWeapon);
      if (!res?.ok) return this.hud.error('menu', res?.error || '방을 만들지 못했습니다.');
      this.myId = res.you;
      this.lobby = res.lobby;
      this.state = 'lobby';
      this.hud.renderLobby(res.lobby, this.myId);
      this.hud.show('lobby');
    };

    A.join = async () => {
      const code = this.hud.el.joinCode.value.trim().toUpperCase();
      if (code.length < 4) return this.hud.error('menu', '방 코드 5자리를 입력해주세요.');
      this.hud.error('menu', '');
      const res = await this.net.joinRoom(code, this._nick(), this.myWeapon);
      if (!res?.ok) return this.hud.error('menu', res?.error || '입장하지 못했습니다.');
      this.myId = res.you;
      this.lobby = res.lobby;
      this.state = 'lobby';
      this.hud.renderLobby(res.lobby, this.myId);
      this.hud.show('lobby');
    };

    // 혼자 연습: 방을 만들고 바로 시작
    A.solo = async () => {
      await A.create();
      if (this.state === 'lobby') {
        this.net.setRoomConfig({ botCount: 3, difficulty: 'easy' });
        setTimeout(() => this.net.startMatch(), 220);
      }
    };

    A.leave = () => {
      this.net.leaveRoom();
      this.lobby = null;
      this.state = 'menu';
      this.hud.show('menu');
    };

    A.ready = () => {
      this._ready = !this._ready;
      this.net.setLoadout(undefined, this._ready);
      document.getElementById('btnReady').textContent = this._ready ? '준비 취소' : '준비 완료';
    };

    A.start = () => this.net.startMatch();
    A.botCount = (n) => this.net.setRoomConfig({ botCount: n });
    A.difficulty = (d) => this.net.setRoomConfig({ difficulty: d });

    A.openSettings = () => {
      this._settingsFrom = this.state;
      this.hud.syncSettings(this.settings);
      this.hud.show('pause');
    };

    A.resume = () => {
      if (this.state === 'playing') {
        this.hud.showHudOnly();
        this.controls.setEnabled(true);
        this.controls.requestPointerLock();
      } else if (this._settingsFrom === 'lobby') {
        this.hud.show('lobby');
      } else {
        this.hud.show('menu');
      }
    };

    A.quit = () => {
      this.net.leaveRoom();
      this._endMatch();
      this.state = 'menu';
      this.hud.show('menu');
    };

    A.quality = (q) => this._applyQuality(q, true);

    A.setting = (key, value) => {
      this.settings[key] = value;
      saveSettings(this.settings);
      if (key === 'volume') { audio.resume(); audio.setVolume(value); }
      if (key === 'fov' && this.state !== 'playing') {
        this.camera.fov = value;
        this.camera.updateProjectionMatrix();
      }
      if (key === 'showFps') this.hud.setFps(0, value);
      if (key === 'leftHanded') this._applyHandedness(value);
    };

    A.again = () => {
      this.hud.show('lobby');
      this.state = 'lobby';
      if (this.lobby) this.hud.renderLobby(this.lobby, this.myId);
    };

    A.toMenu = () => {
      this.net.leaveRoom();
      this.state = 'menu';
      this.hud.show('menu');
    };

    this._applyHandedness(this.settings.leftHanded);
  }

  _nick() {
    const v = (this.hud.el.nick.value || '').trim() || '대원';
    localStorage.setItem('market-raid-nick', v);
    return v;
  }

  /** 왼손잡이: 조이스틱과 버튼 뭉치를 좌우로 뒤집는다 */
  _applyHandedness(left) {
    const t = document.getElementById('touch');
    if (!t) return;
    t.style.transform = left ? 'scaleX(-1)' : '';
    // 뒤집으면 글자도 뒤집히므로 버튼 안쪽을 한 번 더 뒤집어준다
    for (const b of t.querySelectorAll('.tbtn, #btnMenu')) {
      b.style.transform = left ? 'scaleX(-1)' : '';
    }
  }

  /* ======================================================================= *
   *  네트워크 이벤트
   * ==================================================================== */
  _wireNet() {
    const net = this.net;

    net.on('lobby', (lobby) => {
      this.lobby = lobby;
      if (this.state === 'lobby') this.hud.renderLobby(lobby, this.myId);
    });

    net.on('matchStart', (data) => this._startMatch(data));

    net.on('snapshot', (snap) => this._onSnapshot(snap));

    net.on('matchEnd', (data) => {
      this._endMatch();
      audio.jingle(data.result === 'won');
      this.hud.showEnd(data, this.myId);
      this.state = 'ended';
    });

    /* --- 다른 플레이어 사격 --- */
    net.on('playerShot', (d) => {
      if (d.id === this.myId) return;      // 내 총은 이미 로컬에서 처리했다
      const from = new THREE.Vector3(d.x, d.y, d.z);
      const dir = new THREE.Vector3(d.dx, d.dy, d.dz).normalize();
      this.fx.flash(from.clone().addScaledVector(dir, 0.35), null);
      this.fx.tracer(from, dir, d.dist || 40, false);
      const shooter = this.entities.players.get(d.id);
      audio.shot(shooter?.weaponKey || 'rifle', { x: d.x, z: d.z }, this._listener());
      if (!d.hit) this._impactAt(from, dir, d.dist);
    });

    /* --- 봇 사격 --- */
    net.on('botShot', (d) => {
      const from = new THREE.Vector3(d.x, d.y, d.z);
      const to = new THREE.Vector3(d.tx, d.ty, d.tz);
      const dir = to.clone().sub(from).normalize();
      const dist = from.distanceTo(to);
      this.fx.flash(from.clone().addScaledVector(dir, 0.3), null);
      this.fx.tracer(from, dir, dist, false);
      audio.shot('rifle', { x: d.x, z: d.z }, this._listener());
      if (!d.hit) this._impactAt(from, dir, dist + 2);
    });

    /* --- 피해 --- */
    net.on('playerHit', (d) => {
      if (d.id === this.myId) {
        this.player.hp = d.hp;
        this.hud.setHealth(d.hp);
        audio.hurt();
        // 맞은 방향 (공격자가 봇이면 그 봇 위치 기준)
        const src = this.entities.bots.get(d.by) || this.entities.players.get(d.by);
        let angle = null;
        if (src) {
          const dx = src.group.position.x - this.player.pos.x;
          const dz = src.group.position.z - this.player.pos.z;
          const world = Math.atan2(dx, -dz);
          angle = world - this.player.yaw;
        }
        this.hud.damageFlash(Math.min(0.85, d.dmg / 45), angle);
      } else {
        const ch = this.entities.players.get(d.id);
        if (ch) this.fx.blood(ch.group.position.clone().setY(1.1));
      }
    });

    net.on('playerDown', (d) => {
      if (d.id === this.myId) {
        this.player.alive = false;
        this.controls.reset();
        this.hud.toast('전사했습니다 — 팀원이 임무를 완수하길', 'warn', 4200);
        this.hud.setHealth(0);
      } else {
        this.entities.players.get(d.id)?.die();
        const name = this.lobby?.players.find((p) => p.id === d.id)?.name || '팀원';
        this.hud.toast(`${name} 전사`, 'warn');
      }
    });

    net.on('playerReload', (d) => {
      if (d.id !== this.myId) audio.reload(d.duration);
    });

    net.on('playerLeft', (d) => {
      this.entities.removePlayer(d.id);
    });

    /* --- 봇 --- */
    net.on('botHit', (d) => {
      const b = this.entities.bots.get(d.id);
      if (b) this.fx.blood(b.group.position.clone().setY(1.05));
      if (d.by === this.myId) this.hud.hitMarker(false);
    });

    net.on('botDown', (d) => {
      this.entities.bots.get(d.id)?.die();
      if (d.by === this.myId) {
        this.hud.hitMarker(true);
        this.hud.toast('적 제압', 'good', 1400);
      }
    });

    /* --- 목표 --- */
    net.on('siteProgress', (d) => {
      this.siteProgress.set(d.id, d.progress);
      this.hud.setSiteProgress(d.id, d.progress);
      if (d.by?.includes(this.myId) && d.progress > 0) {
        const now = performance.now();
        if (now - (this._lastBeep || 0) > 260) {
          this._lastBeep = now;
          audio.beep(d.progress);
        }
      }
    });

    net.on('siteDefused', (d) => {
      this.world.setSiteDefused(d.id);
      this.hud.setSiteDefused(d.id);
      this.hud.toast(`폭발물 ${d.id} 해체 완료`, 'good', 3000);
      audio.jingle(true);
    });

    net.on('disconnect', () => {
      if (this.state === 'playing') {
        this.hud.toast('서버와 연결이 끊겼습니다', 'warn', 6000);
        this._endMatch();
        this.state = 'menu';
        this.hud.show('menu');
      }
    });
  }

  /** 총알이 빗나갔을 때 벽 어딘가에 탄착을 찍는다 */
  _impactAt(from, dir, dist) {
    const d = Math.min(dist || 30, 40);
    const point = from.clone().addScaledVector(dir, d);
    this.fx.impact(point, dir.clone().negate(), 'concrete');
    audio.impact({ x: point.x, z: point.z }, this._listener());
  }

  /* ======================================================================= *
   *  판 시작 / 종료
   * ==================================================================== */
  _startMatch(data) {
    this.state = 'playing';
    this.matchEndsAt = data.endsAt;
    this.weapons = data.weapons;
    this.siteProgress.clear();

    this.hud.resetCache();
    this.hud.initSites(data.sites);
    this.hud.showHudOnly();
    this.fx.reset();

    this.world.resetSiteMarkers();

    /* --- 캐릭터 만들기 --- */
    this.entities.clear();
    for (const p of data.players) {
      if (p.id === this.myId) {
        this.myWeapon = p.weapon;
        this.player.spawn(p.x, p.z, p.yaw);
        this.player.setWeapon(p.weapon);
        this.player.setSpec(this.weapons[p.weapon]);
        this.player.ammo = this.weapons[p.weapon].mag;
        this.player.reserve = this.weapons[p.weapon].reserve;
      } else {
        this.entities.addPlayer(p);
      }
    }
    for (const b of data.bots) this.entities.addBot(b);

    /* --- HUD 초기값 --- */
    const spec = this.weapons[this.myWeapon];
    this.hud.setHealth(100);
    this.hud.setAmmo(spec.mag, spec.reserve, spec.name);
    this.hud.setReloading(false);

    /* --- 입력/오디오 켜기 --- */
    this.controls.setEnabled(true);
    const locked = this.controls.requestPointerLock();
    // 방장이 시작한 경우 다른 인원은 클릭을 한 적이 없어서 마우스가 안 잠긴다
    if (!locked && this.controls.needsClickToLock()) {
      this.hud.toast('화면을 한 번 클릭하면 마우스로 조준할 수 있습니다', '', 5000);
    }
    audio.resume();
    audio.setVolume(this.settings.volume ?? 0.7);
    audio.startAmbient();

    /* --- 서버로 내 위치 보내기 시작 --- */
    this.net.startInputLoop(() => (this.state === 'playing' ? this.player.netState() : null));

    this.hud.toast('폭발물 2개를 찾아 해체하라', '', 4200);
  }

  _endMatch() {
    this.net.stopInputLoop();
    this.controls.setEnabled(false);
    this.controls.exitPointerLock();
    audio.stopAmbient();
    this.defusingSite = null;
  }

  _togglePause() {
    if (this.state !== 'playing') return;
    const paused = !this.hud.el.pause.hidden;
    if (paused) {
      this.hud.showHudOnly();
      this.controls.setEnabled(true);
      this.controls.requestPointerLock();
    } else {
      this.hud.syncSettings(this.settings);
      this.hud.el.pause.hidden = false;
      this.controls.setEnabled(false);
      this.controls.exitPointerLock();
    }
  }

  /* ======================================================================= *
   *  스냅샷 반영
   * ==================================================================== */
  _onSnapshot(snap) {
    this.lastSnapshot = snap;
    if (this.state !== 'playing') return;

    const serverTime = snap.t;
    this.entities.applySnapshot(snap, this.myId, serverTime);

    /* --- 내 상태는 서버 값을 따른다 (탄약/체력은 서버가 진실) --- */
    const me = snap.players.find((p) => p.id === this.myId);
    if (me) {
      this.player.hp = me.hp;
      this.hud.setHealth(me.hp);
      this.player.ammo = me.ammo;
      this.player.reserve = me.reserve;
      const spec = this.weapons?.[this.myWeapon];
      this.hud.setAmmo(me.ammo, me.reserve, spec?.name);

      const reloading = !!me.reloading;
      if (!reloading && this.player.reloading) this.player.reloading = false;
      this.hud.setReloading(reloading);

      if (!me.alive && this.player.alive) this.player.alive = false;
      if (me.alive && !this.player.alive) {
        this.player.alive = true;
        this.player.eyeHeight = 1.62;
      }
    }

    /* --- 팀 상태 --- */
    const team = snap.players.map((p) => ({
      id: p.id, hp: p.hp, alive: p.alive,
      name: this.lobby?.players.find((x) => x.id === p.id)?.name || '대원',
    }));
    this.hud.setTeam(team, this.myId);

    this.hud.setTimer(snap.remaining);
  }

  /* ======================================================================= *
   *  해체 상호작용
   * ==================================================================== */
  _updateDefuse() {
    const p = this.player;
    const site = p.defuseTarget;

    if (!site || !p.alive) {
      if (this.defusingSite) { this.net.defuse(this.defusingSite, false); this.defusingSite = null; }
      this.hud.setInteract(null);
      return;
    }

    const progress = this.siteProgress.get(site.id) || 0;
    const done = progress >= 1;

    if (done) {
      this.hud.setInteract(`${site.label} — 해체 완료`, 1);
      if (this.defusingSite) { this.net.defuse(this.defusingSite, false); this.defusingSite = null; }
      return;
    }

    const holding = this.controls.use;
    this.hud.setInteract(
      holding ? `${site.label} 해체 중…` : `${site.label} — 해체하려면 누르고 있기`,
      progress
    );

    if (holding && this.defusingSite !== site.id) {
      this.net.defuse(site.id, true);
      this.defusingSite = site.id;
    } else if (!holding && this.defusingSite) {
      this.net.defuse(this.defusingSite, false);
      this.defusingSite = null;
    }
  }

  /* ======================================================================= *
   *  품질
   * ==================================================================== */
  _applyQuality(name, fromUser = false) {
    if (!QUALITY[name]) return;
    this.settings.quality = name;
    this.quality = QUALITY[name];
    if (fromUser) {
      this.settings.autoScale = false;   // 사용자가 직접 골랐으면 자동조절 끈다
      document.getElementById('setAuto').checked = false;
    }
    saveSettings(this.settings);

    const q = this.quality;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.camera.far = q.drawDistance;
    this.camera.updateProjectionMatrix();
    this.assets.setAnisotropy(q.anisotropy);
    this.world?.applyQuality(q);

    this._lowFpsTime = 0;
    if (fromUser) this.hud.toast(`화질: ${q.label}`, '', 1600);
  }

  _autoScale(dt, fps) {
    if (!this.settings.autoScale || this.state !== 'playing') return;
    const order = ['low', 'medium', 'high', 'ultra'];
    const idx = order.indexOf(this.settings.quality);

    if (fps < 45 && idx > 0) {
      this._lowFpsTime += dt;
      if (this._lowFpsTime > 3) {
        this._applyQuality(order[idx - 1]);
        this.hud.toast(`프레임이 낮아 화질을 "${QUALITY[order[idx - 1]].label}" 로 낮췄습니다`, '', 2600);
        this._lowFpsTime = 0;
      }
    } else {
      this._lowFpsTime = Math.max(0, this._lowFpsTime - dt * 0.5);
    }
  }

  /* ======================================================================= *
   *  화면 크기
   * ==================================================================== */
  _resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.quality.pixelRatio));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ======================================================================= *
   *  메인 루프
   * ==================================================================== */
  _loop = () => {
    requestAnimationFrame(this._loop);

    const now = performance.now();
    let dt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    // 탭을 다시 열었을 때 dt 가 엄청 커져서 벽을 뚫는 걸 막는다
    dt = Math.min(dt, 0.1);

    /* --- FPS --- */
    this._frames++;
    this._fpsTimer += dt;
    if (this._fpsTimer >= 0.5) {
      const fps = Math.round(this._frames / this._fpsTimer);
      this._frames = 0;
      this._fpsTimer = 0;
      this.hud.setFps(fps, this.settings.showFps);
      this._autoScale(0.5, fps);
    }

    const t = now / 1000;

    /* --- 갱신 --- */
    if (this.state === 'playing') {
      this.player.update(dt, this.controls, this.world, this.entities, now);
      this._updateDefuse();
      this.hud.setCrosshair(
        this.player.spread,
        this.player.adsAmount > 0.6,
        !this.player.alive
      );
    } else if (this.state === 'menu' || this.state === 'lobby') {
      this._orbitMenuCamera(t);
    }

    this.world?.update(t, this.camera.position);
    this.fx.update(dt);
    this.entities.update(dt, t, this.net.renderTime());

    /* --- 렌더 --- */
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (this.state === 'playing' || this.state === 'paused') {
      this.player.renderViewmodel(this.renderer);
    }
  };

  /** 메뉴에 있을 때 카메라가 맵을 천천히 돈다 (배경 화면) */
  _orbitMenuCamera(t) {
    const r = 6.5;
    const a = t * 0.08;
    this.camera.position.set(Math.cos(a) * r, 2.05 + Math.sin(t * 0.3) * 0.25, Math.sin(a) * r * 0.6);
    this.camera.lookAt(0, 1.3, 0);
    this.camera.rotation.z = 0;
  }
}

/* ========================================================================== *
 *  총 위치 조절기 (PC 에서 V 키) - 개발 편의 도구
 * ========================================================================== */
function setupTuner(game) {
  const panel = document.getElementById('tuner');
  const out = document.getElementById('tunerOut');
  const ids = ['tnX', 'tnY', 'tnZ', 'tnRX', 'tnRY', 'tnRZ', 'tnS'];
  const els = ids.map((i) => document.getElementById(i));
  const vals = ids.map((i) => document.getElementById(i + 'v'));

  const read = () => {
    const p = game.player;
    if (!p?.vmBase) return;
    const v = [
      p.vmHolder.position.x, p.vmHolder.position.y, p.vmHolder.position.z,
      p.vmHolder.rotation.x, p.vmHolder.rotation.y, p.vmHolder.rotation.z,
      p.vmHolder.scale.x,
    ];
    els.forEach((el, i) => { el.value = v[i]; vals[i].textContent = v[i].toFixed(3); });
  };

  const write = () => {
    const p = game.player;
    if (!p?.vmBase) return;
    const v = els.map((el) => parseFloat(el.value));
    els.forEach((el, i) => { vals[i].textContent = v[i].toFixed(3); });

    // 슬라이더가 실제로 반영되게 base 값을 바꾼다 (매 프레임 덮어쓰이므로)
    p.vmBase.pos.set(v[0], v[1], v[2]);
    p.vmBase.rot.set(v[3], v[4], v[5]);
    p.vmHolder.scale.setScalar(v[6]);
    p.vmBase.scale = v[6];

    out.value =
`  ${game.myWeapon}: { pos: [${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}], ` +
`rot: [${v[3].toFixed(3)}, ${v[4].toFixed(3)}, ${v[5].toFixed(3)}], scale: ${v[6].toFixed(2)},
        adsPos: [${(0).toFixed(3)}, ${(v[1] * 0.5).toFixed(3)}, ${(v[2] * 0.72).toFixed(3)}], adsRot: [0, 0, 0] },`;
  };

  for (const el of els) el.addEventListener('input', write);

  document.getElementById('tnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(out.value); } catch { out.select(); }
  };

  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyV' || game.controls?.isTouch) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { read(); write(); }
  });
}

/* ========================================================================== *
 *  시작
 * ========================================================================== */
const game = new Game();
window.game = game;          // 콘솔에서 만져볼 수 있게

game.boot()
  .then(() => setupTuner(game))
  .catch((err) => {
    console.error(err);
    const msg = document.getElementById('bootMsg');
    if (msg) msg.textContent = '오류: ' + err.message;
  });

/* 화면 켜짐 유지 (모바일에서 게임 중 화면이 꺼지면 곤란하다) */
if ('wakeLock' in navigator) {
  const keepAwake = async () => {
    try { await navigator.wakeLock.request('screen'); } catch { /* 권한 없음 */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });
  keepAwake();
}

/* 가로 모드 고정 시도 (전체화면일 때만 먹힌다) */
document.addEventListener('click', function lockOnce() {
  document.removeEventListener('click', lockOnce);
  if (screen.orientation?.lock) {
    screen.orientation.lock('landscape').catch(() => { /* 데스크톱이거나 미지원 */ });
  }
}, { once: true });
