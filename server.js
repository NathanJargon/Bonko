const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const ROOM_SIZE_MIN = 5;
const ROOM_SIZE_MAX = 10;
const WORLD_WIDTH = 2200;
const WORLD_HEIGHT = 1400;
const ROUND_TIME_MS = 3 * 60 * 1000;
const TICK_MS = 50;
const PLAYER_SPEED = 410;
const PLAYER_RADIUS = 20;
const INTERACT_RADIUS = 42;
const CHAT_LIMIT = 12;
const TAG_DISTANCE = 52;
const TAG_COOLDOWN_MS = 8000;
const NOTE_TARGET = 8;
const NOTE_COOLDOWN_MS = 14000;
const NOTE_VALUE = 1;
const SHADOW_DASH_MS = 1400;
const SHADOW_DASH_COOLDOWN_MS = 7000;
const SHADOW_MARK_RANGE = 200;
const SHADOW_MARK_MS = 3600;
const SHADOW_MARK_COOLDOWN_MS = 11000;
const MODE_CONFIGS = {
  classic: {
    label: "Classic",
    pace: 1,
    botCount: 0,
    roundTimeMs: ROUND_TIME_MS,
    taskCount: 8,
  },
  practice: {
    label: "Practice",
    pace: 1.02,
    botCount: 4,
    roundTimeMs: ROUND_TIME_MS,
    taskCount: 8,
  },
  chaos: {
    label: "Chaos",
    pace: 1.12,
    botCount: 6,
    roundTimeMs: 2.5 * 60 * 1000,
    taskCount: 10,
  },
};
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function normalizeMode(value) {
  const nextMode = String(value || "classic").toLowerCase();
  return MODE_CONFIGS[nextMode] ? nextMode : "classic";
}

function getModeConfig(mode) {
  return MODE_CONFIGS[normalizeMode(mode)];
}

function normalizeBotCount(value, mode) {
  const fallback = getModeConfig(mode).botCount;
  const nextCount = Number.parseInt(value, 10);
  if (!Number.isFinite(nextCount)) {
    return fallback;
  }

  return Math.max(0, Math.min(8, nextCount));
}

function parseAllowedOrigins(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ORIGIN);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Socket.IO CORS blocked this origin."));
    },
    credentials: true,
  },
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "public", "app")));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/socket.io")) {
    next();
    return;
  }

  const appIndex = path.join(__dirname, "public", "app", "index.html");
  res.sendFile(appIndex, (err) => {
    if (err) {
      next();
    }
  });
});

const rooms = new Map();

function randomId(size = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function randomSpawn() {
  return {
    x: Math.round(120 + Math.random() * (WORLD_WIDTH - 240)),
    y: Math.round(120 + Math.random() * (WORLD_HEIGHT - 240)),
  };
}

function randomNoteCode(length = 5) {
  const chars = "ASDW";
  let out = "";

  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

function createTask(id, index = 0) {
  return {
    id,
    ...randomSpawn(),
    kind: "note",
    label: "Hidden Note",
    taskKind: "note",
    code: randomNoteCode(5),
    r: 22,
    value: NOTE_VALUE,
    cooldownMs: NOTE_COOLDOWN_MS,
    availableAt: 0,
  };
}

function createWalls() {
  return [
    { id: "w1", x: 400, y: 250, w: 1220, h: 34 },
    { id: "w2", x: 410, y: 1110, w: 1220, h: 34 },
    { id: "w3", x: 510, y: 420, w: 34, h: 360 },
    { id: "w4", x: 1656, y: 420, w: 34, h: 360 },
    { id: "w5", x: 250, y: 720, w: 320, h: 34 },
    { id: "w6", x: 1630, y: 720, w: 320, h: 34 },
  ];
}

function createInteractables() {
  return [
    { id: "i1", kind: "boost", label: "Boost Pad", x: 470, y: 950, r: 26, cooldownMs: 12000, availableAt: 0 },
    { id: "i2", kind: "boost", label: "Boost Pad", x: 1730, y: 460, r: 26, cooldownMs: 12000, availableAt: 0 },
    { id: "i3", kind: "cache", label: "Supply Cache", x: 1050, y: 650, r: 28, cooldownMs: 15000, availableAt: 0 },
    { id: "i4", kind: "cache", label: "Supply Cache", x: 340, y: 350, r: 28, cooldownMs: 15000, availableAt: 0 },
  ];
}

function createTasks(count) {
  return Array.from({ length: count }, (_, index) => createTask(`t${index}`, index));
}

function createNoteMessage(player, note) {
  return `${player.name} found a hidden note.`;
}

function sanitizeNoteCode(code) {
  return String(code || "").replace(/[^ASDW]/gi, "").toUpperCase().slice(0, 8);
}

function normalizeWalls(walls) {
  return walls.map((wall) => ({
    id: wall.id,
    x: wall.x,
    y: wall.y,
    w: wall.w,
    h: wall.h,
  }));
}

function normalizeInteractables(interactables, now = Date.now()) {
  return interactables.map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.label,
    x: item.x,
    y: item.y,
    r: item.r,
    available: now >= item.availableAt,
  }));
}

function normalizeTasks(tasks, now = Date.now()) {
  return tasks.map((task) => ({
    id: task.id,
    kind: task.kind,
    taskKind: task.taskKind,
    label: task.label,
    code: task.code,
    x: task.x,
    y: task.y,
    r: task.r,
    available: now >= task.availableAt,
  }));
}

function normalizeShadowState(player, now = Date.now()) {
  return {
    shadowDashUntil: player.shadowDashUntil || 0,
    shadowDashCooldownUntil: player.shadowDashCooldownUntil || 0,
    shadowMarkCooldownUntil: player.shadowMarkCooldownUntil || 0,
    slowedUntil: player.slowedUntil || 0,
    revealedUntil: player.revealedUntil || 0,
    shadowMarkedUntil: player.shadowMarkedUntil || 0,
    shadowMarkedBy: player.shadowMarkedBy || null,
    dashReady: now >= (player.shadowDashCooldownUntil || 0),
    markReady: now >= (player.shadowMarkCooldownUntil || 0),
  };
}

function createChatEntry(player, text) {
  return {
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    authorId: player.id,
    author: player.name,
    text,
    ts: Date.now(),
    bot: Boolean(player.bot),
  };
}

function sanitizeChat(text) {
  return String(text || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
}

function makeRoom(code) {
  return {
    code,
    hostId: null,
    status: "lobby",
    mode: "classic",
    botCount: 0,
    players: new Map(),
    score: 0,
    winner: null,
    startedAt: null,
    endsAt: null,
    ticker: null,
    tasks: [],
    walls: createWalls(),
    interactables: createInteractables(),
    chat: [],
    reason: "",
  };
}

function resolveWallCollision(player, walls) {
  for (const wall of walls) {
    const left = wall.x - PLAYER_RADIUS;
    const right = wall.x + wall.w + PLAYER_RADIUS;
    const top = wall.y - PLAYER_RADIUS;
    const bottom = wall.y + wall.h + PLAYER_RADIUS;

    if (player.x < left || player.x > right || player.y < top || player.y > bottom) {
      continue;
    }

    const overlapLeft = player.x - left;
    const overlapRight = right - player.x;
    const overlapTop = player.y - top;
    const overlapBottom = bottom - player.y;
    const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

    if (minOverlap === overlapLeft) {
      player.x = left;
    } else if (minOverlap === overlapRight) {
      player.x = right;
    } else if (minOverlap === overlapTop) {
      player.y = top;
    } else {
      player.y = bottom;
    }
  }
}

function getNearestInteractable(room, player) {
  let nearest = null;

  for (const item of [...room.tasks, ...room.interactables]) {
    if (Date.now() < item.availableAt) {
      continue;
    }

    const dx = player.x - item.x;
    const dy = player.y - item.y;
    const distance = Math.hypot(dx, dy);
    if (distance > INTERACT_RADIUS + item.r) {
      continue;
    }

    if (!nearest || distance < nearest.distance) {
      nearest = { item, distance };
    }
  }

  return nearest?.item ?? null;
}

function applyInteractableEffect(room, player, item, now = Date.now()) {
  item.availableAt = now + (item.cooldownMs || 0);

  if (item.kind === "note") {
    return createNoteMessage(player, item);
  }

  if (item.kind === "boost") {
    player.speedBoostUntil = now + 5000;
    return `${player.name} hit a boost pad.`;
  }

  if (item.kind === "cache") {
    if (player.role === "crew") {
      room.score += 2;
    }

    player.speedBoostUntil = now + 2500;
    return `${player.name} looted a supply cache.`;
  }

  return `${player.name} interacted.`;
}

function sanitizeName(name) {
  const cleaned = String(name || "Pilot").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
  return cleaned.slice(0, 16) || "Pilot";
}

function isBotPlayer(player) {
  return Boolean(player?.bot);
}

function createBot(room, index) {
  return {
    id: `bot-${room.code}-${index}-${randomId(3)}`,
    name: `Bot ${index + 1}`,
    ...randomSpawn(),
    vx: 0,
    vy: 0,
    role: "crew",
    alive: true,
    cooldownUntil: 0,
    speedBoostUntil: 0,
    shadowDashUntil: 0,
    shadowDashCooldownUntil: 0,
    shadowMarkCooldownUntil: 0,
    slowedUntil: 0,
    revealedUntil: 0,
    bot: true,
  };
}

function desiredBotCount(room) {
  if (room.mode === "classic") {
    return 0;
  }

  const config = getModeConfig(room.mode);
  return room.botCount > 0 ? room.botCount : config.botCount;
}

function syncBots(room) {
  const targetCount = desiredBotCount(room);
  const bots = [...room.players.values()].filter(isBotPlayer);

  while (bots.length < targetCount) {
    const bot = createBot(room, bots.length);
    room.players.set(bot.id, bot);
    bots.push(bot);
  }

  while (bots.length > targetCount) {
    const bot = bots.pop();
    room.players.delete(bot.id);
  }
}

function getHumanPlayers(room) {
  return [...room.players.values()].filter((player) => !isBotPlayer(player));
}

function pickShadowPlayer(room, players) {
  const humanPlayers = players.filter((player) => !isBotPlayer(player));
  const candidates = room.mode === "classic" || humanPlayers.length === 0 ? players : humanPlayers;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function steerToward(source, targetX, targetY, speedMultiplier = 1) {
  const dx = targetX - source.x;
  const dy = targetY - source.y;
  const distance = Math.hypot(dx, dy) || 1;
  source.vx = (dx / distance) * speedMultiplier;
  source.vy = (dy / distance) * speedMultiplier;
}

function steerWithWobble(source, targetX, targetY, speedMultiplier, wobble = 0.12) {
  const angle = Math.atan2(targetY - source.y, targetX - source.x);
  const offset = (Math.sin(Date.now() / 500 + source.x * 0.01 + source.y * 0.01) * wobble);
  source.vx = Math.cos(angle + offset) * speedMultiplier;
  source.vy = Math.sin(angle + offset) * speedMultiplier;
}

function triggerShadowDash(shadow, now = Date.now()) {
  shadow.speedBoostUntil = now + SHADOW_DASH_MS;
  shadow.shadowDashUntil = now + SHADOW_DASH_MS;
  shadow.shadowDashCooldownUntil = now + SHADOW_DASH_COOLDOWN_MS;
}

function triggerShadowMark(room, shadow, now = Date.now()) {
  let marked = null;

  for (const player of room.players.values()) {
    if (player.role !== "crew" || !player.alive) {
      continue;
    }

    const dx = player.x - shadow.x;
    const dy = player.y - shadow.y;
    if (dx * dx + dy * dy > SHADOW_MARK_RANGE * SHADOW_MARK_RANGE) {
      continue;
    }

    if (!marked) {
      marked = player;
    }

    player.slowedUntil = now + SHADOW_MARK_MS;
    player.revealedUntil = now + SHADOW_MARK_MS;
  }

  if (marked) {
    shadow.shadowMarkCooldownUntil = now + SHADOW_MARK_COOLDOWN_MS;
    room.chat.push(createChatEntry({ id: "system", name: "System" }, `${shadow.name} marked ${marked.name}.`));
    room.chat = room.chat.slice(-CHAT_LIMIT);
    return true;
  }

  return false;
}

function maybeUseShadowSkill(room, shadow, now = Date.now()) {
  const nearestCrew = [...room.players.values()]
    .filter((player) => player.role === "crew" && player.alive)
    .reduce((best, player) => {
      const dx = player.x - shadow.x;
      const dy = player.y - shadow.y;
      const distance = dx * dx + dy * dy;
      if (best === null || distance < best.distance) {
        return { distance, player };
      }
      return best;
    }, null);

  if (!nearestCrew) {
    return;
  }

  if (now >= shadow.shadowMarkCooldownUntil && nearestCrew.distance <= 320 * 320 && Math.random() > 0.35) {
    triggerShadowMark(room, shadow, now);
  }

  if (now >= shadow.shadowDashCooldownUntil && nearestCrew.distance > 120 * 120 && nearestCrew.distance < 600 * 600 && Math.random() > 0.55) {
    triggerShadowDash(shadow, now);
  }
}

function updateBotBrain(room, bot) {
  const modeConfig = getModeConfig(room.mode);
  const botSpeed = modeConfig.pace * 0.6;

  if (!bot.alive) {
    bot.vx = 0;
    bot.vy = 0;
    return;
  }

  if (room.status !== "active") {
    bot.vx = 0;
    bot.vy = 0;
    return;
  }

  if (bot.role === "shadow") {
    maybeUseShadowSkill(room, bot, Date.now());

    const nearestCrew = [...room.players.values()]
      .filter((player) => player.role === "crew" && player.alive && !isBotPlayer(player))
      .reduce((best, player) => {
        const dx = player.x - bot.x;
        const dy = player.y - bot.y;
        const distance = dx * dx + dy * dy;
        if (best === null || distance < best.distance) {
          return { distance, player };
        }
        return best;
      }, null);

    if (nearestCrew && nearestCrew.distance < 260 * 260 && Math.random() > 0.3) {
      steerWithWobble(bot, nearestCrew.player.x, nearestCrew.player.y, botSpeed * 1.1, 0.22);
      return;
    }

    const wanderAngle = ((Date.now() / 650) + bot.x + bot.y) % (Math.PI * 2);
    bot.vx = Math.cos(wanderAngle) * botSpeed * 0.75;
    bot.vy = Math.sin(wanderAngle) * botSpeed * 0.75;
    return;
  }

  const nearestTask = room.tasks.reduce(
    (best, task) => {
      if (Date.now() < task.availableAt) {
        return best;
      }

      const dx = task.x - bot.x;
      const dy = task.y - bot.y;
      const distance = dx * dx + dy * dy;
      if (best === null || distance < best.distance) {
        return { distance, task };
      }
      return best;
    },
    null,
  );

  if (nearestTask && nearestTask.distance < 420 * 420 && Math.random() > 0.45) {
    steerWithWobble(bot, nearestTask.task.x, nearestTask.task.y, botSpeed * 0.85, 0.18);
    return;
  }

  if (Math.random() > 0.5) {
    bot.vx = 0;
    bot.vy = 0;
    return;
  }

  const wanderAngle = ((Date.now() / 520) + bot.x + bot.y) % (Math.PI * 2);
  bot.vx = Math.cos(wanderAngle) * botSpeed * 0.7;
  bot.vy = Math.sin(wanderAngle) * botSpeed * 0.7;
}

function roomSnapshot(room, requesterId) {
  const now = Date.now();
  const players = [...room.players.values()].map((p) => {
    const base = {
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      roleKnown: p.id === requesterId || requesterId === room.hostId,
      alive: p.alive,
      isHost: p.id === room.hostId,
      isShadow: p.role === "shadow",
      cooldownUntil: p.cooldownUntil,
      speedBoostUntil: p.speedBoostUntil,
      ...normalizeShadowState(p, now),
      bot: isBotPlayer(p),
    };

    if (!base.roleKnown && p.role === "shadow") {
      base.isShadow = false;
    }

    return base;
  });

  return {
    title: "Bonko",
    room: room.code,
    mode: room.mode,
    modeLabel: getModeConfig(room.mode).label,
    pace: getModeConfig(room.mode).pace,
    botCount: desiredBotCount(room),
    minRecommended: ROOM_SIZE_MIN,
    maxAllowed: ROOM_SIZE_MAX,
    noteTarget: NOTE_TARGET,
    status: room.status,
    score: room.score,
    winner: room.winner,
    reason: room.reason,
    startsAt: room.startedAt,
    endsAt: room.endsAt,
    now,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    tasks: normalizeTasks(room.tasks),
    notes: normalizeTasks(room.tasks),
    walls: normalizeWalls(room.walls),
    interactables: normalizeInteractables(room.interactables),
    chat: room.chat,
    players,
  };
}

function broadcastRoom(room) {
  for (const player of room.players.values()) {
    io.to(player.id).emit("room:update", roomSnapshot(room, player.id));
  }
}

function stopGame(room, winner, reason) {
  room.status = "ended";
  room.winner = winner;
  room.reason = reason;
  if (room.ticker) {
    clearInterval(room.ticker);
    room.ticker = null;
  }
  broadcastRoom(room);
}

function resetLobby(room) {
  room.status = "lobby";
  room.score = 0;
  room.winner = null;
  room.reason = "";
  room.startedAt = null;
  room.endsAt = null;
  room.tasks = createTasks(getModeConfig(room.mode).taskCount);
  room.interactables = createInteractables();
  room.chat = room.chat.slice(-CHAT_LIMIT);
  syncBots(room);

  for (const player of room.players.values()) {
    const spawn = randomSpawn();
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.alive = true;
    player.role = "crew";
    player.cooldownUntil = 0;
    player.speedBoostUntil = 0;
    player.shadowDashUntil = 0;
    player.shadowDashCooldownUntil = 0;
    player.shadowMarkCooldownUntil = 0;
    player.slowedUntil = 0;
    player.revealedUntil = 0;
  }

  broadcastRoom(room);
}

function startRound(room) {
  if (room.status === "active") {
    return;
  }

  syncBots(room);

  const humanCount = getHumanPlayers(room).length;
  if (room.mode === "classic" && humanCount < 3) {
    return;
  }

  if (room.mode !== "classic" && humanCount < 1) {
    return;
  }

  const modeConfig = getModeConfig(room.mode);
  const players = [...room.players.values()];
  room.status = "active";
  room.score = 0;
  room.winner = null;
  room.reason = "";
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + modeConfig.roundTimeMs;
  room.tasks = createTasks(modeConfig.taskCount);

  const shadowPlayer = pickShadowPlayer(room, players);
  players.forEach((player, i) => {
    player.role = player === shadowPlayer ? "shadow" : "crew";
    player.alive = true;
    player.cooldownUntil = 0;
    player.speedBoostUntil = 0;
    player.shadowDashUntil = 0;
    player.shadowDashCooldownUntil = 0;
    player.shadowMarkCooldownUntil = 0;
    player.slowedUntil = 0;
    player.revealedUntil = 0;
    const spawn = randomSpawn();
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
  });

  if (room.ticker) {
    clearInterval(room.ticker);
  }

  room.ticker = setInterval(() => {
    if (room.status !== "active") {
      return;
    }

    const now = Date.now();
    const delta = TICK_MS / 1000;
    const speed = PLAYER_SPEED * getModeConfig(room.mode).pace;

    for (const bot of room.players.values()) {
      if (isBotPlayer(bot)) {
        updateBotBrain(room, bot);
      }
    }

    for (const player of room.players.values()) {
      if (!player.alive) {
        continue;
      }

      const boostMultiplier = player.speedBoostUntil && player.speedBoostUntil > now ? 1.35 : 1;
      const shadowDashMultiplier = player.role === "shadow" && player.shadowDashUntil && player.shadowDashUntil > now ? 1.5 : 1;
      const slowMultiplier = player.slowedUntil && player.slowedUntil > now ? 0.72 : 1;
      player.x += player.vx * speed * boostMultiplier * shadowDashMultiplier * slowMultiplier * delta;
      player.y += player.vy * speed * boostMultiplier * shadowDashMultiplier * slowMultiplier * delta;
      resolveWallCollision(player, room.walls);
      player.x = Math.max(20, Math.min(WORLD_WIDTH - 20, player.x));
      player.y = Math.max(20, Math.min(WORLD_HEIGHT - 20, player.y));
    }

    if (room.tasks.length < modeConfig.taskCount) {
      while (room.tasks.length < modeConfig.taskCount) {
        room.tasks.push(createTask(`t${Date.now()}${Math.floor(Math.random() * 999)}`, room.tasks.length));
      }
    }

    if (room.score >= NOTE_TARGET) {
      stopGame(room, "crew", "Crew collected enough hidden notes.");
      return;
    }

    const aliveCrew = [...room.players.values()].filter((p) => p.role === "crew" && p.alive).length;
    if (aliveCrew === 0) {
      stopGame(room, "shadow", "Shadow neutralized the whole crew.");
      return;
    }

    if (now >= room.endsAt) {
      stopGame(room, "crew", "Crew survived the timer.");
      return;
    }

    broadcastRoom(room);
  }, TICK_MS);

  broadcastRoom(room);
}

function removePlayer(socketId) {
  for (const room of rooms.values()) {
    if (!room.players.has(socketId)) {
      continue;
    }

    const wasHost = room.hostId === socketId;
    room.players.delete(socketId);

    if (room.players.size === 0 || getHumanPlayers(room).length === 0) {
      if (room.ticker) {
        clearInterval(room.ticker);
      }
      rooms.delete(room.code);
      return;
    }

    if (wasHost) {
      const nextHost = getHumanPlayers(room)[0] || [...room.players.values()][0];
      room.hostId = nextHost?.id || null;
    }

    if (room.status === "active") {
      const aliveCrew = [...room.players.values()].filter((p) => p.role === "crew" && p.alive).length;
      const hasShadow = [...room.players.values()].some((p) => p.role === "shadow" && p.alive);

      if (!hasShadow) {
        stopGame(room, "crew", "Shadow left the arena.");
      } else if (aliveCrew === 0) {
        stopGame(room, "shadow", "Crew has no survivors.");
      } else {
        broadcastRoom(room);
      }
    } else {
      broadcastRoom(room);
    }

    return;
  }
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, mode, botCount }) => {
    const code = randomId();
    const room = makeRoom(code);
    rooms.set(code, room);

    room.hostId = socket.id;
    const spawn = randomSpawn();
    room.players.set(socket.id, {
      id: socket.id,
      name: sanitizeName(name),
      ...spawn,
      vx: 0,
      vy: 0,
      role: "crew",
      alive: true,
      cooldownUntil: 0,
      speedBoostUntil: 0,
    });

    room.mode = normalizeMode(mode);
    room.botCount = room.mode === "classic" ? 0 : normalizeBotCount(botCount, room.mode);
    room.tasks = createTasks(getModeConfig(room.mode).taskCount);
    syncBots(room);

    socket.join(code);
    socket.emit("room:joined", { room: code, isHost: true });
    broadcastRoom(room);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) {
      socket.emit("error:message", "Room not found.");
      return;
    }

    if (room.players.size >= ROOM_SIZE_MAX) {
      socket.emit("error:message", "Room is full.");
      return;
    }

    const spawn = randomSpawn();
    room.players.set(socket.id, {
      id: socket.id,
      name: sanitizeName(name),
      ...spawn,
      vx: 0,
      vy: 0,
      role: "crew",
      alive: true,
      cooldownUntil: 0,
      speedBoostUntil: 0,
    });

    socket.join(room.code);
    socket.emit("room:joined", { room: room.code, isHost: false });
    broadcastRoom(room);
  });

  socket.on("room:settings", ({ roomCode, mode, botCount }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room || room.hostId !== socket.id || room.status !== "lobby") {
      return;
    }

    room.mode = normalizeMode(mode);
    room.botCount = room.mode === "classic" ? 0 : normalizeBotCount(botCount, room.mode);
    room.tasks = createTasks(getModeConfig(room.mode).taskCount);
    syncBots(room);
    broadcastRoom(room);
  });

  socket.on("round:start", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room || room.hostId !== socket.id) {
      return;
    }
    startRound(room);
  });

  socket.on("round:reset", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room || room.hostId !== socket.id) {
      return;
    }
    resetLobby(room);
  });

  socket.on("room:leave", () => {
    removePlayer(socket.id);
  });

  socket.on("player:move", ({ roomCode, vx, vy }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player || !player.alive) {
      return;
    }

    const nextVx = Number(vx);
    const nextVy = Number(vy);
    const mag = Math.hypot(nextVx, nextVy);
    if (!Number.isFinite(mag) || mag > 2) {
      return;
    }

    if (mag > 1) {
      player.vx = nextVx / mag;
      player.vy = nextVy / mag;
      return;
    }

    player.vx = nextVx;
    player.vy = nextVy;
  });

  socket.on("player:interact", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room || room.status === "lobby") {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player || !player.alive) {
      return;
    }

    const item = getNearestInteractable(room, player);
    if (!item) {
      socket.emit("error:message", "Nothing to interact with.");
      return;
    }

    const now = Date.now();
    const message = applyInteractableEffect(room, player, item, now);
    room.chat.push(createChatEntry({ id: "system", name: "System" }, message));
    room.chat = room.chat.slice(-CHAT_LIMIT);
    broadcastRoom(room);
  });

  socket.on("note:submit", ({ roomCode, noteId, code }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room || room.status !== "active") {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player || !player.alive) {
      return;
    }

    const note = room.tasks.find((item) => item.id === noteId);
    if (!note || Date.now() < note.availableAt) {
      socket.emit("error:message", "That note is not available.");
      return;
    }

    const dx = player.x - note.x;
    const dy = player.y - note.y;
    const distance = Math.hypot(dx, dy);
    if (distance > INTERACT_RADIUS + note.r) {
      socket.emit("error:message", "Move closer to the note.");
      return;
    }

    const typed = sanitizeNoteCode(code);
    if (typed !== note.code) {
      socket.emit("error:message", "Wrong note code.");
      return;
    }

    room.score += note.value;
    note.availableAt = Date.now() + note.cooldownMs;
    room.chat.push(createChatEntry({ id: "system", name: "System" }, `${player.name} decoded a hidden note.`));
    room.chat = room.chat.slice(-CHAT_LIMIT);
    broadcastRoom(room);
  });

  socket.on("chat:send", ({ roomCode, text }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return;
    }

    const cleaned = sanitizeChat(text);
    if (!cleaned) {
      return;
    }

    room.chat.push(createChatEntry(player, cleaned));
    room.chat = room.chat.slice(-CHAT_LIMIT);
    broadcastRoom(room);
  });

  socket.on("player:tag", ({ roomCode }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room || room.status !== "active") {
      return;
    }

    const attacker = room.players.get(socket.id);
    if (!attacker || !attacker.alive || attacker.role !== "shadow") {
      return;
    }

    const now = Date.now();
    if (attacker.cooldownUntil > now) {
      return;
    }

    let tagged = false;
    for (const target of room.players.values()) {
      if (!target.alive || target.role !== "crew") {
        continue;
      }
      const dx = attacker.x - target.x;
      const dy = attacker.y - target.y;
      if (dx * dx + dy * dy <= TAG_DISTANCE * TAG_DISTANCE) {
        target.alive = false;
        target.vx = 0;
        target.vy = 0;
        tagged = true;
      }
    }

    if (tagged) {
      attacker.cooldownUntil = now + TAG_COOLDOWN_MS;
      const aliveCrew = [...room.players.values()].filter((p) => p.role === "crew" && p.alive).length;
      if (aliveCrew === 0) {
        stopGame(room, "shadow", "Shadow neutralized the whole crew.");
        return;
      }
    }

    broadcastRoom(room);
  });

  socket.on("player:shadow-skill", ({ roomCode, skill }) => {
    const room = rooms.get(String(roomCode || "").toUpperCase());
    if (!room || room.status !== "active") {
      return;
    }

    const shadow = room.players.get(socket.id);
    if (!shadow || !shadow.alive || shadow.role !== "shadow") {
      return;
    }

    const now = Date.now();
    if (skill === "dash") {
      if (now < shadow.shadowDashCooldownUntil) {
        return;
      }

      triggerShadowDash(shadow, now);
      room.chat.push(createChatEntry({ id: "system", name: "System" }, `${shadow.name} surged forward.`));
      room.chat = room.chat.slice(-CHAT_LIMIT);
      broadcastRoom(room);
      return;
    }

    if (skill === "mark") {
      if (now < shadow.shadowMarkCooldownUntil) {
        return;
      }

      if (triggerShadowMark(room, shadow, now)) {
        broadcastRoom(room);
      }
    }
  });

  socket.on("disconnect", () => {
    removePlayer(socket.id);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Bonko server running on http://localhost:${PORT}`);
});
