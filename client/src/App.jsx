import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "/";

const socket = io(SOCKET_URL, {
  autoConnect: true,
  transports: ["websocket"],
});

const CANVAS_WIDTH = 980;
const CANVAS_HEIGHT = 620;
const PLAYER_SPEED = 360;
const MODE_PACE = {
  classic: 1,
  practice: 1.02,
};
const LOGO_URL = "/logo.png";

const MODE_PRESETS = {
  classic: {
    label: "Classic",
    description: "The original crew-vs-shadow match.",
    botCount: 0,
    noteCount: 8,
    paceLabel: "1.00x pace",
    tone: "balanced",
  },
  practice: {
    label: "Practice",
    description: "Bots fill the room so you can drill movement, notes, and tagging.",
    botCount: 4,
    noteCount: 8,
    paceLabel: "1.08x pace",
    tone: "training",
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function getModePace(mode) {
  return MODE_PACE[mode] ?? 1;
}

function getLocalMovementMultiplier(player, now) {
  const boostMultiplier = player.speedBoostUntil && player.speedBoostUntil > now ? 1.35 : 1;
  const shadowDashMultiplier = player.role === "shadow" && player.shadowDashUntil && player.shadowDashUntil > now ? 1.5 : 1;
  const slowMultiplier = player.slowedUntil && player.slowedUntil > now ? 0.72 : 1;
  const stunMultiplier = player.stunnedUntil && player.stunnedUntil > now ? 0 : 1;

  return boostMultiplier * shadowDashMultiplier * slowMultiplier * stunMultiplier;
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
  const nextNoteCount = MODE_PRESETS[nextMode].noteCount;
  return { mode: nextMode, botCount: nextBotCount, noteCount: nextNoteCount };
}

function getCanvasPalette(visualTheme) {
  if (visualTheme === "light") {
    return {
      bgStart: "#ffffff",
      bgEnd: "#f1f5f9",
      grid: "rgba(15,23,42,0.08)",
      wallFill: "rgba(31,41,55,0.96)",
      wallStroke: "rgba(15,23,42,0.35)",
      noteActive: "#111827",
      noteInactive: "#9ca3af",
      noteStroke: "rgba(15,23,42,0.45)",
      noteText: "#ffffff",
      boost: "#10b981",
      neutral: "#94a3b8",
      me: "#f59e0b",
      bot: "#0ea5e9",
      shadow: "#ef4444",
      crew: "#2563eb",
      dead: "#9ca3af",
      stunned: "#f97316",
      stunnedLabel: "#111827",
      playerName: "#111827",
      overlay: "rgba(248, 250, 252, 0.72)",
      overlayText: "#0f172a",
    };
  }

  return {
    bgStart: "#07111f",
    bgEnd: "#111a2d",
    grid: "rgba(255,255,255,0.04)",
    wallFill: "rgba(8, 13, 24, 0.96)",
    wallStroke: "rgba(110, 231, 249, 0.2)",
    noteActive: "#f9a8d4",
    noteInactive: "#334155",
    noteStroke: "rgba(255,255,255,0.38)",
    noteText: "#0f172a",
    boost: "#8bffb8",
    neutral: "#334155",
    me: "#fbbf24",
    bot: "#34d399",
    shadow: "#fb7185",
    crew: "#60a5fa",
    dead: "#4b5563",
    stunned: "#f97316",
    stunnedLabel: "#fdba74",
    playerName: "#f8fafc",
    overlay: "rgba(2, 6, 23, 0.6)",
    overlayText: "#e2e8f0",
  };
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
        {player.isSpectator && <em>SPEC</em>}
        {player.isHost && <em>HOST</em>}
      </span>
      <span className="roster-row__state">
        {player.isSpectator ? "Spectating" : player.alive ? (player.bot ? "AI" : "Live") : "Out"}
      </span>
    </li>
  );
}

export default function App() {
  const [name, setName] = useState(randomPilotName);
  const [roomInput, setRoomInput] = useState("");
  const [availableLobbies, setAvailableLobbies] = useState([]);
  const [isRefreshingLobbies, setIsRefreshingLobbies] = useState(false);
  const [menuError, setMenuError] = useState("");
  const [joined, setJoined] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [chatInput, setChatInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [showMenus, setShowMenus] = useState(true);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [visualTheme, setVisualTheme] = useState("dark");
  const [draftMode, setDraftMode] = useState("practice");
  const [draftBotCount, setDraftBotCount] = useState(MODE_PRESETS.practice.botCount);
  const [draftNoteCount, setDraftNoteCount] = useState(MODE_PRESETS.practice.noteCount);
  const [spectateTargetId, setSpectateTargetId] = useState(null);

  const canvasRef = useRef(null);
  const keysRef = useRef({ up: false, down: false, left: false, right: false });
  const moveRef = useRef({ vx: 0, vy: 0 });
  const renderPlayersRef = useRef(new Map());
  const predictedSelfRef = useRef({ x: 0, y: 0, initialized: false, lastFrameAt: 0 });
  const lastSeenChatIdRef = useRef(null);

  const me = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    return snapshot.players.find((player) => player.id === socket.id) ?? null;
  }, [snapshot]);

  const isHost = Boolean(me?.isHost);
  const isSpectator = Boolean(me?.isSpectator);
  const isBonkedOut = Boolean(me) && snapshot?.status === "active" && !me.alive;
  const isSpectating = isSpectator || isBonkedOut;
  const canEditLobby = joined && isHost && snapshot?.status === "lobby";
  const currentMode = snapshot?.mode ?? draftMode;
  const currentPreset = MODE_PRESETS[currentMode] ?? MODE_PRESETS.classic;
  const currentBotCount = snapshot?.botCount ?? draftBotCount;
  const currentNoteCount = snapshot?.noteCount ?? draftNoteCount;
  const modeTone = currentPreset.tone;
  const chatMessages = snapshot?.chat ?? [];
  const isPlaying = joined && snapshot?.status === "active";
  const overlaysVisible = !isPlaying || showMenus;
  const canvasPalette = useMemo(() => getCanvasPalette(visualTheme), [visualTheme]);
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

  const spectatablePlayers = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    return snapshot.players.filter((player) => !player.isSpectator && player.alive);
  }, [snapshot]);

  const spectateTarget = useMemo(() => {
    if (!isSpectating) {
      return null;
    }

    const byId = spectatablePlayers.find((player) => player.id === spectateTargetId);
    if (byId) {
      return byId;
    }

    return spectatablePlayers[0] ?? null;
  }, [isSpectating, spectatablePlayers, spectateTargetId]);

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

    const onLobbyList = ({ lobbies }) => {
      setAvailableLobbies(Array.isArray(lobbies) ? lobbies : []);
      setIsRefreshingLobbies(false);
    };

    socket.on("room:joined", onJoined);
    socket.on("room:update", onUpdate);
    socket.on("error:message", onError);
    socket.on("room:list", onLobbyList);

    return () => {
      socket.off("room:joined", onJoined);
      socket.off("room:update", onUpdate);
      socket.off("error:message", onError);
      socket.off("room:list", onLobbyList);
    };
  }, []);

  useEffect(() => {
    if (joined) {
      return;
    }

    setIsRefreshingLobbies(true);
    socket.emit("room:list");

    const interval = window.setInterval(() => {
      socket.emit("room:list");
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [joined]);

  useEffect(() => {
    if (!snapshot || snapshot.status !== "lobby") {
      return;
    }

    const nextMode = snapshot.mode && MODE_PRESETS[snapshot.mode] ? snapshot.mode : "classic";
    setDraftMode(nextMode);
    setDraftBotCount(snapshot.botCount ?? MODE_PRESETS[nextMode].botCount);
    setDraftNoteCount(snapshot.noteCount ?? MODE_PRESETS[nextMode].noteCount);
  }, [snapshot]);

  useEffect(() => {
    const predicted = predictedSelfRef.current;

    if (!me || !snapshot || snapshot.status !== "active" || isSpectating) {
      predictedSelfRef.current = { x: 0, y: 0, initialized: false, lastFrameAt: 0 };
      return;
    }

    if (!predicted.initialized) {
      predictedSelfRef.current = {
        x: me.x,
        y: me.y,
        initialized: true,
        lastFrameAt: performance.now(),
      };
      return;
    }

    const drift = Math.hypot(predicted.x - me.x, predicted.y - me.y);
    if (drift > 72) {
      predicted.x = me.x;
      predicted.y = me.y;
      predicted.lastFrameAt = performance.now();
    }
  }, [me?.id, me?.x, me?.y, snapshot?.status, isSpectating]);

  useEffect(() => {
    if (!joined || !snapshot) {
      lastSeenChatIdRef.current = null;
      setUnreadChatCount(0);
      return;
    }

    const messages = snapshot.chat ?? [];
    if (messages.length === 0) {
      return;
    }

    const latestId = messages[messages.length - 1]?.id;
    if (!latestId) {
      return;
    }

    if (lastSeenChatIdRef.current == null) {
      lastSeenChatIdRef.current = latestId;
      return;
    }

    if (isChatOpen) {
      lastSeenChatIdRef.current = latestId;
      setUnreadChatCount(0);
      return;
    }

    if (latestId === lastSeenChatIdRef.current) {
      return;
    }

    const lastSeenIndex = messages.findIndex((message) => message.id === lastSeenChatIdRef.current);
    const unseenCount = lastSeenIndex >= 0 ? messages.length - lastSeenIndex - 1 : 1;

    if (unseenCount > 0) {
      setUnreadChatCount((count) => Math.min(99, count + unseenCount));
    }

    lastSeenChatIdRef.current = latestId;
  }, [joined, snapshot, isChatOpen]);

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
    if (!isSpectating) {
      return;
    }

    if (spectatablePlayers.length === 0) {
      setSpectateTargetId(null);
      return;
    }

    if (!spectatablePlayers.some((player) => player.id === spectateTargetId)) {
      setSpectateTargetId(spectatablePlayers[0].id);
    }
  }, [isSpectating, spectatablePlayers, spectateTargetId]);

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
        if (isSpectating) {
          return;
        }
        event.preventDefault();
        socket.emit("player:tag", { roomCode });
      }

      if (key === "e" && nearestNote) {
        event.preventDefault();
        return;
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
        if (isSpectating) {
          return;
        }
        event.preventDefault();
        socket.emit("player:interact", { roomCode });
      }

      if (isSpectating && key === "tab" && spectatablePlayers.length > 0) {
        event.preventDefault();
        const index = spectatablePlayers.findIndex((player) => player.id === spectateTargetId);
        const nextIndex = index < 0 ? 0 : (index + 1) % spectatablePlayers.length;
        setSpectateTargetId(spectatablePlayers[nextIndex].id);
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
  }, [roomCode, me?.isShadow, snapshot?.status, nearestNote, isSpectating, spectatablePlayers, spectateTargetId]);

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

      if (isSpectating) {
        if (moveRef.current.vx !== 0 || moveRef.current.vy !== 0) {
          moveRef.current = { vx: 0, vy: 0 };
          socket.emit("player:move", { roomCode, vx: 0, vy: 0 });
        }
        return;
      }

      const rawX = Number(keysRef.current.right) - Number(keysRef.current.left);
      const rawY = Number(keysRef.current.down) - Number(keysRef.current.up);
      const magnitude = Math.hypot(rawX, rawY);
      const targetVx = magnitude > 0 ? rawX / magnitude : 0;
      const targetVy = magnitude > 0 ? rawY / magnitude : 0;
      const easing = magnitude === 0 ? 0.18 : 0.28;
      const vx = moveRef.current.vx + (targetVx - moveRef.current.vx) * easing;
      const vy = moveRef.current.vy + (targetVy - moveRef.current.vy) * easing;

      if (Math.abs(vx - moveRef.current.vx) < 0.003 && Math.abs(vy - moveRef.current.vy) < 0.003) {
        return;
      }

      moveRef.current = { vx, vy };
      socket.emit("player:move", { roomCode, vx, vy });
    };

    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, [joined, roomCode, snapshot?.status, isSpectating]);

  useEffect(() => {
    let rafId = 0;

    const renderFrame = (timestamp) => {
      rafId = requestAnimationFrame(renderFrame);
      if (!snapshot || !me || !canvasRef.current) {
        return;
      }

      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const now = timestamp ?? performance.now();
      const world = snapshot.world;
      const tracked = renderPlayersRef.current;
      const predictedSelf = predictedSelfRef.current;

      if (predictedSelf.initialized && joined && snapshot.status === "active" && !isSpectating) {
        const deltaSeconds = predictedSelf.lastFrameAt ? Math.min((now - predictedSelf.lastFrameAt) / 1000, 0.05) : 0;
        const playerMultiplier = getLocalMovementMultiplier(me, snapshot.now ?? Date.now());
        const pace = getModePace(snapshot.mode);

        predictedSelf.x += moveRef.current.vx * PLAYER_SPEED * pace * playerMultiplier * deltaSeconds;
        predictedSelf.y += moveRef.current.vy * PLAYER_SPEED * pace * playerMultiplier * deltaSeconds;
        predictedSelf.x = clamp(predictedSelf.x, 20, world.width - 20);
        predictedSelf.y = clamp(predictedSelf.y, 20, world.height - 20);
        predictedSelf.lastFrameAt = now;
      }

      snapshot.players.forEach((player) => {
        if (player.id === me.id && predictedSelf.initialized) {
          tracked.set(player.id, { x: predictedSelf.x, y: predictedSelf.y });
          return;
        }

        const prev = tracked.get(player.id);
        if (!prev) {
          tracked.set(player.id, { x: player.x, y: player.y });
          return;
        }

        prev.x = lerp(prev.x, player.x, 0.35);
        prev.y = lerp(prev.y, player.y, 0.35);
      });

      const selfTracked = tracked.get(me.id);
      if (selfTracked && predictedSelf.initialized) {
        selfTracked.x = predictedSelf.x;
        selfTracked.y = predictedSelf.y;
      }

      for (const key of [...tracked.keys()]) {
        if (!snapshot.players.some((player) => player.id === key)) {
          tracked.delete(key);
        }
      }

      const cameraFocus = isSpectating ? spectateTarget : (tracked.get(me.id) || me);
      if (!cameraFocus) {
        return;
      }

      const focusRender = tracked.get(cameraFocus.id) || cameraFocus;
      const cameraX = clamp(focusRender.x - CANVAS_WIDTH / 2, 0, world.width - CANVAS_WIDTH);
      const cameraY = clamp(focusRender.y - CANVAS_HEIGHT / 2, 0, world.height - CANVAS_HEIGHT);

      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      const bg = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      bg.addColorStop(0, canvasPalette.bgStart);
      bg.addColorStop(1, canvasPalette.bgEnd);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      ctx.save();
      ctx.translate(-cameraX, -cameraY);

      ctx.strokeStyle = canvasPalette.grid;
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
        ctx.fillStyle = canvasPalette.wallFill;
        ctx.strokeStyle = canvasPalette.wallStroke;
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
        ctx.fillStyle = active ? canvasPalette.noteActive : canvasPalette.noteInactive;
        ctx.strokeStyle = active ? canvasPalette.noteStroke : "rgba(255,255,255,0.16)";
        ctx.lineWidth = 2;
        ctx.fillRect(-16, -16, 32, 32);
        ctx.strokeRect(-16, -16, 32, 32);
        ctx.fillStyle = canvasPalette.noteText;
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
        ctx.fillStyle = active ? (item.kind === "boost" ? canvasPalette.boost : canvasPalette.noteActive) : canvasPalette.neutral;
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
          ctx.fillStyle = canvasPalette.dead;
        } else if ((player.stunnedUntil ?? 0) > (snapshot.now ?? Date.now())) {
          ctx.fillStyle = canvasPalette.stunned;
        } else if (player.id === me.id) {
          ctx.fillStyle = canvasPalette.me;
        } else if (player.bot) {
          ctx.fillStyle = canvasPalette.bot;
        } else if (player.isShadow && player.roleKnown) {
          ctx.fillStyle = canvasPalette.shadow;
        } else {
          ctx.fillStyle = canvasPalette.crew;
        }

        ctx.beginPath();
        ctx.arc(draw.x, draw.y, 20, 0, Math.PI * 2);
        ctx.fill();

        if (player.bot) {
          ctx.strokeStyle = "rgba(255,255,255,0.45)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.fillStyle = canvasPalette.playerName;
        ctx.font = "600 12px Outfit";
        ctx.textAlign = "center";
        ctx.fillText(player.name, draw.x, draw.y - 28);

        if ((player.stunnedUntil ?? 0) > (snapshot.now ?? Date.now())) {
          ctx.fillStyle = canvasPalette.stunnedLabel;
          ctx.font = "700 10px Outfit";
          ctx.fillText("STUNNED", draw.x, draw.y + 34);
        }
      });

      ctx.restore();

      if (isBonkedOut && snapshot.status === "active") {
        ctx.fillStyle = canvasPalette.overlay;
        ctx.fillRect(0, 0, CANVAS_WIDTH, 86);
        ctx.fillStyle = canvasPalette.overlayText;
        ctx.font = "700 18px Fredoka";
        ctx.textAlign = "left";
        ctx.fillText("Bonked Out - Now Spectating", 16, 52);
      }

      if (isSpectating) {
        ctx.fillStyle = visualTheme === "light" ? "rgba(15, 23, 42, 0.08)" : "rgba(0, 0, 0, 0.25)";
        ctx.fillRect(14, 14, 320, 58);
        ctx.fillStyle = canvasPalette.overlayText;
        ctx.font = "700 12px Outfit";
        ctx.textAlign = "left";
        ctx.fillText("SPECTATOR MODE", 26, 38);
        ctx.font = "600 13px Outfit";
        ctx.fillText(spectateTarget ? `Watching: ${spectateTarget.name}` : "No active players to watch", 26, 58);
      }
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [snapshot, me, isSpectating, isBonkedOut, spectateTarget, canvasPalette, visualTheme]);

  function toggleVisualTheme() {
    setVisualTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  function cycleSpectateTarget() {
    if (spectatablePlayers.length === 0) {
      return;
    }

    const index = spectatablePlayers.findIndex((player) => player.id === spectateTargetId);
    const nextIndex = index < 0 ? 0 : (index + 1) % spectatablePlayers.length;
    setSpectateTargetId(spectatablePlayers[nextIndex].id);
  }

  function selectMode(nextMode) {
    const next = applyModeDefaults(nextMode);
    setDraftMode(next.mode);
    setDraftBotCount(next.botCount);
    setDraftNoteCount(next.noteCount);

    if (canEditLobby) {
      socket.emit("room:settings", {
        roomCode,
        mode: next.mode,
        botCount: next.botCount,
        noteCount: next.noteCount,
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
        noteCount: draftNoteCount,
      });
    }
  }

  function changeNoteCount(delta) {
    const nextNoteCount = clamp(draftNoteCount + delta, 4, 16);
    setDraftNoteCount(nextNoteCount);

    if (canEditLobby) {
      socket.emit("room:settings", {
        roomCode,
        mode: draftMode,
        botCount: draftBotCount,
        noteCount: nextNoteCount,
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
        noteCount: draftNoteCount,
      });
      return;
    }

    if (!safeCode) {
      setMenuError("Enter room code to join.");
      return;
    }

    socket.emit("room:join", { code: safeCode, name: safeName });
  }

  function refreshLobbyList() {
    if (joined) {
      return;
    }

    setIsRefreshingLobbies(true);
    socket.emit("room:list");
  }

  function joinLobby(lobbyCode) {
    const safeName = name.trim();
    if (!safeName) {
      setMenuError("Pick a player name first.");
      return;
    }

    const safeCode = String(lobbyCode || "").trim().toUpperCase();
    if (!safeCode) {
      return;
    }

    setMenuError("");
    setRoomInput(safeCode);
    socket.emit("room:join", { code: safeCode, name: safeName });
  }

  function startRound() {
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
    setIsChatOpen(false);
    setUnreadChatCount(0);
    lastSeenChatIdRef.current = null;
    setShowMenus(true);
    moveRef.current = { vx: 0, vy: 0 };
    predictedSelfRef.current = { x: 0, y: 0, initialized: false, lastFrameAt: 0 };
    keysRef.current = { up: false, down: false, left: false, right: false };
  }

  function submitNote(event) {
    event.preventDefault();

    if (!roomCode || snapshot?.status !== "active" || !nearestNote || !me?.alive) {
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

  function toggleChatPanel() {
    setIsChatOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setUnreadChatCount(0);
        const latestId = chatMessages[chatMessages.length - 1]?.id;
        if (latestId) {
          lastSeenChatIdRef.current = latestId;
        }
      }
      return nextOpen;
    });
  }

  function handleInteract() {
    if (!roomCode || snapshot?.status === "lobby" || nearestNote || isSpectating) {
      return;
    }

    socket.emit("player:interact", { roomCode });
  }

  function setMoveKey(direction, pressed) {
    keysRef.current[direction] = pressed;
  }

  function handleTouchMove(direction, pressed) {
    if (!joined || !roomCode || snapshot?.status !== "active" || isSpectating) {
      return;
    }

    setMoveKey(direction, pressed);
  }

  function handleTouchAction(action) {
    if (!joined || !roomCode) {
      return;
    }

    if (action === "tag") {
      if (isSpectating) {
        return;
      }

      socket.emit("player:tag", { roomCode });
      return;
    }

    if (action === "interact") {
      handleInteract();
      return;
    }

    if (action === "mark" && me?.isShadow && snapshot?.status === "active") {
      socket.emit("player:shadow-skill", { roomCode, skill: "mark" });
      return;
    }

    if (action === "dash" && me?.isShadow && snapshot?.status === "active") {
      socket.emit("player:shadow-skill", { roomCode, skill: "dash" });
      return;
    }

    if (action === "cycle" && isSpectating) {
      cycleSpectateTarget();
    }
  }

  const players = snapshot?.players ?? [];
  const remaining = snapshot?.endsAt
    ? Math.max(0, Math.ceil((snapshot.endsAt - (snapshot.now ?? Date.now())) / 1000))
    : 180;
  const cooldown = me ? Math.max(0, Math.ceil(((me.cooldownUntil ?? 0) - (snapshot?.now ?? Date.now())) / 1000)) : 0;
  const stunRemaining = me ? Math.max(0, Math.ceil(((me.stunnedUntil ?? 0) - (snapshot?.now ?? Date.now())) / 1000)) : 0;
  const roomScore = snapshot?.score ?? 0;
  const roleHeading = isSpectating ? "You are Spectating" : me?.isShadow ? "You are Shadow" : "You are Crew";
  const roleIntro = isSpectating
    ? "You are out of the round, but you can still guide teammates by watching live players."
    : me?.isShadow
    ? "Hunt quietly and pick targets carefully. You win by eliminating the crew before they finish notes."
    : "Work as a team, decode notes fast, and stay alive long enough to finish the objective.";
  const roleObjective = isSpectating
    ? "Watch active players and call out useful info in chat."
    : me?.isShadow
    ? "Tag crew players and stop them from reaching the note goal."
    : `Decode and secure ${noteTarget} hidden notes before time runs out.`;
  const roleSkills = isSpectating
    ? "Tab or Next Camera to cycle players."
    : me?.isShadow
    ? "Space: Tag, Q: Mark, Shift: Dash"
    : "No active abilities. Use movement, positioning, and comms.";

  return (
    <div className={`page tone-${modeTone} theme-${visualTheme} ${isPlaying ? "is-playing" : ""}`}>
      <button type="button" className="overlay-toggle theme-toggle-corner" onClick={toggleVisualTheme}>
        {visualTheme === "dark" ? "White Mode" : "Dark Mode"}
      </button>
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

            <section className="panel mini-panel pop-in menu-panel menu-panel--brief">
              <div className="panel__head">
                <span className="panel__kicker">Round brief</span>
                <h3>How the room plays</h3>
              </div>

              <div className="status-grid menu-facts">
                <div>
                  <span>Round flow</span>
                  <strong>Server-led, shared for everyone</strong>
                </div>
                <div>
                  <span>Movement</span>
                  <strong>Snappy inputs with soft smoothing</strong>
                </div>
                <div>
                  <span>Practice</span>
                  <strong>Bots let you warm up solo</strong>
                </div>
                <div>
                  <span>Host duty</span>
                  <strong>Controls the mode and restart</strong>
                </div>
              </div>

              <div className="menu-shortcuts">
                <span>WASD / Arrows</span>
                <span>Space to tag</span>
                <span>E to interact</span>
              </div>
            </section>

            <section className="panel mini-panel pop-in menu-panel menu-panel--lobbies">
              <div className="panel__head">
                <span className="panel__kicker">Open rooms</span>
                <h3>Jump into a lobby</h3>
              </div>

              <div className="lobby-browser">
                <div className="lobby-browser__head">
                  <strong>Find Lobby</strong>
                  <button type="button" className="overlay-toggle" onClick={refreshLobbyList} disabled={isRefreshingLobbies}>
                    {isRefreshingLobbies ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
                {availableLobbies.length === 0 ? (
                  <p className="muted">No open lobbies right now. Create one to get things started.</p>
                ) : (
                  <ul className="lobby-list">
                    {availableLobbies.map((lobby) => (
                      <li key={lobby.code} className="lobby-row">
                        <div>
                          <strong>{lobby.code}</strong>
                          <p>
                            {lobby.modeLabel} · {lobby.humans}/{lobby.capacity} humans · {lobby.spectators} spectators
                          </p>
                        </div>
                        <button type="button" onClick={() => joinLobby(lobby.code)}>
                          Join
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

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
                  {isSpectating && <span>Spectating</span>}
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
                  {isSpectating && <span>Cycle View: Tab</span>}
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
                    <span>Notes</span>
                    <strong>{currentNoteCount}</strong>
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

                  <div className="setting-row inline">
                    <div>
                      <strong>Note count</strong>
                      <p>How many hidden notes are active.</p>
                    </div>
                    <div className="stepper">
                      <button type="button" onClick={() => changeNoteCount(-1)} disabled={!canEditLobby}>
                        -
                      </button>
                      <span>{draftNoteCount}</span>
                      <button type="button" onClick={() => changeNoteCount(1)} disabled={!canEditLobby}>
                        +
                      </button>
                    </div>
                  </div>

                  <button onClick={startRound} disabled={!isHost || (draftMode === "classic" && players.length < 3)}>
                    Start Round
                  </button>
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

              {snapshot.status === "active" && (
                <section className="panel mini-panel pop-in role-brief-panel">
                  <div className="panel__head">
                    <span className="panel__kicker">Role briefing</span>
                    <h3>{roleHeading}</h3>
                  </div>

                  <p className="muted">
                    {stunRemaining > 0 && !isSpectating ? `Stunned (${stunRemaining}s). ` : ""}
                    {roleIntro}
                  </p>

                  <div className="role-brief-grid">
                    <div className="role-brief-item">
                      <span>Objective</span>
                      <strong>{roleObjective}</strong>
                    </div>
                    <div className="role-brief-item">
                      <span>Skills</span>
                      <strong>{roleSkills}</strong>
                    </div>
                  </div>

                  {isSpectating && (
                    <button type="button" onClick={cycleSpectateTarget} disabled={spectatablePlayers.length < 2}>
                      Next Player Camera
                    </button>
                  )}

                  {me?.isShadow && !isSpectating && (
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

                  {!isSpectating && me?.isShadow && cooldown > 0 && <p className="muted">Tag cooldown: {cooldown}s</p>}
                </section>
              )}

            </aside>
          </section>
        )}

        {joined && snapshot && isChatOpen && (
          <section className="panel mini-panel pop-in chat-panel chat-panel-fab">
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
        )}

        {joined && snapshot && (
          <button type="button" className="chat-fab" onClick={toggleChatPanel}>
            Chat
            {unreadChatCount > 0 && !isChatOpen && <span className="chat-fab__badge">{unreadChatCount}</span>}
          </button>
        )}

        {joined && snapshot && nearestNote && me?.alive && (
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
              <p>{nearestInteractable ? nearestInteractable.label : nearestNote ? "Type the hidden note code" : "Move near a pad"}</p>
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

        {joined && snapshot && isPlaying && (
          <footer className="mobile-controls pop-in" aria-label="Mobile controls">
            <div className="mobile-controls__pad" aria-label="Movement pad">
              <button
                type="button"
                className="mobile-controls__button mobile-controls__button--up"
                aria-label="Move up"
                onPointerDown={(event) => {
                  event.preventDefault();
                  handleTouchMove("up", true);
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  handleTouchMove("up", false);
                }}
                onPointerCancel={(event) => {
                  event.preventDefault();
                  handleTouchMove("up", false);
                }}
                onPointerLeave={(event) => {
                  event.preventDefault();
                  handleTouchMove("up", false);
                }}
              >
                ▲
              </button>
              <button
                type="button"
                className="mobile-controls__button mobile-controls__button--left"
                aria-label="Move left"
                onPointerDown={(event) => {
                  event.preventDefault();
                  handleTouchMove("left", true);
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  handleTouchMove("left", false);
                }}
                onPointerCancel={(event) => {
                  event.preventDefault();
                  handleTouchMove("left", false);
                }}
                onPointerLeave={(event) => {
                  event.preventDefault();
                  handleTouchMove("left", false);
                }}
              >
                ◀
              </button>
              <div className="mobile-controls__pad-center" aria-hidden="true" />
              <button
                type="button"
                className="mobile-controls__button mobile-controls__button--right"
                aria-label="Move right"
                onPointerDown={(event) => {
                  event.preventDefault();
                  handleTouchMove("right", true);
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  handleTouchMove("right", false);
                }}
                onPointerCancel={(event) => {
                  event.preventDefault();
                  handleTouchMove("right", false);
                }}
                onPointerLeave={(event) => {
                  event.preventDefault();
                  handleTouchMove("right", false);
                }}
              >
                ▶
              </button>
              <button
                type="button"
                className="mobile-controls__button mobile-controls__button--down"
                aria-label="Move down"
                onPointerDown={(event) => {
                  event.preventDefault();
                  handleTouchMove("down", true);
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  handleTouchMove("down", false);
                }}
                onPointerCancel={(event) => {
                  event.preventDefault();
                  handleTouchMove("down", false);
                }}
                onPointerLeave={(event) => {
                  event.preventDefault();
                  handleTouchMove("down", false);
                }}
              >
                ▼
              </button>
            </div>

            <div className="mobile-controls__actions" aria-label="Action buttons">
              <button type="button" className="mobile-controls__button mobile-controls__button--accent" onClick={() => handleTouchAction("tag")}>
                Tag
              </button>
              <button type="button" className="mobile-controls__button" onClick={() => handleTouchAction("interact")} disabled={!nearestInteractable || snapshot.status === "lobby" || Boolean(nearestNote)}>
                Use
              </button>
              {me?.isShadow && (
                <>
                  <button type="button" className="mobile-controls__button" onClick={() => handleTouchAction("mark")} disabled={!shadowMarkReady}>
                    Mark
                  </button>
                  <button type="button" className="mobile-controls__button" onClick={() => handleTouchAction("dash")} disabled={!shadowDashReady}>
                    Dash
                  </button>
                </>
              )}
              {isSpectating && (
                <button type="button" className="mobile-controls__button" onClick={() => handleTouchAction("cycle")} disabled={spectatablePlayers.length < 2}>
                  Cycle
                </button>
              )}
            </div>
          </footer>
        )}
      </main>
    </div>
  );
}
