/**
 * Game actions, decoupled from any transport. Each function takes the store plus the
 * request input and returns a plain `{ ok, ... }` result - the same contract the old
 * socket callbacks used, so the client barely changed.
 *
 * Presence and host handover, which used live sockets and setTimeout in the server
 * version, are derived here from per-player `lastSeen` timestamps kept in the store's
 * seen-hash. That makes them correct across stateless serverless invocations.
 */

import { generateTraits, CATEGORIES } from './questions.js';
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
} from './game.js';

const PRESENCE_MS = 8_000; // shown "offline" after ~4 missed 2s polls
const HOST_GRACE_MS = 45_000; // a host who refreshes keeps the role for this long

const ok = (data = {}) => ({ ok: true, ...data });
const fail = (message) => ({ ok: false, error: message });

const validCategories = (list) =>
  Array.isArray(list) ? list.filter((c) => Object.hasOwn(CATEGORIES, c)) : [];

/* ── presence & host handover ───────────────────────────────────────────── */
function applyPresence(room, seen, now) {
  for (const p of room.players.values()) {
    const ts = seen[p.id] || 0;
    p.lastSeen = ts;
    p.connected = now - ts < PRESENCE_MS;
  }
}

/**
 * If the host has been gone longer than the grace window - and only while no card is
 * at stake (lobby or finished) - hand the role to another player. Returns true if the
 * room changed and must be saved. Mirrors the old promoteHost/handover pair.
 */
function reconcileHost(room, now) {
  if (room.status === 'playing' || room.status === 'generating') return false;
  const host = room.players.get(room.hostId);
  const hostGone = !host || now - (host.lastSeen || 0) > HOST_GRACE_MS;
  if (!hostGone) return false;

  const candidates = playingMembers(room);
  const next = candidates.find((p) => p.connected) ?? candidates[0];
  if (!next || next.id === room.hostId) return false;

  room.hostId = next.id;
  next.board = [];
  next.history = [];
  next.bingoLine = null;
  return true;
}

async function load(store, code, now = Date.now()) {
  const room = await store.getRoom(code);
  if (!room) return null;
  const seen = await store.getSeen(code);
  applyPresence(room, seen, now);
  return room;
}

function touch(room) {
  room.lastActivity = Date.now();
}

/* ── board generation ───────────────────────────────────────────────────── */
function allTraitsInUse(room) {
  const used = [];
  for (const p of room.players.values()) {
    for (const cell of p.board || []) used.push(cell.text);
  }
  return used;
}

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

/* ── helpers shared by authenticated actions ────────────────────────────── */
// Every in-room action carries the caller's identity; verify it against stored state.
function authed(room, playerId, token) {
  const player = room.players.get(playerId);
  if (!player || player.token !== token) return null;
  return player;
}

const snapshot = (room, player) => ({
  room: publicRoom(room),
  private: player && isPlayer(room, player) ? privateState(player) : null,
});

/* ── actions ────────────────────────────────────────────────────────────── */
export async function createRoom(store, { name: rawName, size: rawSize, theme, categories }) {
  const name = cleanName(rawName);
  if (!name) return fail('Please enter your name.');

  const size = Number(rawSize);
  if (!SIZES.includes(size)) return fail('Pick a valid grid size.');

  const player = {
    id: makeId(),
    token: makeToken(),
    name,
    board: [],
    history: [],
    bingoLine: null,
    joinedAt: Date.now(),
  };

  const room = {
    code: '',
    size,
    theme: String(theme ?? '').trim().slice(0, 120),
    categories: validCategories(categories),
    status: 'lobby',
    hostId: player.id,
    players: new Map([[player.id, player]]),
    winner: null,
    degraded: false,
    lastActivity: Date.now(),
  };

  // Reserve a unique code atomically; regenerate on the rare collision.
  let saved = false;
  for (let attempt = 0; attempt < 10 && !saved; attempt++) {
    room.code = makeCode(new Set());
    saved = await store.putRoomNX(room);
  }
  if (!saved) return fail('Could not create a room right now - please try again.');

  await store.touchSeen(room.code, player.id, Date.now());
  return ok({ code: room.code, playerId: player.id, token: player.token, room: publicRoom(room) });
}

export async function joinRoom(store, { code: rawCode, name: rawName, token }) {
  const code = String(rawCode ?? '').trim().toUpperCase();
  const room = await load(store, code);
  if (!room) return fail('No room with that code.');

  const name = cleanName(rawName);
  if (!name) return fail('Please enter your name.');

  const key = nameKey(name);
  const existing = [...room.players.values()].find((p) => nameKey(p.name) === key);

  let player;
  if (existing) {
    // Same name is only allowed back in if it is genuinely the same person reconnecting.
    if (!token || token !== existing.token) {
      return fail(`"${name}" is already taken in this room. Pick another name.`);
    }
    player = existing;
  } else {
    if (room.players.size >= 60) return fail('This room is full.');
    player = {
      id: makeId(),
      token: makeToken(),
      name,
      board: [],
      history: [],
      bingoLine: null,
      joinedAt: Date.now(),
    };
    room.players.set(player.id, player);
  }

  await store.touchSeen(code, player.id, Date.now());
  player.connected = true;
  player.lastSeen = Date.now();
  reconcileHost(room, Date.now());
  touch(room);

  // Someone joining a game already in progress still gets their own fresh board.
  if (room.status !== 'lobby' && room.status !== 'generating' && !player.board.length) {
    try {
      await dealBoards(room, [player]);
    } catch (err) {
      console.error(`[room ${code}] board generation failed for late joiner:`, err.message);
    }
  }

  await store.putRoom(room);
  return ok({ code, playerId: player.id, token: player.token, ...snapshot(room, player) });
}

export async function startGame(store, { code, playerId, token }) {
  const room = await load(store, code);
  if (!room) return fail('Room no longer exists.');
  const player = authed(room, playerId, token);
  if (!player) return fail('You are not in a room.');
  if (player.id !== room.hostId) return fail('Only the host can start the game.');
  if (room.status === 'generating') return fail('Already building the boards.');

  if (connectedPlayerCount(room) < MIN_PLAYERS) {
    return fail(
      `You need at least ${MIN_PLAYERS} players besides yourself - the same name can't be ` +
        `used twice in a row, so each player needs two others to alternate between.`
    );
  }

  // Publish the "generating" state before the slow Groq call so everyone's poll shows it.
  room.status = 'generating';
  room.winner = null;
  room.degraded = false;
  for (const p of room.players.values()) {
    p.board = [];
    p.history = [];
    p.bingoLine = null;
  }
  touch(room);
  await store.putRoom(room);

  try {
    await dealBoards(room, playingMembers(room));
  } catch (err) {
    console.error(`[room ${code}] generation failed:`, err.message);
    room.status = 'lobby';
    touch(room);
    await store.putRoom(room);
    return fail(`Could not generate questions: ${err.message}`);
  }

  room.status = 'playing';
  touch(room);
  await store.putRoom(room);
  return ok({ room: publicRoom(room) });
}

export async function markCell(store, { code, playerId, token, cellIndex, targetId }) {
  const room = await load(store, code);
  if (!room) return fail('Room no longer exists.');
  const player = authed(room, playerId, token);
  if (!player) return fail('You are not in a room.');
  if (room.status !== 'playing') return fail('The game is not running.');
  if (!isPlayer(room, player)) return fail("You're hosting - you don't have a card.");

  const index = Number(cellIndex);
  const cell = player.board[index];
  if (!cell) return fail('That square does not exist.');
  if (cell.markedWith) return fail('That square is already filled.');

  const target = room.players.get(String(targetId));
  if (!target) return fail('That player is no longer in the room.');
  if (target.id === player.id) return fail('You have to find someone else!');
  if (!isPlayer(room, target)) return fail(`${target.name} is running the game and isn't playing.`);

  const blocked = lastUsedName(player);
  if (blocked && nameKey(blocked) === nameKey(target.name)) {
    return fail(`You just used ${target.name} - find someone else first.`);
  }

  cell.markedWith = target.name;
  player.history.push(index);
  touch(room);

  const line = findBingoLine(player.board, room.size);
  if (line) {
    player.bingoLine = line;
    if (!room.winner) {
      room.winner = { id: player.id, name: player.name };
      room.status = 'finished';
      reconcileHost(room, Date.now()); // host who left mid-round can be replaced now
    }
  }

  await store.putRoom(room);
  return ok(snapshot(room, player));
}

export async function clearCell(store, { code, playerId, token, cellIndex }) {
  const room = await load(store, code);
  if (!room) return fail('Room no longer exists.');
  const player = authed(room, playerId, token);
  if (!player) return fail('You are not in a room.');
  if (room.status !== 'playing') return fail('The game is not running.');

  const index = Number(cellIndex);
  const cell = player.board[index];
  if (!cell || !cell.markedWith) return fail('Nothing to clear there.');

  cell.markedWith = null;
  player.history = player.history.filter((i) => i !== index);
  player.bingoLine = null;
  touch(room);

  await store.putRoom(room);
  return ok(snapshot(room, player));
}

function resetToLobby(room) {
  room.status = 'lobby';
  room.winner = null;
  for (const p of room.players.values()) {
    p.board = [];
    p.history = [];
    p.bingoLine = null;
  }
}

export async function playAgain(store, { code, playerId, token }) {
  const room = await load(store, code);
  if (!room) return fail('Room no longer exists.');
  const player = authed(room, playerId, token);
  if (!player) return fail('You are not in a room.');
  if (player.id !== room.hostId) return fail('Only the host can restart.');

  resetToLobby(room);
  touch(room);
  await store.putRoom(room);
  return ok({ room: publicRoom(room) });
}

/** End the current round early and drop everyone back to the lobby. */
export async function stopGame(store, { code, playerId, token }) {
  const room = await load(store, code);
  if (!room) return fail('Room no longer exists.');
  const player = authed(room, playerId, token);
  if (!player) return fail('You are not in a room.');
  if (player.id !== room.hostId) return fail('Only the host can stop the game.');
  if (room.status === 'lobby') return fail('The game is not running.');

  resetToLobby(room);
  touch(room);
  await store.putRoom(room);
  return ok({ room: publicRoom(room) });
}

export async function updateSettings(store, { code, playerId, token, size, categories, theme }) {
  const room = await load(store, code);
  if (!room) return fail('Room no longer exists.');
  const player = authed(room, playerId, token);
  if (!player) return fail('You are not in a room.');
  if (player.id !== room.hostId) return fail('Only the host can change settings.');
  if (room.status !== 'lobby') return fail('Settings are locked once the game starts.');

  const n = Number(size);
  if (SIZES.includes(n)) room.size = n;
  if (categories !== undefined) room.categories = validCategories(categories);
  if (theme !== undefined) room.theme = String(theme).trim().slice(0, 120);

  touch(room);
  await store.putRoom(room);
  return ok({ room: publicRoom(room) });
}

export async function leaveRoom(store, { code, playerId, token }) {
  const room = await load(store, code);
  if (!room) return ok();
  const player = authed(room, playerId, token);
  if (!player) return ok();

  room.players.delete(player.id);
  await store.remSeen(code, player.id);

  if (room.players.size === 0) {
    await store.delRoom(code);
    return ok();
  }
  reconcileHost(room, Date.now());
  touch(room);
  await store.putRoom(room);
  return ok();
}

/**
 * The player closed or navigated away from the page. Mark them offline right away by
 * back-dating their heartbeat, so everyone else sees them drop on their next poll. The
 * host keeps most of the handover grace window (this only ages them by one poll gap),
 * so a refresh still doesn't cost them the role.
 */
export async function away(store, { code, playerId, token }) {
  const room = await load(store, code);
  if (!room) return ok();
  const player = authed(room, playerId, token);
  if (!player) return ok();
  await store.touchSeen(code, player.id, Date.now() - PRESENCE_MS);
  return ok();
}

/** Poll + heartbeat: refresh the caller's presence, then return the current state. */
export async function getState(store, { code, playerId, token }) {
  const now = Date.now();
  if (playerId) await store.touchSeen(code, playerId, now);

  const room = await load(store, code, now);
  if (!room) return { ok: false, gone: true, error: 'This room has closed.' };

  const player = room.players.get(playerId);
  if (!player || player.token !== token) {
    return { ok: false, gone: true, error: 'You are no longer in this room.' };
  }

  if (reconcileHost(room, now)) {
    touch(room);
    await store.putRoom(room);
  }
  return ok(snapshot(room, player));
}

export const ACTIONS = {
  create_room: createRoom,
  join_room: joinRoom,
  start_game: startGame,
  mark_cell: markCell,
  clear_cell: clearCell,
  play_again: playAgain,
  stop_game: stopGame,
  update_settings: updateSettings,
  leave_room: leaveRoom,
  away,
};
