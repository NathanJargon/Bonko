import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "/";

const socket = io(SOCKET_URL, {
  autoConnect: true,
  transports: ["websocket"],
});

const CANVAS_WIDTH = 980;
const CANVAS_HEIGHT = 620;

const MODE_PRESETS = {
  classic: {
    label: "Classic",
    description: "The original crew-vs-shadow match.",
    botCount: 0,
    paceLabel: "1.00x pace",
    tone: "balanced",
  },
  practice: {
    label: "Practice",
    description: "Bots fill the room so you can drill movement, notes, and tagging.",
    botCount: 4,
    paceLabel: "1.08x pace",
    tone: "training",
  },
  chaos: {
    label: "Chaos",
    description: "Faster rounds, more notes, and more pressure.",
    botCount: 6,
    paceLabel: "1.20x pace",
    tone: "wild",
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function randomPilotName() {
  return `Bonko${Math.floor(Math.random() * 900 + 100)}`;
}

function formatSeconds(value) {
  return `${Math.max(0, Math.ceil(value))}s`;
}

function applyModeDefaults(mode) {
  const nextMode = MODE_PRESETS[mode] ? mode : "classic";
  const nextBotCount = MODE_PRESETS[nextMode].botCount;
  return { mode: nextMode, botCount: nextBotCount };
}

function ModeCard({ mode, preset, selected, onSelect }) {
  return (
    <button className={`mode-card ${selected ? "selected" : ""}`} onClick={() => onSelect(mode)} type="button">
      <span className="mode-card__label">{preset.label}</span>
      <strong>{preset.paceLabel}</strong>
      <p>{preset.description}</p>
    </button>
  );
}

function PlayerRow({ player, isYou }) {
  return (
    <li className={`roster-row ${isYou ? "me" : ""} ${player.bot ? "bot" : "human"}`}>
      <span className="roster-row__name">
        {player.name}
        {player.bot && <em>BOT</em>}
        {player.isHost && <em>HOST</em>}
      </span>
      <span className="roster-row__state">{player.alive ? (player.bot ? "AI" : "Live") : "Out"}</span>
    </li>
  );
}

export default function App() {
  const [name, setName] = useState(randomPilotName);
  const [roomInput, setRoomInput] = useState("");
  const [menuError, setMenuError] = useState("");
  const [joined, setJoined] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [chatInput, setChatInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [showMenus, setShowMenus] = useState(true);
  const [draftMode, setDraftMode] = useState("practice");
  const [draftBotCount, setDraftBotCount] = useState(MODE_PRESETS.practice.botCount);

  const canvasRef = useRef(null);
  const keysRef = useRef({ up: false, down: false, left: false, right: false });
  const moveRef = useRef({ vx: 0, vy: 0 });
  const renderPlayersRef = useRef(new Map());

  const me = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    return snapshot.players.find((player) => player.id === socket.id) ?? null;
  }, [snapshot]);

  const isHost = Boolean(me?.isHost);
  const canEditLobby = joined && isHost && snapshot?.status === "lobby";
  const currentMode = snapshot?.mode ?? draftMode;
  const currentPreset = MODE_PRESETS[currentMode] ?? MODE_PRESETS.classic;
  const currentBotCount = snapshot?.botCount ?? draftBotCount;
  const modeTone = currentPreset.tone;
  const chatMessages = snapshot?.chat ?? [];
  const isPlaying = joined && snapshot?.status === "active";
  const overlaysVisible = !isPlaying || showMenus;
  const noteTarget = snapshot?.noteTarget ?? snapshot?.taskTarget ?? 8;
  const shadowDashReady = Boolean(me?.isShadow) && (me?.shadowDashCooldownUntil ?? 0) <= (snapshot?.now ?? Date.now());
  const shadowMarkReady = Boolean(me?.isShadow) && (me?.shadowMarkCooldownUntil ?? 0) <= (snapshot?.now ?? Date.now());

  const nearestNote = useMemo(() => {
    if (!snapshot || !me) {
      return null;
    }

    let nearest = null;
    for (const item of snapshot.notes ?? snapshot.tasks ?? []) {
      if (!item.available) {
        continue;
      }

      const dx = me.x - item.x;
      const dy = me.y - item.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 64) {
        continue;
      }

      if (!nearest || distance < nearest.distance) {
        nearest = { item, distance };
      }
    }

    return nearest?.item ?? null;
  }, [snapshot, me]);

  const nearestInteractable = useMemo(() => {
    if (!snapshot || !me) {
      return null;
    }

    let nearest = null;
    for (const item of snapshot.interactables ?? []) {
      if (!item.available) {
        continue;
      }

      const dx = me.x - item.x;
      const dy = me.y - item.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 64) {
        continue;
      }

      if (!nearest || distance < nearest.distance) {
        nearest = { item, distance };
      }
    }

    return nearest?.item ?? null;
  }, [snapshot, me]);

  useEffect(() => {
    const onJoined = ({ room }) => {
      setJoined(true);
      setRoomCode(room);
      setRoomInput(room);
      setMenuError("");
    };

    const onUpdate = (nextSnapshot) => {
      setSnapshot(nextSnapshot);
    };

    const onError = (message) => {
      setMenuError(String(message || "Unknown error"));
    };

    socket.on("room:joined", onJoined);
    socket.on("room:update", onUpdate);
    socket.on("error:message", onError);

    return () => {
      socket.off("room:joined", onJoined);
      socket.off("room:update", onUpdate);
      socket.off("error:message", onError);
    };
  }, []);

  useEffect(() => {
    if (!snapshot || snapshot.status !== "lobby") {
      return;
    }

    const nextMode = snapshot.mode && MODE_PRESETS[snapshot.mode] ? snapshot.mode : "classic";
    setDraftMode(nextMode);
    setDraftBotCount(snapshot.botCount ?? MODE_PRESETS[nextMode].botCount);
  }, [snapshot]);

  useEffect(() => {
    if (snapshot?.status === "active") {
      setShowMenus(false);
      return;
    }

    setShowMenus(true);
  }, [snapshot?.status]);

  useEffect(() => {
    if (!nearestNote) {
      setNoteInput("");
    }
  }, [nearestNote]);

  useEffect(() => {
    const shouldFullscreen = joined && snapshot?.status === "active";

    if (shouldFullscreen && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }

    if (!shouldFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, [joined, snapshot?.status]);

  useEffect(() => {
    const keyDown = (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "w" || key === "arrowup") {
        event.preventDefault();
        keysRef.current.up = true;
      }
      if (key === "s" || key === "arrowdown") {
        event.preventDefault();
        keysRef.current.down = true;
      }
      if (key === "a" || key === "arrowleft") {
        event.preventDefault();
        keysRef.current.left = true;
      }
      if (key === "d" || key === "arrowright") {
        event.preventDefault();
        keysRef.current.right = true;
      }

      if ((key === " " || key === "space") && roomCode) {
        event.preventDefault();
        socket.emit("player:tag", { roomCode });
      }

      if (me?.isShadow && key === "q" && roomCode && snapshot?.status === "active") {
        event.preventDefault();
        socket.emit("player:shadow-skill", { roomCode, skill: "mark" });
      }

      if (me?.isShadow && key === "shift" && roomCode && snapshot?.status === "active") {
        event.preventDefault();
        socket.emit("player:shadow-skill", { roomCode, skill: "dash" });
      }

      if (key === "e" && roomCode && snapshot?.status !== "lobby") {
        event.preventDefault();
        socket.emit("player:interact", { roomCode });
      }
    };

    const keyUp = (event) => {
      const key = event.key.toLowerCase();
      if (key === "w" || key === "arrowup") keysRef.current.up = false;
      if (key === "s" || key === "arrowdown") keysRef.current.down = false;
      if (key === "a" || key === "arrowleft") keysRef.current.left = false;
      if (key === "d" || key === "arrowright") keysRef.current.right = false;
    };

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);

    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [roomCode, me?.isShadow, snapshot?.status]);

  useEffect(() => {
    let rafId = 0;

    const tick = () => {
      rafId = requestAnimationFrame(tick);

      if (!joined || !roomCode || !snapshot || snapshot.status !== "active") {
        if (moveRef.current.vx !== 0 || moveRef.current.vy !== 0) {
          moveRef.current = { vx: 0, vy: 0 };
          socket.emit("player:move", { roomCode, vx: 0, vy: 0 });
        }
        return;
      }

      const rawX = Number(keysRef.current.right) - Number(keysRef.current.left);
      const rawY = Number(keysRef.current.down) - Number(keysRef.current.up);
      const magnitude = Math.hypot(rawX, rawY);
      const vx = magnitude > 0 ? rawX / magnitude : 0;
      const vy = magnitude > 0 ? rawY / magnitude : 0;

      if (vx === moveRef.current.vx && vy === moveRef.current.vy) {
        return;
      }

      moveRef.current = { vx, vy };
      socket.emit("player:move", { roomCode, vx, vy });
    };

    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, [joined, roomCode, snapshot?.status]);

  useEffect(() => {
    let rafId = 0;

    const renderFrame = () => {
      rafId = requestAnimationFrame(renderFrame);
      if (!snapshot || !me || !canvasRef.current) {
        return;
      }

      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const dt = 0.35;
      const world = snapshot.world;
      const tracked = renderPlayersRef.current;

      snapshot.players.forEach((player) => {
        const prev = tracked.get(player.id);
        if (!prev) {
          tracked.set(player.id, { x: player.x, y: player.y });
          return;
        }

        prev.x = lerp(prev.x, player.x, dt);
        prev.y = lerp(prev.y, player.y, dt);
      });

      const selfTracked = tracked.get(me.id);
      if (selfTracked) {
        selfTracked.x = me.x;
        selfTracked.y = me.y;
      }

      for (const key of [...tracked.keys()]) {
        if (!snapshot.players.some((player) => player.id === key)) {
          tracked.delete(key);
        }
      }

      const meRender = tracked.get(me.id) || me;
      const cameraX = clamp(meRender.x - CANVAS_WIDTH / 2, 0, world.width - CANVAS_WIDTH);
      const cameraY = clamp(meRender.y - CANVAS_HEIGHT / 2, 0, world.height - CANVAS_HEIGHT);

      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      const bg = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      bg.addColorStop(0, "#07111f");
      bg.addColorStop(1, "#111a2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      ctx.save();
      ctx.translate(-cameraX, -cameraY);

      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      for (let x = 0; x <= world.width; x += 80) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, world.height);
        ctx.stroke();
      }
      for (let y = 0; y <= world.height; y += 80) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(world.width, y);
        ctx.stroke();
      }

      snapshot.walls.forEach((wall) => {
        const x = wall.x;
        const y = wall.y;
        ctx.fillStyle = "rgba(8, 13, 24, 0.96)";
        ctx.strokeStyle = "rgba(110, 231, 249, 0.2)";
        ctx.lineWidth = 2;
        ctx.fillRect(x, y, wall.w, wall.h);
        ctx.strokeRect(x, y, wall.w, wall.h);
      });

      (snapshot.notes ?? snapshot.tasks ?? []).forEach((item) => {
        const active = item.available;
        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.rotate(Math.sin((Date.now() + item.x) * 0.002) * 0.18);
        ctx.shadowBlur = active ? 20 : 0;
        ctx.shadowColor = active ? "rgba(249,168,212,0.7)" : "transparent";
        ctx.fillStyle = active ? "#f9a8d4" : "#334155";
        ctx.strokeStyle = active ? "rgba(255,255,255,0.38)" : "rgba(255,255,255,0.16)";
        ctx.lineWidth = 2;
        ctx.fillRect(-16, -16, 32, 32);
        ctx.strokeRect(-16, -16, 32, 32);
        ctx.fillStyle = "#0f172a";
        ctx.font = "700 11px Outfit";
        ctx.textAlign = "center";
        ctx.fillText("N", 0, 4);
        ctx.restore();
      });

      snapshot.interactables.forEach((item) => {
        const active = item.available;
        const pulse = 0.9 + Math.sin((Date.now() + item.x) * 0.01) * 0.08;
        const radius = item.r * pulse;
        ctx.beginPath();
        ctx.fillStyle = active ? (item.kind === "boost" ? "#8bffb8" : "#f9a8d4") : "#334155";
        ctx.shadowBlur = active ? 18 : 0;
        ctx.shadowColor = active ? (item.kind === "boost" ? "rgba(139,255,184,0.8)" : "rgba(249,168,212,0.8)") : "transparent";
        ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      ctx.shadowBlur = 0;

      snapshot.players.forEach((player) => {
        const draw = tracked.get(player.id) || player;
        if (!player.alive) {
          ctx.fillStyle = "#4b5563";
        } else if (player.id === me.id) {
          ctx.fillStyle = "#fbbf24";
        } else if (player.bot) {
          ctx.fillStyle = "#34d399";
        } else if (player.isShadow && player.roleKnown) {
          ctx.fillStyle = "#fb7185";
        } else {
          ctx.fillStyle = "#60a5fa";
        }

        ctx.beginPath();
        ctx.arc(draw.x, draw.y, 20, 0, Math.PI * 2);
        ctx.fill();

        if (player.bot) {
          ctx.strokeStyle = "rgba(255,255,255,0.45)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.fillStyle = "#f8fafc";
        ctx.font = "600 12px Outfit";
        ctx.textAlign = "center";
        ctx.fillText(player.name, draw.x, draw.y - 28);
      });

      ctx.restore();

      if (!me.alive && snapshot.status === "active") {
        ctx.fillStyle = "rgba(2, 6, 23, 0.6)";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "700 40px Fredoka";
        ctx.textAlign = "center";
        ctx.fillText("Bonked Out", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      }
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [snapshot, me]);

  function selectMode(nextMode) {
    const next = applyModeDefaults(nextMode);
    setDraftMode(next.mode);
    setDraftBotCount(next.botCount);

    if (canEditLobby) {
      socket.emit("room:settings", {
        roomCode,
        mode: next.mode,
        botCount: next.botCount,
      });
    }
  }

  function changeBotCount(delta) {
    if (draftMode === "classic") {
      return;
    }

    const nextBotCount = clamp(draftBotCount + delta, 0, 8);
    setDraftBotCount(nextBotCount);

    if (canEditLobby) {
      socket.emit("room:settings", {
        roomCode,
        mode: draftMode,
        botCount: nextBotCount,
      });
    }
  }

  function connectRoom(createNew) {
    const safeName = name.trim();
    const safeCode = roomInput.trim().toUpperCase();

    if (!safeName) {
      setMenuError("Pick a player name first.");
      return;
    }

    setMenuError("");
    if (createNew) {
      socket.emit("room:create", {
        name: safeName,
        mode: draftMode,
        botCount: draftMode === "classic" ? 0 : draftBotCount,
      });
      return;
    }

    if (!safeCode) {
      setMenuError("Enter room code to join.");
      return;
    }

    socket.emit("room:join", { code: safeCode, name: safeName });
  }

  function startRound() {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }

    socket.emit("round:start", { roomCode });
  }

  function resetRound() {
    socket.emit("round:reset", { roomCode });
  }

  function leaveRoom() {
    if (roomCode) {
      socket.emit("room:leave");
    }

    setJoined(false);
    setRoomCode("");
    setSnapshot(null);
    setChatInput("");
    setShowMenus(true);
    moveRef.current = { vx: 0, vy: 0 };
    keysRef.current = { up: false, down: false, left: false, right: false };
  }

  function submitNote(event) {
    event.preventDefault();

    if (!roomCode || snapshot?.status !== "active" || !nearestNote) {
      return;
    }

    socket.emit("note:submit", {
      roomCode,
      noteId: nearestNote.id,
      code: noteInput,
    });

    setNoteInput("");
  }

  function sendChat(event) {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) {
      return;
    }

    socket.emit("chat:send", { roomCode, text });
    setChatInput("");
  }

  function handleInteract() {
    if (!roomCode || snapshot?.status === "lobby") {
      return;
    }

    if (nearestNote) {
      return;
    }

    socket.emit("player:interact", { roomCode });
  }

  const players = snapshot?.players ?? [];
  const remaining = snapshot?.endsAt
    ? Math.max(0, Math.ceil((snapshot.endsAt - (snapshot.now ?? Date.now())) / 1000))
    : 180;
  const cooldown = me ? Math.max(0, Math.ceil(((me.cooldownUntil ?? 0) - (snapshot?.now ?? Date.now())) / 1000)) : 0;
  const roomScore = snapshot?.score ?? 0;

  return (
    <div className={`page tone-${modeTone} ${isPlaying ? "is-playing" : ""}`}>
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className={`game-shell ${isPlaying ? "is-playing" : ""}`}>
        <header className="masthead">
          <h1>Bonko</h1>
        </header>

        {!joined && (
          <section className="landing-grid">
            <section className="panel hero-panel pop-in">
              <div className="panel__head">
                <span className="panel__kicker">Start a match</span>
                <h2>Pick a mode</h2>
              </div>

              <div className="mode-grid">
                {Object.entries(MODE_PRESETS).map(([mode, preset]) => (
                  <ModeCard
                    key={mode}
                    mode={mode}
                    preset={preset}
                    selected={draftMode === mode}
                    onSelect={selectMode}
                  />
                ))}
              </div>

              <div className="field-grid">
                <label>
                  Pilot Name
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} />
                </label>
                <label>
                  Room Code
                  <input value={roomInput} onChange={(e) => setRoomInput(e.target.value.toUpperCase())} maxLength={6} />
                </label>
              </div>

              <div className="actions">
                <button onClick={() => connectRoom(true)}>Create {MODE_PRESETS[draftMode].label} Room</button>
                <button className="ghost" onClick={() => connectRoom(false)}>
                  Join Room
                </button>
              </div>

              <p className="error">{menuError}</p>
            </section>

            <aside className="panel info-panel pop-in">
              <div className="panel__head">
                <span className="panel__kicker">Current setup</span>
                <h2>Practice-ready settings</h2>
              </div>

              <div className="settings-stack">
                <div className="setting-row">
                  <div>
                    <strong>Selected mode</strong>
                    <p>{MODE_PRESETS[draftMode].description}</p>
                  </div>
                  <span className="setting-pill">{MODE_PRESETS[draftMode].label}</span>
                </div>

                <div className="setting-row">
                  <div>
                    <strong>Bot count</strong>
                    <p>{draftMode === "classic" ? "Disabled in Classic." : `${draftBotCount} training bots will join the room.`}</p>
                  </div>
                  <div className="stepper">
                    <button type="button" onClick={() => changeBotCount(-1)} disabled={draftMode === "classic"}>
                      -
                    </button>
                    <span>{draftMode === "classic" ? 0 : draftBotCount}</span>
                    <button type="button" onClick={() => changeBotCount(1)} disabled={draftMode === "classic"}>
                      +
                    </button>
                  </div>
                </div>

                <div className="setting-row">
                  <div>
                    <strong>Movement pace</strong>
                    <p>{currentPreset.paceLabel}</p>
                  </div>
                  <span className="setting-pill">Faster</span>
                </div>
              </div>

              <div className="note-box">
                Practice mode spawns bots immediately so you can start a match with just one human.
              </div>
            </aside>
          </section>
        )}

        {joined && snapshot && (
          <section className="arena-grid pop-in">
            <section className="stage panel">
              <div className="stage__head">
                <div>
                  <span className="panel__kicker">Room {snapshot.room}</span>
                  <h2>{snapshot.modeLabel}</h2>
                </div>
                <div className="hud-strip">
                  <span>{players.length} players</span>
                  <span>{roomScore}/{noteTarget} notes</span>
                  <span>{formatSeconds(remaining)}</span>
                  {isPlaying && (
                    <button type="button" className="overlay-toggle" onClick={() => setShowMenus((visible) => !visible)}>
                      {overlaysVisible ? "Hide Menus" : "Show Menus"}
                    </button>
                  )}
                  <button type="button" className="overlay-toggle" onClick={leaveRoom}>
                    Back to Modes
                  </button>
                </div>
              </div>

              <div className="canvas-wrap">
                <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
                <div className="canvas-legend">
                  <span>Move: WASD / Arrows</span>
                  <span>Tag: Space</span>
                  <span>Interact: E</span>
                  <span>{snapshot.pace.toFixed(2)}x pace</span>
                </div>
              </div>
            </section>

            <aside className="sidebar">
              {overlaysVisible && (
                <>
              <section className="panel mini-panel pop-in">
                <div className="panel__head">
                  <span className="panel__kicker">Match state</span>
                  <h3>{snapshot.status === "lobby" ? "Lobby" : snapshot.status === "active" ? "In play" : "Round over"}</h3>
                </div>

                <div className="status-grid">
                  <div>
                    <span>Mode</span>
                    <strong>{snapshot.modeLabel}</strong>
                  </div>
                  <div>
                    <span>Bots</span>
                    <strong>{snapshot.botCount}</strong>
                  </div>
                  <div>
                    <span>Players</span>
                    <strong>{players.length}</strong>
                  </div>
                  <div>
                    <span>Time</span>
                    <strong>{formatSeconds(remaining)}</strong>
                  </div>
                </div>
              </section>

              {snapshot.status === "lobby" && (
                <section className="panel mini-panel pop-in">
                  <div className="panel__head">
                    <span className="panel__kicker">Command deck</span>
                    <h3>Match settings</h3>
                  </div>

                  <div className="mode-grid compact">
                    {Object.entries(MODE_PRESETS).map(([mode, preset]) => (
                      <button
                        key={mode}
                        className={`mode-chip ${draftMode === mode ? "selected" : ""}`}
                        onClick={() => selectMode(mode)}
                        type="button"
                        disabled={!canEditLobby}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <div className="setting-row inline">
                    <div>
                      <strong>Bot count</strong>
                      <p>{draftMode === "classic" ? "Classic disables bots." : "Fine-tune practice pressure."}</p>
                    </div>
                    <div className="stepper">
                      <button type="button" onClick={() => changeBotCount(-1)} disabled={!canEditLobby || draftMode === "classic"}>
                        -
                      </button>
                      <span>{draftMode === "classic" ? 0 : draftBotCount}</span>
                      <button type="button" onClick={() => changeBotCount(1)} disabled={!canEditLobby || draftMode === "classic"}>
                        +
                      </button>
                    </div>
                  </div>

                  <button onClick={startRound} disabled={!isHost || (draftMode === "classic" && players.length < 3)}>
                    Start Round
                  </button>
                </section>
              )}

              {snapshot.status === "active" && (
                <section className="panel mini-panel pop-in">
                  <div className="panel__head">
                    <span className="panel__kicker">Role briefing</span>
                    <h3>{me?.isShadow ? "You are Shadow" : "You are Crew"}</h3>
                  </div>
                  <p className="muted">
                    {me?.isShadow
                      ? cooldown > 0
                          ? `Tag cooldown: ${cooldown}s`
                          : "Press Space to tag nearby crew. Q marks a target, Shift dashes."
                      : "Collect hidden notes, stay alive, and watch the shadow."}
                  </p>
                  {me?.isShadow && (
                    <div className="shadow-skill-grid">
                      <div>
                        <span>Dash</span>
                        <strong>{shadowDashReady ? "Ready" : `${Math.max(0, Math.ceil(((me?.shadowDashCooldownUntil ?? 0) - (snapshot?.now ?? Date.now())) / 1000))}s`}</strong>
                      </div>
                      <div>
                        <span>Mark</span>
                        <strong>{shadowMarkReady ? "Ready" : `${Math.max(0, Math.ceil(((me?.shadowMarkCooldownUntil ?? 0) - (snapshot?.now ?? Date.now())) / 1000))}s`}</strong>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {snapshot.status === "ended" && (
                <section className="panel mini-panel pop-in">
                  <div className="panel__head">
                    <span className="panel__kicker">Result</span>
                    <h3>{snapshot.winner === "crew" ? "Crew wins" : "Shadow wins"}</h3>
                  </div>
                  <p className="muted">{snapshot.reason}</p>
                  {isHost && <button onClick={resetRound}>Back To Lobby</button>}
                </section>
              )}

              <section className="panel mini-panel pop-in">
                <div className="panel__head">
                  <span className="panel__kicker">Roster</span>
                  <h3>{players.length} fighters</h3>
                </div>
                <ul className="roster-list">
                  {players.map((player) => (
                    <PlayerRow key={player.id} player={player} isYou={player.id === socket.id} />
                  ))}
                </ul>
              </section>
                </>
              )}

              <section className="panel mini-panel pop-in chat-panel">
                <div className="panel__head">
                  <span className="panel__kicker">Comms</span>
                  <h3>Live chat</h3>
                </div>

                <div className="chat-log">
                  {chatMessages.length === 0 ? (
                    <p className="muted">No messages yet.</p>
                  ) : (
                    chatMessages.map((message) => (
                      <div key={message.id} className={`chat-line ${message.bot ? "bot" : "human"}`}>
                        <strong>{message.author}</strong>
                        <span>{message.text}</span>
                      </div>
                    ))
                  )}
                </div>

                <form className="chat-form" onSubmit={sendChat}>
                  <input
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    placeholder="Type a message..."
                    maxLength={120}
                  />
                  <button type="submit">Send</button>
                </form>
              </section>
            </aside>
          </section>
        )}

        {joined && snapshot && nearestNote && (
          <section className="note-hud pop-in">
            <div className="note-hud__text">
              <span className="panel__kicker">Hidden Note</span>
              <strong>{nearestNote.code}</strong>
              <p>Type the code exactly to decode it.</p>
            </div>
            <form className="note-hud__form" onSubmit={submitNote}>
              <input
                value={noteInput}
                onChange={(event) => setNoteInput(event.target.value.toUpperCase())}
                placeholder="Enter code"
                maxLength={8}
              />
              <button type="submit">Decode</button>
            </form>
          </section>
        )}

        {joined && snapshot && overlaysVisible && (
          <footer className="control-bar">
            <div className="control-chip">
              <strong>Controls</strong>
              <span>Move</span>
              <p>WASD or arrows</p>
            </div>
            <div className="control-chip">
              <strong>Combat</strong>
              <span>Tag</span>
              <p>Space as Shadow</p>
            </div>
            {me?.isShadow && (
              <>
                <div className="control-chip">
                  <strong>Skill 1</strong>
                  <span>Q</span>
                  <p>Mark a nearby crew member</p>
                </div>
                <div className="control-chip">
                  <strong>Skill 2</strong>
                  <span>Shift</span>
                  <p>Dash forward to close distance</p>
                </div>
              </>
            )}
            <div className="control-chip">
              <strong>Interact</strong>
              <span>E</span>
              <p>{nearestInteractable ? nearestInteractable.label : nearestNote ? "Type the hidden note code" : "Move near a pad or cache"}</p>
            </div>
            <div className="control-chip accent">
              <strong>Chat</strong>
              <span>Enter</span>
              <p>Type below and send</p>
            </div>
            <button type="button" className="control-action" onClick={handleInteract} disabled={!nearestInteractable || snapshot.status === "lobby" || Boolean(nearestNote)}>
              Use Nearby
            </button>
          </footer>
        )}
      </main>
    </div>
  );
}
