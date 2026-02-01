// server.js
// Tap-to-Rise Race - Single global game (no rooms)
// Run: npm i express socket.io && node server.js

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const app = express();

// Serve EVERYTHING in /public (so rising.mp3 works at /rising.mp3)
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Friendly routes (still work even with express.static)
app.get("/", (req, res) => res.redirect("/display"));
app.get("/display", (req, res) => res.sendFile(path.join(__dirname, "public", "display.html")));
app.get("/player", (req, res) => res.sendFile(path.join(__dirname, "public", "player.html")));

// -------------------------
// Single global game state
// -------------------------
const game = {
  hostId: null,
  requiredPlayers: 2,
  playersByKey: new Map(), 
  keyBySocket: new Map(),
  state: "lobby", 
  durationMs: 20000,
  startedAt: null,
  countdownTimer: null,
  endTimer: null,
};

const DISCONNECT_GRACE_MS = 5 * 60 * 1000; 

function nowMs() { return Date.now(); }

function cleanupOldDisconnected() {
  const t = nowMs();
  for (const [key, p] of game.playersByKey.entries()) {
    if (!p.connected && (t - (p.lastSeenAt || 0)) > DISCONNECT_GRACE_MS) {
      game.playersByKey.delete(key);
    }
  }
}

function playersArray() {
  cleanupOldDisconnected();
  return Array.from(game.playersByKey.values()).map((p) => ({
    key: p.key,
    id: p.id,
    name: p.name,
    progress: p.progress,
    connected: p.connected,
  }));
}

function publicState() {
  const playersArr = playersArray().map((p) => ({
    id: p.id,
    name: p.name,
    progress: p.progress,
    connected: p.connected,
    key: p.key,
  }));

  return {
    requiredPlayers: game.requiredPlayers,
    joinedPlayers: playersArr.length,
    state: game.state,
    durationMs: game.durationMs,
    startedAt: game.startedAt ?? null,
    players: playersArr,
    hasHost: !!game.hostId,
  };
}

function broadcastState() {
  io.emit("game:update", publicState());
}

function clearTimers() {
  if (game.countdownTimer) clearTimeout(game.countdownTimer);
  if (game.endTimer) clearTimeout(game.endTimer);
  game.countdownTimer = null;
  game.endTimer = null;
}

function resetToLobby() {
  clearTimers();
  game.state = "lobby";
  game.startedAt = null;
  for (const p of game.playersByKey.values()) {
    p.progress = 0;
    p.lastTapAt = 0;
  }
  io.emit("game:reset");
  broadcastState();
}

function endGame() {
  clearTimers();
  game.state = "ended";
  game.startedAt = null;

  const players = playersArray();
  players.sort((a, b) => (b.progress || 0) - (a.progress || 0));

  const winner = players[0]
    ? { id: players[0].id, name: players[0].name, progress: players[0].progress }
    : null;

  io.emit("game:ended", {
    winner,
    leaderboard: players.map((p) => ({
      id: p.id,
      name: p.name,
      progress: p.progress,
      connected: p.connected,
    })),
  });

  broadcastState();
}

function clampPlayersToRequired() {
  const arr = Array.from(game.playersByKey.values());
  if (arr.length <= game.requiredPlayers) return;

  arr.sort((a, b) => {
    const c = (b.connected ? 1 : 0) - (a.connected ? 1 : 0);
    if (c !== 0) return c;
    return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
  });

  const keep = new Set(arr.slice(0, game.requiredPlayers).map(p => p.key));
  for (const [key] of game.playersByKey.entries()) {
    if (!keep.has(key)) game.playersByKey.delete(key);
  }
}

io.on("connection", (socket) => {
  socket.emit("game:update", publicState());

  socket.on("host:claim", () => {
    game.hostId = socket.id;
    socket.emit("host:claimed", { ok: true });
    broadcastState();
  });

  socket.on("host:setPlayers", ({ requiredPlayers }) => {
    if (socket.id !== game.hostId) return;
    if (game.state !== "lobby") return;

    requiredPlayers = Number(requiredPlayers);
    if (![2, 3, 4, 5, 6, 7, 8].includes(requiredPlayers)) return;

    game.requiredPlayers = requiredPlayers;
    clampPlayersToRequired();
    broadcastState();
  });

  socket.on("host:startGame", () => {
    if (socket.id !== game.hostId) return;
    if (!["lobby", "ended"].includes(game.state)) return;

    const joined = playersArray().length;
    if (joined < game.requiredPlayers) {
      socket.emit("host:error", { message: `Need ${game.requiredPlayers} players, currently ${joined}.` });
      return;
    }

    for (const p of game.playersByKey.values()) {
      p.progress = 0;
      p.lastTapAt = 0;
    }

    clearTimers();
    game.state = "countdown";
    broadcastState();

    const countdownSeconds = 3;
    io.emit("game:countdown", { seconds: countdownSeconds });

    game.countdownTimer = setTimeout(() => {
      game.state = "running";
      game.startedAt = nowMs();
      broadcastState();

      io.emit("game:started", { startedAt: game.startedAt, durationMs: game.durationMs });

      game.endTimer = setTimeout(() => {
        if (game.state === "running") endGame();
      }, game.durationMs + 50);
    }, countdownSeconds * 1000);
  });

  socket.on("host:resetToLobby", () => {
    if (socket.id !== game.hostId) return;
    resetToLobby();
  });

  socket.on("player:join", ({ name, playerKey }) => {
    name = String(name || "").trim().slice(0, 16);
    playerKey = String(playerKey || "").trim();

    if (!name) {
      socket.emit("player:joinResult", { ok: false, reason: "Name is required." });
      return;
    }

    if (!playerKey) {
      playerKey = "pk_" + Math.random().toString(36).slice(2) + "_" + nowMs().toString(36);
    }

    if (game.state !== "lobby" && game.state !== "ended") {
      const existing = game.playersByKey.get(playerKey);
      if (!existing) {
        socket.emit("player:joinResult", { ok: false, reason: "Game in progress. Ask host to reset." });
        return;
      }
    }

    const isNew = !game.playersByKey.has(playerKey);
    if (isNew && playersArray().length >= game.requiredPlayers && (game.state === "lobby" || game.state === "ended")) {
      socket.emit("player:joinResult", { ok: false, reason: "Game is full." });
      return;
    }

    const p = game.playersByKey.get(playerKey) || {
      key: playerKey,
      id: socket.id,
      name,
      progress: 0,
      lastTapAt: 0,
      connected: true,
      lastSeenAt: nowMs(),
    };

    p.id = socket.id;
    p.name = name; 
    p.connected = true;
    p.lastSeenAt = nowMs();

    game.playersByKey.set(playerKey, p);
    game.keyBySocket.set(socket.id, playerKey);

    socket.emit("player:joinResult", { ok: true, name: p.name, playerKey: p.key });
    broadcastState();
  });

  socket.on("player:tap", () => {
    if (game.state !== "running") return;

    const key = game.keyBySocket.get(socket.id);
    if (!key) return;

    const p = game.playersByKey.get(key);
    if (!p) return;

    const t = nowMs();

    if (p.lastTapAt && t - p.lastTapAt < 50) return;
    p.lastTapAt = t;

    const perTap = 0.55;
    p.progress = Math.min(100, p.progress + perTap);

    io.emit("game:progress", { id: p.id, progress: p.progress });

    if (p.progress >= 100) endGame();
  });

  socket.on("disconnect", () => {
    if (game.hostId === socket.id) {
      game.hostId = null;
      io.emit("host:left");
      broadcastState();
      return;
    }

    const key = game.keyBySocket.get(socket.id);
    game.keyBySocket.delete(socket.id);

    if (key && game.playersByKey.has(key)) {
      const p = game.playersByKey.get(key);
      p.connected = false;
      p.lastSeenAt = nowMs();
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
