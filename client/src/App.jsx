import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "/";

const socket = io(SOCKET_URL, {
  autoConnect: true,
  transports: ["websocket"],
});

const CANVAS_WIDTH = 980;
const CANVAS_HEIGHT = 620;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function randomPilotName() {
  return `Bonko${Math.floor(Math.random() * 900 + 100)}`;
}

export default function App() {
  const [name, setName] = useState(randomPilotName);
  const [roomInput, setRoomInput] = useState("");
  const [menuError, setMenuError] = useState("");
  const [joined, setJoined] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [snapshot, setSnapshot] = useState(null);

  const canvasRef = useRef(null);
  const keysRef = useRef({ up: false, down: false, left: false, right: false });
  const moveRef = useRef({ vx: 0, vy: 0 });
  const renderPlayersRef = useRef(new Map());

  const me = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    return snapshot.players.find((p) => p.id === socket.id) ?? null;
  }, [snapshot]);

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
    const keyDown = (event) => {
      const key = event.key.toLowerCase();
      if (key === "w" || key === "arrowup") keysRef.current.up = true;
      if (key === "s" || key === "arrowdown") keysRef.current.down = true;
      if (key === "a" || key === "arrowleft") keysRef.current.left = true;
      if (key === "d" || key === "arrowright") keysRef.current.right = true;

      if ((key === " " || key === "space") && roomCode) {
        event.preventDefault();
        socket.emit("player:tag", { roomCode });
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
  }, [roomCode]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!joined || !snapshot || snapshot.status !== "active") {
        return;
      }

      const vx = Number(keysRef.current.right) - Number(keysRef.current.left);
      const vy = Number(keysRef.current.down) - Number(keysRef.current.up);
      if (vx === moveRef.current.vx && vy === moveRef.current.vy) {
        return;
      }

      moveRef.current = { vx, vy };
      socket.emit("player:move", { roomCode, vx, vy });
    }, 42);

    return () => clearInterval(timer);
  }, [joined, roomCode, snapshot]);

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

      const dt = 0.2;
      const world = snapshot.world;
      const tracked = renderPlayersRef.current;

      snapshot.players.forEach((p) => {
        const prev = tracked.get(p.id);
        if (!prev) {
          tracked.set(p.id, { x: p.x, y: p.y });
          return;
        }
        prev.x = lerp(prev.x, p.x, dt);
        prev.y = lerp(prev.y, p.y, dt);
      });

      for (const key of [...tracked.keys()]) {
        if (!snapshot.players.some((p) => p.id === key)) {
          tracked.delete(key);
        }
      }

      const meRender = tracked.get(me.id) || me;
      const cameraX = clamp(meRender.x - CANVAS_WIDTH / 2, 0, world.width - CANVAS_WIDTH);
      const cameraY = clamp(meRender.y - CANVAS_HEIGHT / 2, 0, world.height - CANVAS_HEIGHT);

      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      const grd = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      grd.addColorStop(0, "#0b1120");
      grd.addColorStop(1, "#111827");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      ctx.save();
      ctx.translate(-cameraX, -cameraY);

      ctx.strokeStyle = "rgba(255,255,255,0.045)";
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

      snapshot.shards.forEach((shard) => {
        const pulse = 0.8 + Math.sin((Date.now() + shard.x) * 0.007) * 0.2;
        ctx.beginPath();
        ctx.fillStyle = "#8bffb8";
        ctx.shadowBlur = 16;
        ctx.shadowColor = "rgba(139,255,184,0.85)";
        ctx.arc(shard.x, shard.y, shard.r * pulse, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.shadowBlur = 0;

      snapshot.players.forEach((p) => {
        const draw = tracked.get(p.id) || p;
        if (!p.alive) {
          ctx.fillStyle = "#4b5563";
        } else if (p.id === me.id) {
          ctx.fillStyle = "#fbbf24";
        } else if (p.isShadow && p.roleKnown) {
          ctx.fillStyle = "#fb7185";
        } else {
          ctx.fillStyle = "#60a5fa";
        }

        ctx.beginPath();
        ctx.arc(draw.x, draw.y, 20, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#f8fafc";
        ctx.font = "600 12px Outfit";
        ctx.textAlign = "center";
        ctx.fillText(p.name, draw.x, draw.y - 28);
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

  function connectRoom(createNew) {
    const safeName = name.trim();
    const safeCode = roomInput.trim().toUpperCase();

    if (!safeName) {
      setMenuError("Pick a player name first.");
      return;
    }

    setMenuError("");
    if (createNew) {
      socket.emit("room:create", { name: safeName });
      return;
    }

    if (!safeCode) {
      setMenuError("Enter room code to join.");
      return;
    }

    socket.emit("room:join", { code: safeCode, name: safeName });
  }

  function startRound() {
    socket.emit("round:start", { roomCode });
  }

  function resetRound() {
    socket.emit("round:reset", { roomCode });
  }

  const players = snapshot?.players ?? [];
  const scoreTarget = snapshot?.scoreTarget ?? 28;
  const remaining = snapshot?.endsAt ? Math.max(0, Math.ceil((snapshot.endsAt - (snapshot.now ?? Date.now())) / 1000)) : 180;
  const cooldown = me ? Math.max(0, Math.ceil(((me.cooldownUntil ?? 0) - (snapshot?.now ?? Date.now())) / 1000)) : 0;
  const isHost = Boolean(me?.isHost);

  return (
    <div className="page">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className="layout">
        <header className="brand">
          <h1>Bonko</h1>
          <p>Chaotic social chase game for 5-10 players.</p>
        </header>

        {!joined && (
          <section className="card menu pop-in">
            <h2>Join The Mayhem</h2>
            <div className="field-grid">
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} />
              </label>
              <label>
                Room Code
                <input value={roomInput} onChange={(e) => setRoomInput(e.target.value.toUpperCase())} maxLength={6} />
              </label>
            </div>
            <div className="actions">
              <button onClick={() => connectRoom(true)}>Create Room</button>
              <button className="ghost" onClick={() => connectRoom(false)}>
                Join Room
              </button>
            </div>
            <p className="error">{menuError}</p>
          </section>
        )}

        {joined && snapshot && (
          <>
            <section className="hud pop-in">
              <div className="chip">
                <span>Room</span>
                <strong>{snapshot.room}</strong>
              </div>
              <div className="chip">
                <span>Players</span>
                <strong>{players.length}</strong>
              </div>
              <div className="chip">
                <span>Score</span>
                <strong>
                  {snapshot.score}/{scoreTarget}
                </strong>
              </div>
              <div className="chip">
                <span>Time</span>
                <strong>{remaining}s</strong>
              </div>
            </section>

            <section className="surface pop-in">
              <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
              <div className="subhud">
                <p>Move: WASD / Arrows</p>
                <p>Action: Space</p>
              </div>
            </section>

            <section className="side pop-in">
              {snapshot.status === "lobby" && (
                <div className="card">
                  <h3>Lobby</h3>
                  <p className="muted">Host starts when everyone is ready.</p>
                  <ul>
                    {players.map((p) => (
                      <li key={p.id}>
                        <span>{p.name}</span>
                        <span>{p.isHost ? "Host" : p.alive ? "Ready" : "Out"}</span>
                      </li>
                    ))}
                  </ul>
                  <button onClick={startRound} disabled={!isHost || players.length < 3}>
                    Start Round
                  </button>
                </div>
              )}

              {snapshot.status === "active" && (
                <div className="card">
                  <h3>{me?.isShadow ? "Role: Shadow" : "Role: Crew"}</h3>
                  <p className="muted">
                    {me?.isShadow
                      ? cooldown > 0
                        ? `Tag cooldown: ${cooldown}s`
                        : "Press Space to tag nearby crew."
                      : "Collect shards and avoid getting bonked."}
                  </p>
                </div>
              )}

              {snapshot.status === "ended" && (
                <div className="card">
                  <h3>{snapshot.winner === "crew" ? "Crew Wins" : "Shadow Wins"}</h3>
                  <p className="muted">{snapshot.reason}</p>
                  {isHost && <button onClick={resetRound}>Back To Lobby</button>}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
