import 'dotenv/config';

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';

import { generateTraits, CATEGORIES } from './lib/questions.js';
import {
  SIZES,
  MIN_PLAYERS,
  makeCode,
  makeId,
  makeToken,
  cleanName,
  nameKey,
  findBingoLine,
  lastUsedName,
  publicRoom,
  privateState,
  isPlayer,
  playingMembers,
  connectedPlayerCount,
} from './lib/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // rooms are dropped 6h after last activity

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// QR code for a room's invite link, as an SVG. The URL is rebuilt from the Host header the
// client actually used, so a phone scanning it lands on exactly the same address the host is
// on (LAN IP included) - the server never has to guess the hostname.
const CODE_RE = /^[A-Z0-9]{4}$/;
const HOST_RE = /^[a-zA-Z0-9.\-:[\]]{1,255}$/; // hostname[:port], incl. bracketed IPv6
app.get('/qr', async (req, res) => {
  const code = String(req.query.room || '').toUpperCase();
  const host = req.headers.host;
  if (!CODE_RE.test(code)) return res.status(400).type('text/plain').send('Invalid room code.');
  if (!host || !HOST_RE.test(host)) return res.status(400).type('text/plain').send('Bad host.');

  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const url = `${proto}://${host}/?room=${code}`;

  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#0b0e1a', light: '#ffffff' },
    });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (err) {
    console.error('[qr] generation failed:', err.message);
    res.status(500).type('text/plain').send('QR generation failed.');
  }
});

/** @type {Map<string, Room>} */
const rooms = new Map();

const ok = (data = {}) => ({ ok: true, ...data });
const fail = (message) => ({ ok: false, error: message });
const reply = (cb, payload) => {
  if (typeof cb === 'function') cb(payload);
};

const validCategories = (list) =>
  Array.isArray(list) ? list.filter((c) => Object.hasOwn(CATEGORIES, c)) : [];

function touch(room) {
  room.lastActivity = Date.now();
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', publicRoom(room));
}

function sendPrivate(player) {
  if (player.socketId) io.to(player.socketId).emit('private_update', privateState(player));
}

function allTraitsInUse(room) {
  const used = [];
  for (const p of room.players.values()) {
    for (const cell of p.board || []) used.push(cell.text);
  }
  return used;
}

/** Generate and hand out a fresh board to each player in `targets`. */
async function dealBoards(room, targets) {
  const cells = room.size * room.size;
  const need = cells * targets.length;
  if (!need) return;

  const { traits, degraded } = await generateTraits(need, {
    categories: room.categories,
    theme: room.theme,
    exclude: allTraitsInUse(room),
  });

  targets.forEach((player, i) => {
    player.board = traits
      .slice(i * cells, (i + 1) * cells)
      .map((text) => ({ text, markedWith: null }));
    player.history = [];
    player.bingoLine = null;
  });

  if (degraded) room.degraded = true;
}

const HOST_GRACE_MS = 45_000;

/**
 * Hand the host role to a player. Because the host doesn't play, this takes their card away,
 * so callers must only do it when no card is at stake.
 */
function promoteHost(room) {
  const candidates = playingMembers(room);
  const next = candidates.find((p) => p.connected) ?? candidates[0];
  if (!next) return;

  room.hostId = next.id;
  next.board = [];
  next.history = [];
  next.bingoLine = null;
  console.log(`[room ${room.code}] host is now "${next.name}"`);
  sendPrivate(next);
}

/**
 * Only acts if the host left the room entirely, and never mid-round: a room whose host
 * vanishes during play simply finishes the round, then picks a new host.
 */
function promoteHostIfNeeded(room) {
  if (room.players.has(room.hostId)) return;
  if (room.status === 'playing' || room.status === 'generating') return;
  promoteHost(room);
}

function clearHostHandover(room) {
  if (room.hostGraceTimer) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
  }
}

/**
 * A host who refreshes their browser should keep the role, so a disconnect only
 * starts a countdown - the handover happens if they do not come back.
 */
function scheduleHostHandover(room) {
  clearHostHandover(room);
  room.hostGraceTimer = setTimeout(() => {
    room.hostGraceTimer = null;
    const host = room.players.get(room.hostId);
    if (host && host.connected) return;
    if (room.status === 'playing' || room.status === 'generating') return;
    promoteHost(room);
    broadcastRoom(room);
  }, HOST_GRACE_MS);
  room.hostGraceTimer.unref?.();
}

function findSocketRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return {};
  const player = room.players.get(socket.data.playerId);
  if (!player) return { room };
  return { room, player };
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  socket.on('create_room', async (payload = {}, cb) => {
    const name = cleanName(payload.name);
    if (!name) return reply(cb, fail('Please enter your name.'));

    const size = Number(payload.size);
    if (!SIZES.includes(size)) return reply(cb, fail('Pick a valid grid size.'));

    const code = makeCode(new Set(rooms.keys()));
    const player = {
      id: makeId(),
      token: makeToken(),
      name,
      socketId: socket.id,
      connected: true,
      board: [],
      history: [],
      bingoLine: null,
      joinedAt: Date.now(),
    };

    const room = {
      code,
      size,
      theme: String(payload.theme ?? '').trim().slice(0, 120),
      categories: validCategories(payload.categories),
      status: 'lobby',
      hostId: player.id,
      players: new Map([[player.id, player]]),
      winner: null,
      degraded: false,
      hostGraceTimer: null,
      lastActivity: Date.now(),
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;

    console.log(`[room ${code}] created by "${name}" (${size}x${size})`);
    reply(cb, ok({ code, playerId: player.id, token: player.token, room: publicRoom(room) }));
    sendPrivate(player);
  });

  socket.on('join_room', async (payload = {}, cb) => {
    const code = String(payload.code ?? '').trim().toUpperCase();
    const name = cleanName(payload.name);
    const room = rooms.get(code);

    if (!room) return reply(cb, fail('No room with that code.'));
    if (!name) return reply(cb, fail('Please enter your name.'));

    const key = nameKey(name);
    const existing = [...room.players.values()].find((p) => nameKey(p.name) === key);

    let player;
    if (existing) {
      // Same name is only allowed back in if it is genuinely the same person reconnecting.
      if (!payload.token || payload.token !== existing.token) {
        return reply(cb, fail(`"${name}" is already taken in this room. Pick another name.`));
      }
      player = existing;
      player.connected = true;
      player.socketId = socket.id;
    } else {
      if (room.players.size >= 60) return reply(cb, fail('This room is full.'));
      player = {
        id: makeId(),
        token: makeToken(),
        name,
        socketId: socket.id,
        connected: true,
        board: [],
        history: [],
        bingoLine: null,
        joinedAt: Date.now(),
      };
      room.players.set(player.id, player);
    }

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;
    touch(room);
    if (player.id === room.hostId) clearHostHandover(room);
    promoteHostIfNeeded(room);

    reply(cb, ok({ code, playerId: player.id, token: player.token, room: publicRoom(room) }));

    // Someone joining a game already in progress still gets their own fresh board.
    if (room.status !== 'lobby' && !player.board.length) {
      try {
        await dealBoards(room, [player]);
      } catch (err) {
        console.error(`[room ${code}] board generation failed for late joiner:`, err.message);
      }
    }

    sendPrivate(player);
    broadcastRoom(room);
    console.log(`[room ${code}] "${name}" joined (${room.players.size} players)`);
  });

  socket.on('start_game', async (_payload, cb) => {
    const { room, player } = findSocketRoom(socket);
    if (!room || !player) return reply(cb, fail('You are not in a room.'));
    if (player.id !== room.hostId) return reply(cb, fail('Only the host can start the game.'));
    if (room.status === 'generating') return reply(cb, fail('Already building the boards.'));

    // The host runs the game and never gets a card, so they don't count towards the minimum.
    if (connectedPlayerCount(room) < MIN_PLAYERS) {
      return reply(
        cb,
        fail(
          `You need at least ${MIN_PLAYERS} players besides yourself - the same name can't be ` +
            `used twice in a row, so each player needs two others to alternate between.`
        )
      );
    }

    room.status = 'generating';
    room.winner = null;
    room.degraded = false;
    for (const p of room.players.values()) {
      p.board = [];
      p.history = [];
      p.bingoLine = null;
    }
    touch(room);
    broadcastRoom(room);

    const targets = playingMembers(room);
    console.log(`[room ${room.code}] generating ${targets.length} boards...`);

    try {
      await dealBoards(room, targets);
    } catch (err) {
      console.error(`[room ${room.code}] generation failed:`, err.message);
      room.status = 'lobby';
      broadcastRoom(room);
      return reply(cb, fail(`Could not generate questions: ${err.message}`));
    }

    room.status = 'playing';
    touch(room);
    broadcastRoom(room);
    for (const p of room.players.values()) sendPrivate(p);
    reply(cb, ok());
    console.log(`[room ${room.code}] game started`);
  });

  socket.on('mark_cell', (payload = {}, cb) => {
    const { room, player } = findSocketRoom(socket);
    if (!room || !player) return reply(cb, fail('You are not in a room.'));
    if (room.status !== 'playing') return reply(cb, fail('The game is not running.'));
    if (!isPlayer(room, player)) return reply(cb, fail("You're hosting - you don't have a card."));

    const index = Number(payload.cellIndex);
    const cell = player.board[index];
    if (!cell) return reply(cb, fail('That square does not exist.'));
    if (cell.markedWith) return reply(cb, fail('That square is already filled.'));

    const target = room.players.get(String(payload.targetId));
    if (!target) return reply(cb, fail('That player is no longer in the room.'));
    if (target.id === player.id) return reply(cb, fail('You have to find someone else!'));
    if (!isPlayer(room, target)) {
      return reply(cb, fail(`${target.name} is running the game and isn't playing.`));
    }

    const blocked = lastUsedName(player);
    if (blocked && nameKey(blocked) === nameKey(target.name)) {
      return reply(cb, fail(`You just used ${target.name} - find someone else first.`));
    }

    cell.markedWith = target.name;
    player.history.push(index);
    touch(room);

    const line = findBingoLine(player.board, room.size);
    if (line) {
      player.bingoLine = line;
      if (!room.winner) {
        room.winner = player;
        room.status = 'finished';
        io.to(room.code).emit('bingo', { winner: { id: player.id, name: player.name } });
        console.log(`[room ${room.code}] BINGO by "${player.name}"`);
        // A host who left mid-round can be replaced now that no card is at stake.
        promoteHostIfNeeded(room);
      }
    }

    reply(cb, ok());
    sendPrivate(player);
    broadcastRoom(room);
  });

  socket.on('clear_cell', (payload = {}, cb) => {
    const { room, player } = findSocketRoom(socket);
    if (!room || !player) return reply(cb, fail('You are not in a room.'));
    if (room.status !== 'playing') return reply(cb, fail('The game is not running.'));

    const index = Number(payload.cellIndex);
    const cell = player.board[index];
    if (!cell || !cell.markedWith) return reply(cb, fail('Nothing to clear there.'));

    cell.markedWith = null;
    player.history = player.history.filter((i) => i !== index);
    player.bingoLine = null;
    touch(room);

    reply(cb, ok());
    sendPrivate(player);
    broadcastRoom(room);
  });

  socket.on('play_again', (_payload, cb) => {
    const { room, player } = findSocketRoom(socket);
    if (!room || !player) return reply(cb, fail('You are not in a room.'));
    if (player.id !== room.hostId) return reply(cb, fail('Only the host can restart.'));

    room.status = 'lobby';
    room.winner = null;
    for (const p of room.players.values()) {
      p.board = [];
      p.history = [];
      p.bingoLine = null;
    }
    touch(room);
    broadcastRoom(room);
    for (const p of room.players.values()) sendPrivate(p);
    reply(cb, ok());
  });

  socket.on('update_settings', (payload = {}, cb) => {
    const { room, player } = findSocketRoom(socket);
    if (!room || !player) return reply(cb, fail('You are not in a room.'));
    if (player.id !== room.hostId) return reply(cb, fail('Only the host can change settings.'));
    if (room.status !== 'lobby') return reply(cb, fail('Settings are locked once the game starts.'));

    const size = Number(payload.size);
    if (SIZES.includes(size)) room.size = size;
    if (payload.categories !== undefined) room.categories = validCategories(payload.categories);
    if (payload.theme !== undefined) room.theme = String(payload.theme).trim().slice(0, 120);

    touch(room);
    broadcastRoom(room);
    reply(cb, ok());
  });

  socket.on('leave_room', (_payload, cb) => {
    const { room, player } = findSocketRoom(socket);
    if (room && player) {
      room.players.delete(player.id);
      socket.leave(room.code);
      if (player.id === room.hostId) clearHostHandover(room);
      promoteHostIfNeeded(room);
      if (room.players.size === 0) {
        clearHostHandover(room);
        rooms.delete(room.code);
      } else {
        broadcastRoom(room);
      }
    }
    socket.data.roomCode = null;
    socket.data.playerId = null;
    reply(cb, ok());
  });

  socket.on('disconnect', () => {
    const { room, player } = findSocketRoom(socket);
    if (!room || !player) return;
    if (player.socketId !== socket.id) return; // already re-attached to a newer socket

    player.connected = false;
    player.socketId = null;
    if (player.id === room.hostId) scheduleHostHandover(room);
    broadcastRoom(room);
  });
});

// Drop idle rooms so the process does not grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = [...room.players.values()].some((p) => p.connected);
    if (!anyConnected && now - room.lastActivity > ROOM_TTL_MS) {
      clearHostHandover(room);
      rooms.delete(code);
      console.log(`[room ${code}] expired`);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`\n  Human Bingo running at http://localhost:${PORT}`);
  if (!process.env.GROQ_API_KEY) {
    console.warn('  WARNING: GROQ_API_KEY is not set - copy .env.example to .env and add your key.');
  }
  console.log('');
});
