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
const PLAYER_SPEED = 280;
const TAG_DISTANCE = 52;
const TAG_COOLDOWN_MS = 8000;
const CREW_SCORE_TARGET = 28;
const SHARD_VALUE = 1;
const SHARD_COUNT = 32;
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

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

function createShard(id) {
  return {
    id,
    ...randomSpawn(),
    r: 12,
    value: SHARD_VALUE,
  };
}

function makeRoom(code) {
  return {
    code,
    hostId: null,
    status: "lobby",
    players: new Map(),
    score: 0,
    winner: null,
    startedAt: null,
    endsAt: null,
    ticker: null,
    shards: [],
    reason: "",
  };
}

function sanitizeName(name) {
  const cleaned = String(name || "Pilot").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
  return cleaned.slice(0, 16) || "Pilot";
}

function roomSnapshot(room, requesterId) {
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
    };

    if (!base.roleKnown && p.role === "shadow") {
      base.isShadow = false;
    }

    return base;
  });

  return {
    title: "Bonko",
    room: room.code,
    minRecommended: ROOM_SIZE_MIN,
    maxAllowed: ROOM_SIZE_MAX,
    scoreTarget: CREW_SCORE_TARGET,
    status: room.status,
    score: room.score,
    winner: room.winner,
    reason: room.reason,
    startsAt: room.startedAt,
    endsAt: room.endsAt,
    now: Date.now(),
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    shards: room.shards,
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
  room.shards = [];

  for (const player of room.players.values()) {
    const spawn = randomSpawn();
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.alive = true;
    player.role = "crew";
    player.cooldownUntil = 0;
  }

  broadcastRoom(room);
}

function startRound(room) {
  if (room.status === "active") {
    return;
  }

  const players = [...room.players.values()];
  if (players.length < 3) {
    return;
  }

  room.status = "active";
  room.score = 0;
  room.winner = null;
  room.reason = "";
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + ROUND_TIME_MS;
  room.shards = Array.from({ length: SHARD_COUNT }, (_, i) => createShard(`s${i}`));

  const shadowIndex = Math.floor(Math.random() * players.length);
  players.forEach((player, i) => {
    player.role = i === shadowIndex ? "shadow" : "crew";
    player.alive = true;
    player.cooldownUntil = 0;
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

    for (const player of room.players.values()) {
      if (!player.alive) {
        continue;
      }

      player.x += player.vx * PLAYER_SPEED * delta;
      player.y += player.vy * PLAYER_SPEED * delta;
      player.x = Math.max(20, Math.min(WORLD_WIDTH - 20, player.x));
      player.y = Math.max(20, Math.min(WORLD_HEIGHT - 20, player.y));

      if (player.role !== "crew") {
        continue;
      }

      for (let i = room.shards.length - 1; i >= 0; i -= 1) {
        const shard = room.shards[i];
        const dx = player.x - shard.x;
        const dy = player.y - shard.y;
        if (dx * dx + dy * dy <= 28 * 28) {
          room.score += shard.value;
          room.shards.splice(i, 1);
        }
      }
    }

    if (room.shards.length < SHARD_COUNT) {
      while (room.shards.length < SHARD_COUNT) {
        room.shards.push(createShard(`s${Date.now()}${Math.floor(Math.random() * 999)}`));
      }
    }

    if (room.score >= CREW_SCORE_TARGET) {
      stopGame(room, "crew", "Crew secured enough shards.");
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

    if (room.players.size === 0) {
      if (room.ticker) {
        clearInterval(room.ticker);
      }
      rooms.delete(room.code);
      return;
    }

    if (wasHost) {
      room.hostId = [...room.players.keys()][0];
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
  socket.on("room:create", ({ name }) => {
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
    });

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
    });

    socket.join(room.code);
    socket.emit("room:joined", { room: room.code, isHost: false });
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

  socket.on("disconnect", () => {
    removePlayer(socket.id);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Bonko server running on http://localhost:${PORT}`);
});
