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
  constructor(scene, assets, { color, name, isBot }) {
    this.scene = scene;
    this.isBot = isBot;
    this.buffer = new InterpBuffer();
    this.alive = true;

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

    this.nameTag = makeNameTag(name, color);
    this.nameTag.position.y = 2.0;
    this.group.add(this.nameTag);

    scene.add(this.group);
  }

  push(t, s) { this.buffer.push(t, s); }

  update(renderTime, camera) {
    const s = this.buffer.sample(renderTime);
    if (!s) return;

    this.group.position.set(s.x, s.y || 0, s.z);
    this.group.rotation.y = s.yaw;
    this.group.scale.y = s.crouch ? 0.72 : 1;

    const alive = s.alive === undefined ? true : !!s.alive;
    if (alive !== this.alive) {
      this.alive = alive;
      this.group.visible = alive;
    }

    // 이름표는 항상 카메라를 본다
    if (this.nameTag.visible) this.nameTag.quaternion.copy(camera.quaternion);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
      }
    });
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
        color: TEAM_COLORS[p.slot % TEAM_COLORS.length], name: p.name, isBot: false,
      }));
    }
  }

  spawnBots(list) {
    for (const b of list) {
      if (this.bots.has(b.id)) continue;
      this.bots.set(b.id, new Avatar(this.scene, this.assets, {
        color: BOT_COLOR, name: '적', isBot: true,
      }));
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
      this.bots.get(b.id)?.push(t, { ...b, y: 0 });
    }
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
