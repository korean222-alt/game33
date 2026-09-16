/* =============================================================================
 *  server/mission.js  -  임무 구성 · 목표 진행 · 종료 · 재접속 유예 정리
 * ========================================================================== */
import {
  BACKUP_GENERATOR, COLLIDERS, SPAWNS, BOMB_SITES, POSTS, CIVILIAN_SPOTS, EVIDENCE_SPOTS,
  HVT_ROOMS, isIndoors, zoneAt, CURRENT_MAP,
} from '../public/js/map-data.js';
import { DoorSet, rollDoorStates, ensureQuietEntry } from '../public/js/doors.js';
import { NOISE, hasClearShot, inFieldOfView } from '../public/js/perception.js';
import {
  createSuspect, createCivilian, planOccupancy, SUSPECT_EYE, SUSPECT_RADIUS,
} from '../public/js/suspect-ai.js';
import { PHASES, phaseText, missionLine } from '../public/js/mission-story.js';
import {
  objectiveState, objectiveReport, phaseComplete, missedObjectives,
} from '../public/js/objectives.js';
import { scoreMission, gradeAdvice } from '../public/js/scoring.js';
import { TargetHistory } from '../public/js/shot-trace.js';
import {
  DIFFICULTY, SUSPECT_MAX_HP, PLAYER_EYE, DEFUSE_SECONDS, DEFUSE_RANGE, outdoorZones,
  REINFORCE_DELAY_MS, REINFORCE_COUNT, RECONNECT_GRACE_MS,
} from './constants.js';
import { now, clamp, dist2D, pick, jitter, emitNoise, npcPublic } from './util.js';
import { closeRoom } from './room.js';
import { tripSprinklerAt } from './events.js';

export function setupMission(room) {
  const random = Math.random;
  const diff = DIFFICULTY[room.difficulty] || DIFFICULTY.normal;

  // 문 상태를 새로 뽑되, 조용히 들어갈 수 있는 진입구는 최소 하나 남긴다.
  room.doors = new DoorSet(ensureQuietEntry(rollDoorStates(random), random));
  room.doorsDirty = true;

  // --- 용의자 배치: 방마다 있을 수도, 없을 수도 ---
  //
  // 시작하자마자 총을 맞으면 플레이어가 배울 것이 없다. 집결 지점을 이미
  // 정면으로 보고 있는 자리는 배치에서 뺀다. 소리를 내거나 시야에 들어가면
  // 그때부터 발견되는 것은 그대로다.
  room.npcs = [];
  const colliders = room.doors.colliders();
  const watchesSpawn = (post) => SPAWNS.some((spawn) =>
    dist2D(post, spawn) < 18
    && inFieldOfView({ x: post.x, z: post.z, yaw: post.yaw ?? 0 }, spawn, Math.PI * 0.78)
    && hasClearShot({ x: post.x, y: SUSPECT_EYE, z: post.z }, { x: spawn.x, y: 0, z: spawn.z }, 1.3, colliders));
  const usablePosts = POSTS.filter((post) => !watchesSpawn(post));
  const plan = planOccupancy(usablePosts, room.botCount, random);
  plan.forEach((entry, i) => {
    const post = jitter(entry.post, random, 1.3, SUSPECT_RADIUS);
    post.yaw = (entry.post.yaw ?? 0) + (random() - 0.5) * 1.2;
    const suspect = createSuspect(`sus_${i}`, {
      post,
      personality: entry.personality,
      hp: Math.round(SUSPECT_MAX_HP * diff.hpMul),
    });
    suspect.origin = outdoorZones().includes(entry.post.room) ? 'outdoor' : 'indoor';
    suspect.morale = clamp(1 * diff.moraleMul, 0.4, 1.2);
    // 시작 직후 전원이 동시에 두리번거리지 않도록 시선 변경 시점을 흩뜨린다.
    suspect.stateUntil = now() + 3500 + random() * 5000;
    room.npcs.push(suspect);
  });

  /* --- 늘 있는 자리 (초소) ---
   *
   *  botCount 와 무관하게 세운다. 인원을 3명으로 줄여 놓고 시작해도 초소는
   *  비어 있지 않다 - 저 둘이 이 맵의 "밖" 을 정의하기 때문이다. 자리도 흔들지
   *  않는다. 발판은 4m 사방이라 1.3m 를 흔들면 난간 속에 들어간다. */
  for (const entry of CURRENT_MAP.GARRISON || []) {
    const guard = createSuspect(entry.id, {
      post: { ...entry.post },
      personality: entry.personality || 'ambusher',
      role: entry.role || null,
      hp: Math.round((entry.hp ?? SUSPECT_MAX_HP) * diff.hpMul),
    });
    guard.origin = outdoorZones().includes(entry.post.room) ? 'outdoor' : 'indoor';
    guard.morale = clamp(1 * diff.moraleMul, 0.4, 1.2);
    guard.stateUntil = now() + 3500 + random() * 5000;
    room.npcs.push(guard);
  }

  // --- 주요 용의자와 인질 ---
  // 방도, 그 방 안의 자리도 매 판 다시 뽑는다. 인질이 어디에 있는지는
  // 문을 열어 보기 전에는 알 수 없어야 한다.
  const hvtRoom = pick(HVT_ROOMS, random);
  const hvtPosts = POSTS.filter((p) => p.room === hvtRoom);
  const basePost = hvtPosts.length ? pick(hvtPosts, random) : POSTS[0];
  const hvtPost = jitter(basePost, random, 1.4, SUSPECT_RADIUS);
  hvtPost.yaw = (basePost.yaw ?? 0) + (random() - 0.5) * 1.6;
  const hvt = createSuspect('hvt', {
    post: hvtPost, personality: 'leader', kind: 'hvt',
    hp: Math.round(140 * diff.hpMul),
  });
  hvt.origin = 'indoor';
  hvt.hostage = 'hostage';
  room.npcs.push(hvt);
  room.hvtRoom = hvtRoom;

  // 인질은 주범과 같은 방의 다른 자리. 그 방에 정해진 자리가 없으면 주범 옆.
  const roomSpots = CIVILIAN_SPOTS.filter((s) => s.room === hvtRoom);
  const hostageBase = roomSpots.length
    ? pick(roomSpots, random)
    : { room: hvtRoom, x: hvtPost.x + (random() - 0.5) * 2, z: hvtPost.z + (random() - 0.5) * 2 };
  const hostageSpot = jitter(hostageBase, random, 0.9);
  const hostage = createCivilian('hostage', hostageSpot);
  hostage.hostage = true;
  hostage.state = 'comply';
  hostage.hands = 1;
  hostage.panic = 0.9;
  room.npcs.push(hostage);

  // --- 나머지 민간인 ---
  // 주범의 방은 비워 둔다. 인질 옆에 다른 민간인이 서 있으면 누구를 구해야
  // 하는지 헷갈린다.
  const spots = CIVILIAN_SPOTS
    .filter((s) => s !== hostageBase && s.room !== hvtRoom)
    .sort(() => random() - 0.5);
  const civilianCount = 2 + Math.floor(random() * 3);
  const usedRooms = new Set();
  for (const spot of spots) {
    if (room.npcs.filter((n) => n.kind === 'civilian' && n.id !== 'hostage').length >= civilianCount) break;
    if (usedRooms.has(spot.room)) continue;    // 한 방에 한 명씩 흩어 놓는다
    usedRooms.add(spot.room);
    room.npcs.push(createCivilian(`civ_${usedRooms.size - 1}`, jitter(spot, random, 1.0)));
  }

  // --- 장치와 증거 ---
  room.sites = BOMB_SITES.map((s) => ({ ...s, progress: 0, defused: false, activeBy: [] }));
  room.evidence = [...EVIDENCE_SPOTS].sort(() => random() - 0.5).slice(0, 3)
    .map((e) => ({ ...jitter(e, random, 0.7, 0.3), taken: false }));

  room.phase = 0;
  room.phaseEnteredAt = now();
  room.objectiveDone = new Set();
  room.targetHistory = new TargetHistory();
  room.targetHistory.record(now(), room.npcs);
}

export function updateObjectives(room, dt, io) {
  // 실내 진입 기록
  if (!room.flags.breached && room.standingPlayers.some((p) => isIndoors(p.x, p.z))) {
    room.flags.breached = true;
  }

  // 폭발물 해체
  for (const site of room.sites) {
    if (site.defused) continue;
    const workers = room.standingPlayers.filter(
      (p) => p.defusing === site.id && dist2D(p, site) <= DEFUSE_RANGE && now() > p.blindUntil,
    );
    const before = site.progress;
    if (workers.length > 0) {
      const rate = (1 / DEFUSE_SECONDS) * (1 + (workers.length - 1) * 0.6);
      site.progress = clamp(site.progress + rate * dt, 0, 1);
    } else if (site.progress > 0) {
      site.progress = clamp(site.progress - 0.3 * dt, 0, 1);
    }
    site.activeBy = workers.map((p) => p.id);

    if (site.progress >= 1) {
      site.defused = true;
      room.stats.devicesDefused++;
      io.to(room.code).emit('siteDefused', { id: site.id, by: site.activeBy });
      io.to(room.code).emit('radio', { text: missionLine(site.id === 'A' ? 'siteA' : 'siteB') });
      emitNoise(room, site.x, site.z, NOISE.defuse, 'defuse', null);
      /* 소각 장치를 끄면 그 방화구역의 스프링클러가 스스로 돈다. 물이 도는
       * 동안은 나도 안 보이니 공짜는 아니다 - 그래서 "끄고 바로 빠진다" 가
       * 이 장치의 값이 된다. (경보기 손잡이를 찾지 못한 판에서도 사옥의
       * 절반짜리 장치가 한 번은 돌아간다.) */
      tripSprinklerAt(room, site.x, site.z, io, '소각 장치 정지');
    }
    if (Math.abs(site.progress - before) > 0.001) {
      io.to(room.code).emit('siteProgress', { id: site.id, progress: site.progress, by: site.activeBy });
    }
  }

  const hvt = room.npcs.find((n) => n.kind === 'hvt');
  // 주요 용의자를 처음 본 순간 무전
  if (!room.flags.hvtSeen && hvt?.alive) {
    const colliders = room.doors.colliders();
    if (room.standingPlayers.some((p) =>
      dist2D(p, hvt) < 14 && hasClearShot({ x: p.x, y: p.y + PLAYER_EYE, z: p.z }, hvt, 1.3, colliders))) {
      room.flags.hvtSeen = true;
      io.to(room.code).emit('radio', { text: missionLine('hvtFound') });
    }
  }
  // 주요 용의자가 제압되면 인질이 풀려난다 (사살·체포·항복 모두)
  if (hvt && (!hvt.alive || hvt.arrested || hvt.state === 'surrender')) {
    const hostage = room.npcs.find((n) => n.id === 'hostage');
    if (hostage?.hostage) {
      hostage.hostage = false;
      hostage.state = 'comply';
      hostage.hands = 1;
      io.to(room.code).emit('radio', { text: missionLine('hvtDown') });
    }
  }

  /* 마지막 한둘을 못 찾아 단계가 멎었다.
   *
   *  objectives.js 가 시한(STALL_MS)으로 판정하고, 여기서는 그 사실을 한 번만
   *  말해 준다. 아무 설명 없이 목표에 체크가 들어가면 화면이 고장 난 것처럼
   *  보인다 - 실제로 그게 이 장치의 유일한 위험이다. */
  if (!room.flags.scattered
      && PHASES[room.phase].require.some((id) => objectiveState(room, id).stalled)) {
    room.flags.scattered = true;
    io.to(room.code).emit('radio', { text: missionLine('scattered') });
  }

  // 단계 진행
  if (phaseComplete(room)) {
    room.stats.phasesCleared = room.phase + 1;
    if (room.phase === PHASES.length - 1) {
      room.stats.completed = true;
      finishMatch(room, 'won', io);
      return;
    }
    room.phase++;
    room.phaseEnteredAt = now();
    room.flags.scattered = false;     // 단계마다 다시 한 번은 말해 준다
    const next = phaseText(PHASES[room.phase]);
    io.to(room.code).emit('phase', objectiveReport(room));
    io.to(room.code).emit('radio', { text: next.radio });
    // Power follows entry time, never phase transitions (including after restoration).
  }

  // 마지막 단계에서 증원 병력이 들어온다
  if (PHASES[room.phase].id === 'extract' && !room.flags.reinforced
      && now() - room.phaseEnteredAt > REINFORCE_DELAY_MS) {
    room.flags.reinforced = true;
    spawnReinforcements(room, io);
  }

  broadcastObjectives(room, io);
}

/**
 * 미션표 갱신.
 *
 * 예전에는 단계가 "통째로" 끝날 때만 목표 목록을 보냈다. 그래서 외곽 경비를
 * 다 잡아도 화면의 "0/2" 가 그대로 남아 있었고, 플레이어는 자기가 한 일이
 * 반영되지 않는다고 느꼈다. 목표 하나가 바뀔 때마다 보낸다.
 *
 * 매 틱 보내면 낭비이므로 내용이 실제로 달라졌을 때만 보낸다.
 */
export function broadcastObjectives(room, io) {
  const report = objectiveReport(room);
  const signature = JSON.stringify(report.list) + report.phase;
  if (signature === room.objectiveSignature) return;
  room.objectiveSignature = signature;
  io.to(room.code).emit('objectives', report);
}

/*
 * 정전.
 *
 * 저택 쪽에서 두꺼비집을 내린다. 실내등이 전부 꺼지고, 그때부터 안에서는
 * 서로가 잘 안 보인다 - 적도 나를 늦게 발견하고, 나도 적을 늦게 본다.
 * 손전등(L)을 켜면 보이지만, 켠 사람은 어둠 속에서 훨씬 먼저 눈에 띈다.
 */
export function cutPower(room, io) {
  if (!room.power) return;
  room.power = false;
  io.to(room.code).emit('power', { on: false });
  io.to(room.code).emit('radio', { text: missionLine('powerCut') });
  // 불이 꺼지는 순간 모두가 움찔한다. 소리가 아니라 상태 변화로 전한다.
  for (const npc of room.npcs) {
    if (!npc.alive || npc.kind === 'civilian') continue;
    npc.morale = Math.max(0, npc.morale - 0.05);
  }
}

export function spawnReinforcements(room, io) {
  const diff = DIFFICULTY[room.difficulty] || DIFFICULTY.normal;
  const gate = [{ x: -2.4, z: 40.6 }, { x: 2.4, z: 40.6 }, { x: 0, z: 38.6 }];
  const created = [];
  for (let i = 0; i < REINFORCE_COUNT; i++) {
    const spot = gate[i % gate.length];
    const suspect = createSuspect(`rf_${i}`, {
      // 구역 이름은 좌표에서 뽑는다. 저택의 'COURTYARD' 를 박아 두면 사무실에서는
      // 있지도 않은 구역이 되고, 엄폐·순찰이 그 이름으로 아무것도 못 찾는다.
      post: { x: spot.x, z: spot.z, yaw: Math.PI, room: zoneAt(spot.x, spot.z) },
      personality: 'aggressive',
      hp: Math.round(SUSPECT_MAX_HP * diff.hpMul),
    });
    suspect.origin = 'outdoor';
    suspect.reinforcement = true;
    suspect.state = 'investigate';
    suspect.stateUntil = now() + 60000;
    suspect.lastHeard = { x: 0, z: 18, t: now(), level: 1, type: 'contact' };
    room.npcs.push(suspect);
    created.push(suspect);
  }
  io.to(room.code).emit('npcsJoined', { npcs: created.map(npcPublic) });
  io.to(room.code).emit('radio', { text: missionLine('reinforcements') });
}

export function checkMissionEnd(room, io) {
  if (room.state !== 'active') return;
  if (room.players.size > 0 && room.alivePlayers.length === 0) finishMatch(room, 'lost', io);
}

/** 자리를 비워 둔다고 팀에게 알린다. 남은 초까지 줘야 기다릴지 말지 정할 수 있다. */
export function announceHold(room, player, io) {
  const seconds = Math.round(RECONNECT_GRACE_MS / 1000);
  io.to(room.code).emit('playerHeld', { id: player.id, name: player.name, seconds });
  io.to(room.code).emit('radio', { text: `무전: ${player.name} 통신 두절 — ${seconds}초 안에 복귀 가능` });
  io.to(room.code).emit('lobby', room.lobbyState());
}

/**
 * 유예 시간이 끝난 자리를 정리한다.
 *
 *  여기까지 와야 비로소 기존 흐름(removePlayer + checkMissionEnd)을 탄다.
 *  방을 지우는 것도 여기서만 한다 — "비워 둔 대원만 남은 방" 을 지워 버리면
 *  유예 시간 자체가 무의미해진다.
 */
export function dropExpiredHolds(room, io) {
  const gone = room.expiredHolds();
  if (!gone.length) return false;
  for (const id of gone) {
    const player = room.players.get(id);
    room.removePlayer(id);
    io.to(room.code).emit('playerLeft', { id });
    if (player) io.to(room.code).emit('radio', { text: `무전: ${player.name} 복귀 실패 — 명단에서 제외한다.` });
  }
  io.to(room.code).emit('lobby', room.lobbyState());
  if (room.players.size === 0) {
    closeRoom(room);
    return true;
  }
  checkMissionEnd(room, io);
  return true;
}

export function finishMatch(room, result, io) {
  if (room.state !== 'active') return;
  room.state = result;
  if (room.timer) { clearInterval(room.timer); room.timer = null; }

  room.stats.objectivesMissed = missedObjectives(room);
  room.stats.teamLost = [...room.players.values()].filter((p) => !p.alive).length;
  const hostage = room.npcs.find((n) => n.id === 'hostage');
  if (hostage?.alive) room.stats.hostageSaved = true;
  if (result === 'won') room.stats.completed = true;

  const score = scoreMission(room.stats);
  io.to(room.code).emit('matchEnd', {
    result,
    reason: result === 'won' ? '작전 목표 전부 달성 · 철수 완료'
      : (room.alivePlayers.length === 0 ? '팀 전멸' : '제한 시간 초과'),
    grade: score.grade,
    gradeLabel: score.gradeLabel,
    score: score.total,
    lines: score.lines,
    advice: gradeAdvice(score, room.stats),
    stats: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, kills: p.kills, arrests: p.arrests,
      rescues: p.rescues, alive: p.alive && !p.downed,
    })),
    sites: room.sites.map((s) => ({ id: s.id, defused: s.defused })),
  });
}
