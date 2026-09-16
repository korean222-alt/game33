/* =============================================================================
 *  server/room.js  -  방 한 칸의 상태와 수명
 *
 *  방을 만들고, 대원을 붙이고 떼고, 자리를 비워 두고, 아무도 없으면 치운다.
 *  임무 진행이나 전투 판정은 여기 없다 - 그것들은 이 상태를 인자로 받는다.
 * ========================================================================== */
import { DoorSet, rollDoorStates } from '../public/js/doors.js';
import { resetPower } from '../public/js/power-state.js';
import { TargetHistory } from '../public/js/shot-trace.js';
import { SPAWNS } from '../public/js/map-data.js';
import { startingGrenades } from '../public/js/grenades.js';
import { WEAPONS, PLAYER_MAX_HP, RECONNECT_GRACE_MS } from './constants.js';
import { now } from './util.js';

/** @type {Map<string, Room>} */
export const rooms = new Map();

export class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // socketId -> player
    this.state = 'lobby';       // lobby | briefing | active | won | lost
    this.briefingId = 0;
    this.hostId = null;
    /* 방이 17칸이라 6명이면 너무 헐겁다. 기본을 8명으로 둔다
     * (대기실에서 3~14명으로 바꿀 수 있다). */
    this.botCount = 8;
    this.difficulty = 'normal';
    this.timer = null;
    this.lastTick = now();
    this.seq = 0;
    this.resetMission();
  }

  resetMission() {
    this.doors = new DoorSet(rollDoorStates());
    /* 문 상태를 다음 스냅샷에 실을지 여부.
     *
     *  문 36개를 매 틱 보내면 스냅샷의 3분의 1이 문으로 찬다(1,387 / 4,248 바이트).
     *  최초 상태는 matchStart 가, 변경은 doorState 이벤트가 이미 나르므로 매 틱
     *  실리는 배열은 그 둘과 겹친다. 그래도 아주 없애지는 않고, 바뀐 직후 한 번은
     *  전량을 실어 doorState 를 놓친 클라이언트가 스스로 맞춰지게 둔다.
     *  클라이언트는 snap.doors 가 없는 경우를 이미 처리한다(game.js 의 if).
     *
     *  문 묶음을 통째로 갈아 끼우는 자리에서는 반드시 같이 세워야 한다. */
    this.doorsDirty = true;
    this.npcs = [];
    this.grenades = [];
    this.clouds = [];
    this.sites = [];
    this.evidence = [];
    this.phase = 0;
    resetPower(this);
    this.objectiveDone = new Set();
    this.flags = { breached: false, reinforced: false, hvtSeen: false };
    this.stats = {
      phasesCleared: 0, civiliansRescued: 0, civiliansLost: 0, suspectsArrested: 0,
      suspectsNeutralised: 0, evidenceCollected: 0, devicesDefused: 0,
      hostageSaved: false, hostageLost: false, teamLost: 0, roeViolations: 0,
      objectivesMissed: 0, completed: false,
    };
    this.targetHistory = new TargetHistory();
    this.objectiveSignature = '';
    this.endsAt = 0;
    this.nextGrenadeId = 1;
    this.phaseEnteredAt = 0;
    this.doorQueue = [];
  }

  get alivePlayers() { return [...this.players.values()].filter((p) => p.alive); }
  get standingPlayers() { return [...this.players.values()].filter((p) => p.alive && !p.downed); }
  /** 지금 화면을 보고 있는 대원. 준비/브리핑 확인은 이쪽으로 센다. */
  get connectedPlayers() { return [...this.players.values()].filter((p) => p.connected); }
  /** 자리를 비워 둔 채 복귀를 기다리는 대원. */
  get heldPlayers() { return [...this.players.values()].filter((p) => !p.connected); }
  get suspects() { return this.npcs.filter((n) => n.kind !== 'civilian'); }
  get civilians() { return this.npcs.filter((n) => n.kind === 'civilian'); }

  addPlayer(socket, name, weapon) {
    const idx = this.players.size;
    const spawn = SPAWNS[idx % SPAWNS.length];
    const wk = WEAPONS[weapon] ? weapon : 'rifle';
    const p = {
      /* id 는 게임 안의 신원이고 socketId 는 지금 붙어 있는 연결이다.
       *
       *  둘을 한 값으로 쓰던 동안에는 재접속이 원리상 불가능했다 — 소켓이
       *  바뀌면 id 도 바뀌고, 그러면 다른 화면에 그려져 있던 아바타·킬로그·
       *  체포 기록이 전부 남남이 된다. id 는 첫 접속 때 한 번 정하고 다시는
       *  바뀌지 않는다. 특정 대원에게만 보내는 emit 은 socketId 를 쓴다. */
      id: socket.id,
      socketId: socket.id,
      connected: true,
      disconnectedAt: 0,
      name: (name || '대원').slice(0, 12),
      slot: idx,
      x: spawn.x, y: 0, z: spawn.z,
      yaw: spawn.yaw, pitch: 0,
      hp: PLAYER_MAX_HP,
      alive: true, downed: false, downedAt: 0,
      ready: false,
      weapon: wk,
      ammo: WEAPONS[wk].mag,
      reserve: WEAPONS[wk].reserve,
      reloadUntil: 0,
      lastShot: 0,
      moving: 0, sprint: 0, crouch: 0,
      inputSeq: 0, shotSeq: 0, briefingReady: false,
      defusing: null, interacting: null, interactProgress: 0,
      grenades: startingGrenades(), selectedGrenade: 'flash',
      blindUntil: 0, gas: 0, lastShout: 0,
      doorAction: null,
      kills: 0, arrests: 0, rescues: 0,
      ping: 0,
    };
    this.players.set(socket.id, p);
    if (!this.hostId) this.hostId = socket.id;
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.hostId === id) this.hostId = this.connectedPlayers[0]?.id ?? this.players.keys().next().value ?? null;
  }

  /**
   * 소켓만 떨어뜨리고 대원은 남긴다.
   *
   *  입력이 끊기므로 좌표는 마지막 값에 그대로 멈춘다 — 별도의 고정 코드가
   *  필요 없다. NPC 쪽에서 보면 그 자리에 계속 서 있는 사람이라, 표적으로도
   *  장애물로도 여전히 보인다. HP·탄약·들고 있던 목표는 건드리지 않는다.
   */
  holdPlayer(player) {
    player.connected = false;
    player.disconnectedAt = now();
    player.socketId = null;
    // 끊긴 사람이 방장이면 남아 있는 사람에게 넘긴다. 돌아오면 그냥 대원이다.
    if (this.hostId === player.id) this.hostId = this.connectedPlayers[0]?.id ?? this.hostId;
    // 조작이 멈춘 몸이 달리는 자세로 얼어붙어 있으면 이상하다.
    player.moving = 0; player.sprint = 0;
    player.holdingUse = false;
    player.defusing = null;
    player.interacting = null;
    player.interactProgress = 0;
    player.doorAction = null;
  }

  /** 같은 이름으로 자리를 비워 둔 대원. 방 코드 + 이름이면 충분히 좁혀진다. */
  findHeldByName(name) {
    const key = (name || '대원').slice(0, 12);
    return this.heldPlayers.find((p) => p.name === key) || null;
  }

  /** 유예 시간이 끝난 대원의 id 목록. */
  expiredHolds(t = now()) {
    return this.heldPlayers
      .filter((p) => t - p.disconnectedAt > RECONNECT_GRACE_MS)
      .map((p) => p.id);
  }

  lobbyState() {
    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      botCount: this.botCount,
      difficulty: this.difficulty,
      briefingId: this.briefingId,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, slot: p.slot, ready: p.ready,
        weapon: p.weapon, briefingReady: p.briefingReady,
        connected: p.connected,
        // 남은 유예 시간. 화면에 "45초 안에 복귀 가능" 으로 쓴다.
        holdMs: p.connected ? 0 : Math.max(0, RECONNECT_GRACE_MS - (now() - p.disconnectedAt)),
      })),
    };
  }
}

export function closeRoom(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  rooms.delete(room.code);
}

/**
 * 아무도 안 붙어 있는 방을 치운다.
 *
 *  경기가 끝나면 틱이 멈추므로 유예 청소를 돌려 줄 주체가 없어진다. 5초마다
 *  도는 이 청소기가 그 구멍을 막는다. unref 라서 테스트 프로세스를 붙잡지 않는다.
 */
const roomJanitor = setInterval(() => {
  for (const room of [...rooms.values()]) {
    if (room.state === 'active') continue;    // 틱이 알아서 본다
    for (const id of room.expiredHolds()) room.removePlayer(id);
    if (room.players.size === 0) closeRoom(room);
  }
}, 5000);
roomJanitor.unref?.();
