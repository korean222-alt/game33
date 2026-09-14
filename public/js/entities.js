/* =============================================================================
 *  entities.js  -  남의 캐릭터(팀원/봇) 표시 + 총격 이펙트
 *
 *  서버 스냅샷은 20Hz 로 온다. 그대로 그리면 뚝뚝 끊기므로 NET.interpDelayMs 만큼
 *  일부러 늦춰서 두 스냅샷 사이를 보간한다(엔티티 보간).
 * ========================================================================== */

import * as THREE from 'three';
import { NET } from './config.js';

const TEAM_COLORS = [0x5b8fd6, 0x64b06a, 0xd6b45b, 0xb06fc4];
const BOT_COLOR = 0xa8564a;

/* ========================================================================== *
 *  보간 버퍼 - {t, x, y, z, yaw} 스냅샷을 모아두고 과거 시점을 재생한다
 * ========================================================================== */
class InterpBuffer {
  constructor() { this.buf = []; }

  push(t, s) {
    this.buf.push({ t, ...s });
    // 1초보다 오래된 건 버린다
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
  constructor(scene, assets, { color, name, isBot, weapon = 'rifle' }) {
    this.scene = scene;
    this.isBot = isBot;
    this.buffer = new InterpBuffer();
    this.alive = true;
    this.confirmedDead = false;
    this.latestHp = 100;
    this.predictedDamage = 0;

    this.group = new THREE.Group();

    let body;
    try {
      body = assets.instance('character', { skinned: true });
    } catch {
      body = new THREE.Group();
    }
    // 팀/적 구분을 위해 색을 입힌다 (머티리얼을 공유하지 않도록 복제)
    body.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      o.material = mats.map((m) => {
        const c = m.clone();
        if (c.color) c.color.lerp(new THREE.Color(color), 0.6);
        return c;
      });
      if (o.material.length === 1) o.material = o.material[0];
      o.castShadow = true;
    });
    this.group.add(body);
    this.body = body;
    aimJoint(body, 'right_arm_06', 'right_forearm_07', [-.26, 1.16, -.12]);
    aimJoint(body, 'right_forearm_07', 'right_wrist_08', [.08, 1.04, -.22]);
    aimJoint(body, 'left_arm_03', 'left_forearm_04', [.28, 1.18, -.18]);
    aimJoint(body, 'left_forearm_04', 'left_wrist_05', [.10, 1.13, -.52]);
    this.joints = new Map();
    for (const name of ['left_leg_09', 'right_leg_012', 'left_knee_010', 'right_knee_013', 'left_arm_03', 'right_arm_06']) {
      const joint = body.getObjectByName(name);
      if (joint) this.joints.set(name, { joint, rest: joint.quaternion.clone() });
    }
    // The supplied PSX character is rigged but contains no animation clips.
    // Drive its actual limb joints without distorting or translating the mesh parts.
    this.phase = 0;
    this.lastPosition = null;
    this.weapon = assets.instance(weapon);
    this.weapon.rotation.y = Math.PI / 2;
    this.weapon.position.set(.10, 1.14, -.28);
    this.weapon.scale.setScalar(.78);
    this.group.add(this.weapon);

    this.nameTag = makeNameTag(name, color);
    this.nameTag.position.y = 2.0;
    this.group.add(this.nameTag);

    scene.add(this.group);
  }

  push(t, s) { this.buffer.push(t, s); }

  update(renderTime, camera) {
    const s = this.buffer.sample(renderTime);
    if (!s) return;

    if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) return;
    const distance = this.lastPosition ? Math.hypot(s.x - this.lastPosition.x, s.z - this.lastPosition.z) : 0;
    this.phase += Math.min(distance, .2) * 8;
    this.lastPosition = { x: s.x, z: s.z };
    const stride = distance > .0001 ? Math.sin(this.phase) * .42 : 0;
    const axis = new THREE.Vector3(1, 0, 0);
    for (const [name, { joint, rest }] of this.joints) {
      const side = name.startsWith('left') ? 1 : -1;
      let angle = stride * side;
      if (name.includes('knee')) angle = Math.max(0, -angle) * .8;
      if (name.includes('arm')) angle = 0; // Hold the weapon steady while the legs stride.
      joint.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    }
    this.group.position.set(s.x, s.y || 0, s.z);
    this.group.rotation.y = s.yaw;
    this.group.scale.y = s.crouch ? 0.72 : 1;

    const alive = s.alive === undefined ? true : !!s.alive;
    if (alive !== this.alive) {
      this.alive = alive;
      this.group.visible = alive;
    }

    this.group.visible = alive && !this.confirmedDead && this.latestHp - this.predictedDamage > 0;

    // 이름표는 항상 카메라를 본다
    if (this.nameTag.visible) this.nameTag.quaternion.copy(camera.quaternion);
  }

  dispose() {
    this.scene.remove(this.group);
    // Geometry and texture maps belong to AssetManager and are shared by every
    // avatar. Only this avatar's cloned body materials and name texture are owned here.
    this.body.traverse(o => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    });
    this.nameTag.material.map.dispose();
    this.nameTag.material.dispose();
  }
}

function aimJoint(body, name, childName, target) {
  const joint = body.getObjectByName(name), child = body.getObjectByName(childName);
  if (!joint || !child) return;
  body.updateMatrixWorld(true);
  const origin = joint.getWorldPosition(new THREE.Vector3());
  const current = child.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const wanted = new THREE.Vector3(...target).sub(origin).normalize();
  const world = new THREE.Quaternion().setFromUnitVectors(current, wanted)
    .multiply(joint.getWorldQuaternion(new THREE.Quaternion()));
  joint.quaternion.copy(joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
  body.updateMatrixWorld(true);
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
    map: tex, transparent: true, depthTest: false, sizeAttenuation: true,
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
    this.bots = new Map();
    this.effects = new Effects(scene);
    this.myId = null;
  }

  setMyId(id) { this.myId = id; }

  /** matchStart 로 받은 명단으로 아바타를 만든다 */
  spawnPlayers(list) {
    for (const p of list) {
      if (p.id === this.myId || this.players.has(p.id)) continue;
      this.players.set(p.id, new Avatar(this.scene, this.assets, {
        color: TEAM_COLORS[p.slot % TEAM_COLORS.length], name: p.name, isBot: false, weapon: p.weapon,
      }));
    }
  }

  spawnBots(list) {
    for (const b of list) {
      if (this.bots.has(b.id)) continue;
      const avatar = new Avatar(this.scene, this.assets, { color: BOT_COLOR, name: '적', isBot: true });
      avatar.latestHp = b.hp ?? b.maxHp ?? 100;
      avatar.group.position.set(b.x ?? 0, 0, b.z ?? 0);
      avatar.push(performance.now(), { ...b, x: b.x ?? 0, z: b.z ?? 0, y: 0, yaw: b.yaw ?? 0, alive: true });
      this.bots.set(b.id, avatar);
    }
  }

  /** 서버 스냅샷 반영 */
  onSnapshot(snap) {
    const t = performance.now();
    for (const p of snap.players) {
      if (p.id === this.myId) continue;
      this.players.get(p.id)?.push(t, p);
    }
    for (const b of snap.bots) {
      const avatar = this.bots.get(b.id);
      if (avatar) {
        if (Number.isFinite(b.hp)) avatar.latestHp = b.hp;
        if (!b.alive) avatar.confirmedDead = true;
        avatar.push(t, { ...b, y: 0 });
      }
    }
  }

  shotTargets() {
    return [...this.bots].map(([id, avatar]) => ({
      id, x: avatar.group.position.x, y: avatar.group.position.y, z: avatar.group.position.z,
      alive: avatar.group.visible && !avatar.confirmedDead,
    }));
  }

  applyShotPredictions(pending) {
    for (const [id, avatar] of this.bots) {
      avatar.predictedDamage = pending.reduce((sum, shot) =>
        sum + (shot.prediction?.targetId === id ? shot.prediction.damage : 0), 0);
      avatar.group.visible = avatar.alive && !avatar.confirmedDead &&
        avatar.latestHp - avatar.predictedDamage > 0;
    }
  }

  confirmBotHealth(id, hp) {
    const avatar = this.bots.get(id);
    if (!avatar || !Number.isFinite(hp)) return;
    avatar.latestHp = hp;
    if (hp <= 0) { avatar.confirmedDead = true; avatar.group.visible = false; }
  }

  removePlayer(id) {
    this.players.get(id)?.dispose();
    this.players.delete(id);
  }

  update(dt, camera) {
    // 일부러 과거를 그린다 -> 두 스냅샷 사이가 항상 채워져 부드럽다
    const renderTime = performance.now() - NET.interpDelayMs;
    for (const a of this.players.values()) a.update(renderTime, camera);
    for (const a of this.bots.values()) a.update(renderTime, camera);
    this.effects.update(dt);
  }

  clear() {
    for (const a of this.players.values()) a.dispose();
    for (const a of this.bots.values()) a.dispose();
    this.players.clear();
    this.bots.clear();
    this.effects.clear();
  }
}

/* ========================================================================== *
 *  총격 이펙트 (예광탄 / 탄착 / 총구 화염)
 * ========================================================================== */
class Effects {
  constructor(scene) {
    this.scene = scene;
    this.tracers = [];
    this.sparks = [];

    this.tracerGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
    ]);
    this.tracerMat = new THREE.LineBasicMaterial({
      color: 0xffd27a, transparent: true, opacity: 0.9,
    });
    this.sparkGeo = new THREE.SphereGeometry(0.045, 6, 4);
    this.sparkMat = new THREE.MeshBasicMaterial({ color: 0xffc46a, transparent: true });
  }

  /** 총알 궤적 한 줄 */
  tracer(from, dir, dist) {
    const line = new THREE.Line(this.tracerGeo, this.tracerMat.clone());
    line.position.set(from.x, from.y, from.z);
    line.scale.z = Math.max(0.5, dist);
    // -Z 를 dir 방향으로 돌린다
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
      this.sparks.push({ obj: particle, life: .18,
        velocity: new THREE.Vector3((Math.random() - .5) * 2.8, Math.random() * 2.5, (Math.random() - .5) * 2.8) });
    }
  }

  /** 사격 한 발을 그린다 (from 에서 dir 로 dist 만큼) */
  shot(from, dir, dist) {
    this.tracer(from, dir, dist);
    const end = {
      x: from.x + dir.x * dist,
      y: from.y + dir.y * dist,
      z: from.z + dir.z * dist,
    };
    this.spark(end);
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
  }

  clear() {
    for (const e of [...this.tracers, ...this.sparks]) {
      this.scene.remove(e.obj);
      e.obj.material.dispose();
    }
    this.tracers.length = 0;
    this.sparks.length = 0;
  }
}
