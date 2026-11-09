// HTTP + Socket.IO server: player sessions, the waiting room, and game routing.
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { Game, clean } from "./game.js";
import { MODEL, MOCK } from "./gm.js";

const PORT = Number(process.env.PORT) || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const MAX_ACTIVE_GAMES = Number(process.env.MAX_ACTIVE_GAMES) || 10;
const MAX_PARTY = 8;
const LOBBY_GRACE_MS = 20_000; // keep a disconnected player in the lobby this long
const GAME_IDLE_MS = 30 * 60_000; // drop games nobody has been connected to for this long

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(here, "..", "public")));
app.get("/health", (_req, res) => res.json({ ok: true, games: games.size }));

const server = http.createServer(app);
const io = new Server(server);

/** playerId -> { id, name, character, concept, sockets:Set, inLobby, gameId, lobbyTimer } */
const players = new Map();
const lobby = { targetSize: null, ids: [] };
const games = new Map();

const publicPlayer = (p) => ({ id: p.id, name: p.name, character: p.character, concept: p.concept });

function lobbyState() {
  return {
    targetSize: lobby.targetSize,
    players: lobby.ids.map((id) => publicPlayer(players.get(id))),
  };
}

function broadcastLobby() {
  io.to("lobby").emit("lobby:state", lobbyState());
}

/** Run fn for every socket a player has open (they may have several tabs). */
function eachSocket(p, fn) {
  for (const sid of p.sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) fn(s);
  }
}

function removeFromLobby(p) {
  clearTimeout(p.lobbyTimer);
  if (!p.inLobby) return;
  p.inLobby = false;
  lobby.ids = lobby.ids.filter((id) => id !== p.id);
  if (lobby.ids.length === 0) lobby.targetSize = null;
  eachSocket(p, (s) => s.leave("lobby"));
  broadcastLobby();
}

function startGame() {
  if (lobby.ids.length === 0) return;
  if (games.size >= MAX_ACTIVE_GAMES) {
    io.to("lobby").emit("notice", "Every table is full right now. Please wait a few minutes and try again.");
    return;
  }
  const id = randomUUID().slice(0, 8);
  const members = lobby.ids.map((pid) => players.get(pid));
  lobby.ids = [];
  lobby.targetSize = null;

  const game = new Game({
    id,
    io,
    players: members,
    onEmpty: () => endGame(id),
  });
  games.set(id, game);
  for (const p of members) {
    clearTimeout(p.lobbyTimer);
    p.inLobby = false;
    p.gameId = id;
    eachSocket(p, (s) => {
      s.leave("lobby");
      s.join(game.room);
      s.emit("game:joined", { state: game.state(), transcript: game.transcript });
    });
  }
  console.log(`[game ${id}] started with ${members.length} player(s)`);
  game.start();
}

function endGame(id) {
  const game = games.get(id);
  if (!game) return;
  games.delete(id);
  for (const p of players.values()) if (p.gameId === id) p.gameId = null;
  io.to(game.room).emit("welcome", { needsAccessCode: !!ACCESS_CODE });
  io.in(game.room).socketsLeave(game.room);
  console.log(`[game ${id}] ended`);
}

io.on("connection", (socket) => {
  let me = null;
  const myGame = () => (me?.gameId ? games.get(me.gameId) : null);

  socket.on("hello", ({ playerId } = {}) => {
    if (typeof playerId !== "string" || !/^[\w-]{8,64}$/.test(playerId)) return;
    me = players.get(playerId);
    if (!me) {
      me = { id: playerId, sockets: new Set(), inLobby: false, gameId: null };
      players.set(playerId, me);
    }
    me.sockets.add(socket.id);
    clearTimeout(me.lobbyTimer);

    const game = myGame();
    if (game) {
      socket.join(game.room);
      game.setConnected(me.id, true);
      socket.emit("game:joined", { state: game.state(), transcript: game.transcript });
    } else if (me.inLobby) {
      socket.join("lobby");
      socket.emit("lobby:state", lobbyState());
    } else {
      me.gameId = null;
      socket.emit("welcome", { needsAccessCode: !!ACCESS_CODE });
    }
  });

  socket.on("lobby:join", (data = {}, ack = () => {}) => {
    if (!me || me.inLobby || myGame()) return ack({ ok: false, error: "Already seated." });
    if (ACCESS_CODE && data.accessCode !== ACCESS_CODE)
      return ack({ ok: false, error: "That access code isn't right." });
    const name = clean(data.name, 24);
    const character = clean(data.character, 30);
    const concept = clean(data.concept, 200);
    if (!name || !character || !concept)
      return ack({ ok: false, error: "Please fill in your name, character name, and concept." });
    if (lobby.ids.some((id) => players.get(id).character.toLowerCase() === character.toLowerCase()))
      return ack({ ok: false, error: "Someone in the waiting room already has that character name." });

    Object.assign(me, { name, character, concept, inLobby: true });
    if (lobby.targetSize == null) {
      const size = Number(data.partySize);
      lobby.targetSize = Number.isInteger(size) ? Math.min(MAX_PARTY, Math.max(1, size)) : 4;
    }
    lobby.ids.push(me.id);
    eachSocket(me, (s) => s.join("lobby"));
    ack({ ok: true });
    broadcastLobby();
    if (lobby.ids.length >= Math.min(lobby.targetSize, MAX_PARTY)) startGame();
  });

  socket.on("lobby:leave", () => {
    if (!me?.inLobby) return;
    removeFromLobby(me);
    eachSocket(me, (s) => s.emit("welcome", { needsAccessCode: !!ACCESS_CODE }));
  });

  socket.on("lobby:start", () => {
    if (me?.inLobby) startGame();
  });

  socket.on("game:action", ({ text } = {}) => myGame()?.submitAction(me.id, text));
  socket.on("game:proceed", () => myGame()?.proceed(me.id));
  socket.on("game:roll", ({ rollId } = {}) => myGame()?.roll(me.id, rollId));
  socket.on("game:retry", () => myGame()?.retry());
  socket.on("game:chat", ({ text } = {}) => myGame()?.chat(me.id, text));
  socket.on("game:leave", () => {
    const game = myGame();
    if (!game) return;
    me.gameId = null;
    eachSocket(me, (s) => {
      s.leave(game.room);
      s.emit("welcome", { needsAccessCode: !!ACCESS_CODE });
    });
    game.leave(me.id);
  });

  socket.on("disconnect", () => {
    if (!me) return;
    me.sockets.delete(socket.id);
    if (me.sockets.size > 0) return;
    const p = me;
    if (p.inLobby) {
      // Give them a moment to come back (e.g. a page refresh) before dropping them.
      p.lobbyTimer = setTimeout(() => {
        if (p.sockets.size === 0) removeFromLobby(p);
      }, LOBBY_GRACE_MS);
    }
    myGame()?.setConnected(p.id, false);
  });
});

// Periodically clean up abandoned games and forgotten players.
setInterval(() => {
  for (const [id, game] of games) if (game.isAbandoned(GAME_IDLE_MS)) endGame(id);
  for (const [id, p] of players)
    if (p.sockets.size === 0 && !p.inLobby && !p.gameId) players.delete(id);
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`Adventure Quest listening on http://localhost:${PORT}`);
  console.log(MOCK ? "Game Master: MOCK (no API calls)" : `Game Master: ${MODEL}`);
});
