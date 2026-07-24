/** Pure game helpers: room codes, name handling, bingo detection, serialisation. */

import { randomBytes } from 'node:crypto';

export const SIZES = [3, 4, 5, 6];
// Counts players only, never the host: "no same name twice in a row" means each player needs
// two other players to alternate between. A room therefore needs the host plus 3 players.
export const MIN_PLAYERS = 3;
export const MAX_NAME_LENGTH = 20;

// No O/0/I/1 - these get misread when a code is called out across a room.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(taken) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const bytes = randomBytes(4);
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!taken.has(code)) return code;
  }
  return randomBytes(3).toString('hex').toUpperCase();
}

export const makeId = () => randomBytes(8).toString('hex');
export const makeToken = () => randomBytes(16).toString('hex');

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Collapse whitespace, strip control characters, cap length. */
export function cleanName(raw) {
  return String(raw ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/** Names are compared case- and accent-insensitively, so "tom" and "Tom" collide. */
export const nameKey = (name) =>
  cleanName(name).toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');

export function buildLines(size) {
  const lines = [];
  for (let r = 0; r < size; r++) {
    lines.push(Array.from({ length: size }, (_, c) => r * size + c));
  }
  for (let c = 0; c < size; c++) {
    lines.push(Array.from({ length: size }, (_, r) => r * size + c));
  }
  lines.push(Array.from({ length: size }, (_, i) => i * size + i));
  lines.push(Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)));
  return lines;
}

/** Returns the winning cell indices, or null if there is no complete line yet. */
export function findBingoLine(board, size) {
  for (const line of buildLines(size)) {
    if (line.every((i) => board[i] && board[i].markedWith)) return line;
  }
  return null;
}

/** The name used on the most recent mark - the one that cannot be used again straight away. */
export function lastUsedName(player) {
  for (let i = player.history.length - 1; i >= 0; i--) {
    const cell = player.board?.[player.history[i]];
    if (cell?.markedWith) return cell.markedWith;
  }
  return null;
}

/** How many squares on this player's board each other player already fills. */
export function usageCounts(player) {
  const counts = {};
  for (const cell of player.board || []) {
    if (!cell.markedWith) continue;
    const key = nameKey(cell.markedWith);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function markedCount(player) {
  return (player.board || []).reduce((n, cell) => n + (cell.markedWith ? 1 : 0), 0);
}

/** The host runs the session: no card, and nobody can mark a square with their name. */
export const isPlayer = (room, player) => player.id !== room.hostId;

export const playingMembers = (room) =>
  [...room.players.values()].filter((p) => isPlayer(room, p));

export const connectedPlayerCount = (room) =>
  playingMembers(room).filter((p) => p.connected).length;

/** Room state as broadcast to everyone. Never includes boards or tokens. */
export function publicRoom(room) {
  const total = room.size * room.size;
  return {
    code: room.code,
    size: room.size,
    status: room.status,
    theme: room.theme,
    categories: room.categories,
    degraded: room.degraded,
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    playerCount: connectedPlayerCount(room),
    winner: room.winner ? { id: room.winner.id, name: room.winner.name } : null,
    players: [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.id === room.hostId,
        isPlayer: isPlayer(room, p),
        marked: markedCount(p),
        total,
        hasBingo: Boolean(p.bingoLine),
      })),
  };
}

/** Private per-player payload: their own board and what they may do next. */
export function privateState(player) {
  return {
    playerId: player.id,
    board: player.board || [],
    bingoLine: player.bingoLine,
    lastUsedName: lastUsedName(player),
    usage: usageCounts(player),
  };
}
