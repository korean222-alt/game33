/* =============================================================================
 *  entities.js  -  남의 캐릭터(대원 / 용의자 / 민간인) 표시 + 총격·폭발 이펙트
 *
 *  서버 스냅샷은 20Hz 로 온다. 그대로 그리면 뚝뚝 끊기므로 NET.interpDelayMs 만큼
 *  일부러 늦춰서 두 스냅샷 사이를 보간한다(엔티티 보간).
 *
 *  동작은 첨부한 Mixamo 클립을 CharacterRig 가 골라 재생한다. 보간된 위치에서
 *  속도를 역산해 걷기/달리기/측면이동/후진을 판단하므로 서버가 별도로 동작
 *  이름을 보낼 필요가 없다.
 * ========================================================================== */

import * as THREE from 'three';
import { NET } from './config.js';
import { makePlaceholder } from './assets.js';
import { CharacterRig } from './character-animation.js';

const TEAM_COLORS = [0x5b8fd6, 0x64b06a, 0xd6b45b, 0xb06fc4];
const SUSPECT_COLOR = 0xa8564a;
const HVT_COLOR = 0xd2512f;
const CIVILIAN_COLOR = 0xcfc6ad;

const KIND_LABEL = { suspect: '용의자', hvt: '주요 용의자', civilian: '민간인' };

/* ========================================================================== *
 *  보간 버퍼 - {t, x, y, z, yaw} 스냅샷을 모아두고 과거 시점을 재생한다
 * ========================================================================== */
class InterpBuffer {
  constructor() { this.buf = []; }

  push(t, s) {
    this.buf.push({ t, ...s });
    while (this.buf.length > 2 && t - this.buf[0].t > 1000) this.buf.shift();
  }

  /** renderTime 시점의 상태. 없으면 null */
  sample(renderTime) {
    const b = this.buf;
    if (b.length === 0) return null;
    if (b.length === 1 || renderTime <= b[0].t) return b[0];
    if (renderTime >= b[b.length - 1].t) return b[b.length - 1];

    for (let i = 0; i < b.length - 1; i++) {
      const a = b[i], c = b[i + 1];
      if (renderTime >= a.t && renderTime <= c.t) {
        const k = (renderTime - a.t) / (c.t - a.t || 1);
        return {
          x: a.x + (c.x - a.x) * k,
          y: a.y + (c.y - a.y) * k,
          z: a.z + (c.z - a.z) * k,
          yaw: a.yaw + shortestAngle(a.yaw, c.yaw) * k,
          moving: c.moving, crouch: c.crouch, alive: c.alive, hp: c.hp,
          state: c.state, hands: c.hands, cuffed: c.cuffed, downed: c.downed,
        };
      }
    }
    return b[b.length - 1];
  }
}

/** -PI~PI 범위의 최단 회전차 (359도 -> 1도 로 갈 때 한 바퀴 안 돌게) */
function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ========================================================================== *
 *  캐릭터 아바타 하나
 * ========================================================================== */
class Avatar {
  constructor(scene, assets, { color, name, kind = 'suspect', weapon = 'rifle', armed = true }) {
    this.scene = scene;
    this.kind = kind;
    this.buffer = new InterpBuffer();
    this.alive = true;
    this.confirmedDead = false;
    this.latestHp = 100;
    this.predictedDamage = 0;
    this.lastSample = null;
    this.speed = 0;
    this.forward = 0;
    this.strafe = 0;

    this.group = new THREE.Group();

    let body;
    try {
      body = assets.instance('character', { skinned: true });
    } catch {
      body = makePlaceholder({ type: 'humanoid', h: 1.8, color });
      body.userData.isPlaceholder = true;
    }
    // 진영 구분 색. 텍스처를 완전히 덮지 않도록 절반만 섞는다.
    body.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      o.material = mats.map((m) => {
        const c = m.clone();
        if (c.color && !c.map) c.color.lerp(new THREE.Color(color), 0.18);
        // Preserve skin/clothing textures instead of tinting the entire person red.
        return c;
      });
      if (o.material.length === 1) o.material = o.material[0];
      o.castShadow = true;
      o.frustumCulled = false;    // 스킨 변형 때문에 경계 상자가 어긋난다
    });
    this.group.add(body);
    this.body = body;
    this.rig = new CharacterRig(body, body.userData.isPlaceholder ? [] : assets.animations('character'));

    if (armed) {
      this.weapon = assets.instance(weapon);
      this.weapon.scale.setScalar(0.82);
      this.group.add(this.weapon);
      this.gripOffset = weapon === 'sniper' ? 0.16 : weapon === 'smg' ? 0.07 : 0.11;
    }

    this.nameTag = makeNameTag(name, color);
    this.nameTag.position.y = 1.98;
    this.group.add(this.nameTag);

    scene.add(this.group);
  }

  push(t, s) { this.buffer.push(t, s); }

  update(renderTime, camera, dt) {
    const s = this.buffer.sample(renderTime);
    if (!s) return;
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) return;

    // 보간 위치에서 속도를 역산해 동작을 고른다.
    if (this.lastSample && dt > 0) {
      const vx = (s.x - this.lastSample.x) / dt;
      const vz = (s.z - this.lastSample.z) / dt;
      const speed = Math.hypot(vx, vz);
      this.speed += (speed - this.speed) * Math.min(1, dt * 9);
      if (speed > 0.05) {
        const fwdX = -Math.sin(s.yaw), fwdZ = -Math.cos(s.yaw);
        this.forward = (vx * fwdX + vz * fwdZ) / speed;
        this.strafe = (vx * Math.cos(s.yaw) - vz * Math.sin(s.yaw)) / speed;
      }
    }
    this.lastSample = { x: s.x, z: s.z };

    this.group.position.set(s.x, s.y || 0, s.z);
    this.group.rotation.y = s.yaw;

    const alive = s.alive === undefined ? true : !!s.alive;
    const visible = alive && !this.confirmedDead && this.latestHp > 0;
    this.alive = alive;

    const surrendered = !!s.hands || !!s.cuffed || s.state === 'surrender';
    this.rig.update(dt, {
      speed: this.speed,
      forward: this.forward,
      strafe: this.strafe,
      crouch: !!s.crouch || surrendered,
      aiming: this.kind !== 'civilian' && !surrendered && s.state === 'engage',
      hands: surrendered,
      dead: !visible || !!s.downed,
    });
    if (this.weapon) {
      this.weapon.visible = !surrendered && visible;
      if (this.weapon.visible) this.rig.alignWeapon(this.weapon, this.group, this.gripOffset);
    }

    // 사망/쓰러짐은 모델을 지우지 않고 사망 동작으로 남긴다.
    this.group.visible = visible || this.rig.dead;
    this.nameTag.visible = visible;
    if (this.nameTag.visible) this.nameTag.quaternion.copy(camera.quaternion);
  }

  dispose() {
    this.scene.remove(this.group);
    this.rig.dispose();
    // 지오메트리와 텍스처는 AssetManager 소유이고 모든 아바타가 공유한다.
    // 여기서 해제할 것은 복제한 재질과 이름표 텍스처뿐이다.
    this.body.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    });
    this.nameTag.material.map.dispose();
    this.nameTag.material.dispose();
  }
}

/** 캔버스로 이름표 스프라이트를 만든다 */
function makeNameTag(text, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.font = 'bold 34px -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,.85)';
  g.strokeText(text, 128, 32);
  g.fillStyle = '#' + new THREE.Color(color).getHexString();
  g.fillText(text, 128, 32);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: true,
  }));
  sp.scale.set(1.1, 0.28, 1);
  sp.renderOrder = 5;
  return sp;
}

/* ========================================================================== *
 *  전체 관리자
 * ========================================================================== */
export class Entities {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.players = new Map();   // id -> Avatar
    this.npcs = new Map();      // id -> Avatar (용의자 + 민간인)
    this.effects = new Effects(scene);
    this.myId = null;
  }

  setMyId(id) { this.myId = id; }

  /** 호환용 별칭 - 기존 코드가 bots 라는 이름으로 접근한다. */
  get bots() { return this.npcs; }

  spawnPlayers(list) {
    for (const p of list) {
      if (p.id === this.myId || this.players.has(p.id)) continue;
      this.players.set(p.id, new Avatar(this.scene, this.assets, {
        color: TEAM_COLORS[p.slot % TEAM_COLORS.length], name: p.name,
        kind: 'teammate', weapon: p.weapon,
      }));
    }
  }

  spawnNpcs(list) {
    for (const n of list) {
      if (this.npcs.has(n.id)) continue;
      const civilian = n.kind === 'civilian';
      const avatar = new Avatar(this.scene, this.assets, {
        color: civilian ? CIVILIAN_COLOR : n.kind === 'hvt' ? HVT_COLOR : SUSPECT_COLOR,
        name: n.hostage ? '인질' : (KIND_LABEL[n.kind] || '용의자'),
        kind: n.kind, armed: !civilian,
      });
      avatar.latestHp = n.hp ?? n.maxHp ?? 100;
      avatar.group.position.set(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      avatar.push(performance.now(), {
        ...n, x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0, yaw: n.yaw ?? 0, alive: n.alive ?? 1,
      });
      this.npcs.set(n.id, avatar);
    }
  }

  /** 서버 스냅샷 반영 */
  onSnapshot(snap) {
    const t = performance.now();
    this.spawnNpcs(snap.npcs || []); // recover entities missed during a join event
    for (const p of snap.players) {
      if (p.id === this.myId) continue;
      this.players.get(p.id)?.push(t, p);
    }
    for (const n of snap.npcs || []) {
      const avatar = this.npcs.get(n.id);
      if (!avatar) continue;
      if (Number.isFinite(n.hp)) avatar.latestHp = n.hp;
      if (n.alive === 0 || n.alive === false) avatar.confirmedDead = true;
      avatar.push(t, n);
    }
  }

  shotTargets() {
    return [...this.npcs].map(([id, avatar]) => ({
      id, x: avatar.group.position.x, y: avatar.group.position.y, z: avatar.group.position.z,
      alive: !avatar.confirmedDead && avatar.latestHp - avatar.predictedDamage > 0,
    }));
  }

  applyShotPredictions(pending) {
    for (const [id, avatar] of this.npcs) {
      avatar.predictedDamage = pending.reduce((sum, shot) =>
        sum + (shot.prediction?.targetId === id ? shot.prediction.damage : 0), 0);
    }
  }

  confirmNpcHealth(id, hp) {
    const avatar = this.npcs.get(id);
    if (!avatar || !Number.isFinite(hp)) return;
    avatar.latestHp = hp;
    if (hp <= 0) avatar.confirmedDead = true;
  }

  markDown(id) {
    const avatar = this.npcs.get(id);
    if (avatar) { avatar.alive = false; avatar.confirmedDead = true; }
  }

  removePlayer(id) {
    this.players.get(id)?.dispose();
    this.players.delete(id);
  }

  update(dt, camera) {
    // 일부러 과거를 그린다 -> 두 스냅샷 사이가 항상 채워져 부드럽다
    const renderTime = performance.now() - NET.interpDelayMs;
    for (const a of this.players.values()) a.update(renderTime, camera, dt);
    for (const a of this.npcs.values()) a.update(renderTime, camera, dt);
    this.effects.update(dt);
  }

  clear() {
    for (const a of this.players.values()) a.dispose();
    for (const a of this.npcs.values()) a.dispose();
    this.players.clear();
    this.npcs.clear();
    this.effects.clear();
  }
}

/* ========================================================================== *
 *  이펙트 (예광탄 / 탄착 / 투척체 / 폭발 / 가스)
 * ========================================================================== */
class Effects {
  constructor(scene) {
    this.scene = scene;
    this.tracers = [];
    this.sparks = [];
    this.grenades = new Map();
    this.clouds = new Map();
    this.blasts = [];

    this.tracerGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
    ]);
    this.tracerMat = new THREE.LineBasicMaterial({
      color: 0xffd27a, transparent: true, opacity: 0.9,
    });
    this.sparkGeo = new THREE.SphereGeometry(0.045, 6, 4);
    this.sparkMat = new THREE.MeshBasicMaterial({ color: 0xffc46a, transparent: true });
    this.grenadeGeo = new THREE.SphereGeometry(0.075, 10, 8);
    this.cloudGeo = new THREE.SphereGeometry(1, 12, 10);
  }

  /** 총알 궤적 한 줄 */
  tracer(from, dir, dist) {
    const line = new THREE.Line(this.tracerGeo, this.tracerMat.clone());
    line.position.set(from.x, from.y, from.z);
    line.scale.z = Math.max(0.5, dist);
    line.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(dir.x, dir.y, dir.z).normalize(),
    );
    this.scene.add(line);
    this.tracers.push({ obj: line, life: 0.075 });
  }

  /** 탄착 불꽃 */
  spark(pos) {
    const m = new THREE.Mesh(this.sparkGeo, this.sparkMat.clone());
    m.position.set(pos.x, pos.y, pos.z);
    this.scene.add(m);
    this.sparks.push({ obj: m, life: 0.18 });
    for (let i = 0; i < 5; i++) {
      const particle = new THREE.Mesh(this.sparkGeo, this.sparkMat.clone());
      particle.scale.setScalar(.35); particle.position.copy(m.position); this.scene.add(particle);
      this.sparks.push({
        obj: particle, life: .18,
        velocity: new THREE.Vector3((Math.random() - .5) * 2.8, Math.random() * 2.5, (Math.random() - .5) * 2.8),
      });
    }
  }

  /** 사격 한 발을 그린다 (from 에서 dir 로 dist 만큼) */
  shot(from, dir, dist) {
    this.tracer(from, dir, dist);
    // A brief depth-tested flash reveals the actual shooter without showing through walls.
    const flash = new THREE.Mesh(this.sparkGeo, this.sparkMat.clone());
    flash.position.set(from.x, from.y, from.z);
    flash.scale.setScalar(2);
    this.scene.add(flash);
    this.sparks.push({ obj: flash, life: 0.1 });
    this.spark({
      x: from.x + dir.x * dist,
      y: from.y + dir.y * dist,
      z: from.z + dir.z * dist,
    });
  }

  /* ---- 투척체 ---- */
  grenade(id, type, pos, color) {
    let entry = this.grenades.get(id);
    if (!entry) {
      const mesh = new THREE.Mesh(this.grenadeGeo,
        new THREE.MeshStandardMaterial({ color, roughness: .5, metalness: .4 }));
      mesh.castShadow = true;
      this.scene.add(mesh);
      entry = { mesh };
      this.grenades.set(id, entry);
    }
    entry.mesh.position.set(pos.x, pos.y + 0.08, pos.z);
  }

  removeGrenade(id) {
    const entry = this.grenades.get(id);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.mesh.material.dispose();
    this.grenades.delete(id);
  }

  /** 남아 있지 않은 투척체 정리 */
  syncGrenades(list) {
    const alive = new Set(list.map((g) => g.id));
    for (const id of [...this.grenades.keys()]) if (!alive.has(id)) this.removeGrenade(id);
  }

  blast(pos, type) {
    const color = type === 'flash' ? 0xfff6d8 : type === 'gas' ? 0x9fb0b8 : 0xffa24a;
    const mesh = new THREE.Mesh(this.cloudGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    mesh.position.set(pos.x, pos.y + 0.3, pos.z);
    mesh.scale.setScalar(0.3);
    this.scene.add(mesh);
    this.blasts.push({ obj: mesh, life: type === 'frag' ? 0.5 : 0.35, max: type === 'flash' ? 4 : 3 });
    const light = new THREE.PointLight(color, type === 'flash' ? 900 : 500, 18, 2);
    light.position.copy(mesh.position);
    this.scene.add(light);
    this.blasts.push({ obj: light, life: 0.18, light: true });
  }

  gas(id, pos, seconds) {
    if (this.clouds.has(id)) return;
    const mesh = new THREE.Mesh(this.cloudGeo, new THREE.MeshBasicMaterial({
      color: 0xa8b6bc, transparent: true, opacity: 0.28, depthWrite: false,
    }));
    mesh.position.set(pos.x, pos.y + 0.9, pos.z);
    mesh.scale.setScalar(1.2);
    this.scene.add(mesh);
    this.clouds.set(id, { obj: mesh, life: seconds, total: seconds });
  }

  clearGas(id) {
    const entry = this.clouds.get(id);
    if (!entry) return;
    this.scene.remove(entry.obj);
    entry.obj.material.dispose();
    this.clouds.delete(id);
  }

  update(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const e = this.tracers[i];
      e.life -= dt;
      e.obj.material.opacity = Math.max(0, e.life / 0.075) * 0.9;
      if (e.life <= 0) { this.scene.remove(e.obj); e.obj.material.dispose(); this.tracers.splice(i, 1); }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const e = this.sparks[i];
      e.life -= dt;
      const k = Math.max(0, e.life / 0.18);
      if (e.velocity) { e.velocity.y -= dt * 7; e.obj.position.addScaledVector(e.velocity, dt); }
      e.obj.material.opacity = k;
      e.obj.scale.setScalar(0.6 + (1 - k) * 1.6);
      if (e.life <= 0) { this.scene.remove(e.obj); e.obj.material.dispose(); this.sparks.splice(i, 1); }
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const e = this.blasts[i];
      e.life -= dt;
      if (e.light) e.obj.intensity = Math.max(0, e.obj.intensity * (1 - dt * 8));
      else {
        const k = Math.max(0, e.life / 0.5);
        e.obj.material.opacity = k * 0.85;
        e.obj.scale.setScalar(0.3 + (1 - k) * e.max);
      }
      if (e.life <= 0) {
        this.scene.remove(e.obj);
        if (!e.light) e.obj.material.dispose();
        this.blasts.splice(i, 1);
      }
    }
    for (const [id, e] of this.clouds) {
      e.life -= dt;
      const grow = Math.min(1, (e.total - e.life) / 1.6);
      e.obj.scale.setScalar(1.2 + grow * 4.6);
      e.obj.material.opacity = 0.3 * Math.min(1, e.life / 2.5) * (0.4 + grow * 0.6);
      if (e.life <= 0) this.clearGas(id);
    }
  }

  clear() {
    for (const e of [...this.tracers, ...this.sparks]) {
      this.scene.remove(e.obj);
      e.obj.material.dispose();
    }
    for (const e of this.blasts) { this.scene.remove(e.obj); if (!e.light) e.obj.material.dispose(); }
    for (const id of [...this.grenades.keys()]) this.removeGrenade(id);
    for (const id of [...this.clouds.keys()]) this.clearGas(id);
    this.tracers.length = 0;
    this.sparks.length = 0;
    this.blasts.length = 0;
  }
}
