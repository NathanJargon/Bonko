const socket = io();

const menu = document.getElementById("menu");
const menuError = document.getElementById("menuError");
const lobbyPanel = document.getElementById("lobbyPanel");
const statusPanel = document.getElementById("statusPanel");
const statusTitle = document.getElementById("statusTitle");
const statusText = document.getElementById("statusText");
const hud = document.getElementById("hud");
const gameWrap = document.getElementById("gameWrap");
const playersList = document.getElementById("playersList");
const roomCodeEl = document.getElementById("roomCode");
const playerCountEl = document.getElementById("playerCount");
const scoreEl = document.getElementById("score");
const timerEl = document.getElementById("timer");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const state = {
  joined: false,
  roomCode: "",
  me: null,
  snapshot: null,
  keys: { up: false, down: false, left: false, right: false },
  lastSentMove: { vx: 0, vy: 0 },
};

nameInput.value = `Pilot${Math.floor(Math.random() * 900 + 100)}`;

function showError(message = "") {
  menuError.textContent = message;
}

function clearPanels() {
  lobbyPanel.classList.add("hidden");
  statusPanel.classList.add("hidden");
}

function updatePlayersList(snapshot) {
  playersList.innerHTML = "";
  snapshot.players.forEach((player) => {
    const li = document.createElement("li");
    const roleLabel = player.roleKnown ? (player.isShadow ? "Shadow" : "Crew") : "Unknown";
    li.textContent = `${player.name}${player.isHost ? " (Host)" : ""} - ${player.alive ? "Alive" : "Out"} - ${roleLabel}`;
    playersList.appendChild(li);
  });
}

function myPlayer(snapshot) {
  return snapshot.players.find((p) => p.id === socket.id) || null;
}

function setVisibility(snapshot) {
  menu.classList.toggle("hidden", state.joined);
  hud.classList.toggle("hidden", !state.joined);
  gameWrap.classList.toggle("hidden", !state.joined);

  clearPanels();

  const me = myPlayer(snapshot);
  const host = me && me.isHost;

  if (snapshot.status === "lobby") {
    lobbyPanel.classList.remove("hidden");
    startBtn.disabled = !host || snapshot.players.length < 3;
    statusPanel.classList.add("hidden");
  }

  if (snapshot.status === "active") {
    statusPanel.classList.remove("hidden");
    statusTitle.textContent = me && me.isShadow ? "Role: Shadow" : "Role: Crew";

    const cdSec = me ? Math.max(0, Math.ceil((me.cooldownUntil - snapshot.now) / 1000)) : 0;
    if (me && me.isShadow) {
      statusText.textContent = cdSec > 0 ? `Tag cooldown: ${cdSec}s` : "Space to tag nearby crew.";
    } else {
      statusText.textContent = "Collect shards and avoid the shadow.";
    }
  }

  if (snapshot.status === "ended") {
    statusPanel.classList.remove("hidden");
    statusTitle.textContent = snapshot.winner === "crew" ? "Crew Wins" : "Shadow Wins";
    statusText.textContent = snapshot.reason || "Round complete.";
    resetBtn.style.display = host ? "inline-block" : "none";
  } else {
    resetBtn.style.display = "none";
  }
}

function render(snapshot) {
  const me = myPlayer(snapshot);
  if (!me) {
    return;
  }

  const camera = {
    x: Math.max(0, Math.min(snapshot.world.width - canvas.width, me.x - canvas.width / 2)),
    y: Math.max(0, Math.min(snapshot.world.height - canvas.height, me.y - canvas.height / 2)),
  };

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(-camera.x, -camera.y);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  for (let x = 0; x <= snapshot.world.width; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, snapshot.world.height);
    ctx.stroke();
  }
  for (let y = 0; y <= snapshot.world.height; y += 80) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(snapshot.world.width, y);
    ctx.stroke();
  }

  snapshot.shards.forEach((shard) => {
    ctx.beginPath();
    ctx.fillStyle = "#7efad2";
    ctx.shadowBlur = 14;
    ctx.shadowColor = "rgba(126,250,210,0.9)";
    ctx.arc(shard.x, shard.y, shard.r, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.shadowBlur = 0;

  snapshot.players.forEach((player) => {
    if (!player.alive) {
      ctx.fillStyle = "#52617f";
    } else if (player.id === me.id) {
      ctx.fillStyle = "#ffd57a";
    } else if (player.isShadow && player.roleKnown) {
      ctx.fillStyle = "#ff5f89";
    } else {
      ctx.fillStyle = "#73a8ff";
    }

    ctx.beginPath();
    ctx.arc(player.x, player.y, 20, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "12px Space Grotesk";
    ctx.textAlign = "center";
    ctx.fillText(player.name, player.x, player.y - 26);
  });

  ctx.restore();

  if (!me.alive && snapshot.status === "active") {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "700 36px Space Grotesk";
    ctx.textAlign = "center";
    ctx.fillText("You are out", canvas.width / 2, canvas.height / 2);
  }
}

function updateHud(snapshot) {
  roomCodeEl.textContent = snapshot.room;
  playerCountEl.textContent = `${snapshot.players.length}`;
  scoreEl.textContent = `${snapshot.score}/28`;
  const remaining = snapshot.endsAt ? Math.max(0, Math.ceil((snapshot.endsAt - snapshot.now) / 1000)) : 180;
  timerEl.textContent = String(remaining);
}

function sendMove() {
  if (!state.joined || !state.snapshot || state.snapshot.status !== "active") {
    return;
  }

  const vx = Number(state.keys.right) - Number(state.keys.left);
  const vy = Number(state.keys.down) - Number(state.keys.up);

  if (vx === state.lastSentMove.vx && vy === state.lastSentMove.vy) {
    return;
  }

  state.lastSentMove = { vx, vy };
  socket.emit("player:move", { roomCode: state.roomCode, vx, vy });
}

setInterval(sendMove, 33);

function connectRoom(createNew) {
  const name = nameInput.value.trim();
  const code = roomInput.value.trim().toUpperCase();

  if (!name) {
    showError("Choose a pilot name.");
    return;
  }

  showError("");

  if (createNew) {
    socket.emit("room:create", { name });
    return;
  }

  if (!code) {
    showError("Enter a room code to join.");
    return;
  }

  socket.emit("room:join", { code, name });
}

createBtn.addEventListener("click", () => connectRoom(true));
joinBtn.addEventListener("click", () => connectRoom(false));

startBtn.addEventListener("click", () => {
  socket.emit("round:start", { roomCode: state.roomCode });
});

resetBtn.addEventListener("click", () => {
  socket.emit("round:reset", { roomCode: state.roomCode });
});

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (key === "w" || key === "arrowup") state.keys.up = true;
  if (key === "s" || key === "arrowdown") state.keys.down = true;
  if (key === "a" || key === "arrowleft") state.keys.left = true;
  if (key === "d" || key === "arrowright") state.keys.right = true;

  if (key === " " || key === "space") {
    socket.emit("player:tag", { roomCode: state.roomCode });
  }
});

window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (key === "w" || key === "arrowup") state.keys.up = false;
  if (key === "s" || key === "arrowdown") state.keys.down = false;
  if (key === "a" || key === "arrowleft") state.keys.left = false;
  if (key === "d" || key === "arrowright") state.keys.right = false;
});

socket.on("room:joined", ({ room }) => {
  state.joined = true;
  state.roomCode = room;
  roomInput.value = room;
});

socket.on("room:update", (snapshot) => {
  state.snapshot = snapshot;
  updatePlayersList(snapshot);
  setVisibility(snapshot);
  updateHud(snapshot);
  render(snapshot);
});

socket.on("error:message", (message) => {
  showError(message);
});
