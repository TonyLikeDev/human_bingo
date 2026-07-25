/**
 * Drives a real game against a running server (npm start) and asserts every rule:
 * the non-playing host, duplicate names, per-player question uniqueness, the
 * not-twice-in-a-row rule, bingo detection and reconnects.
 */
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (s, ev, payload) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${ev} timed out`)), 120_000);
    s.emit(ev, payload, (r) => {
      clearTimeout(t);
      res(r);
    });
  });

const connect = () =>
  new Promise((res, rej) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });

const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// Alice hosts and never plays. Bob, Carol and Dan are the players.
const host = await connect();
const b = await connect();
const c = await connect();
const d = await connect();
const spare = await connect();

const boards = {};
host.on('private_update', (p) => (boards.host = p));
b.on('private_update', (p) => (boards.B = p));
c.on('private_update', (p) => (boards.C = p));
d.on('private_update', (p) => (boards.D = p));

let room = null;
host.on('room_update', (r) => (room = r));

let bingoEvent = null;
host.on('bingo', (ev) => (bingoEvent = ev));

const idOf = (name) => room?.players.find((p) => p.name === name)?.id;

// ── create ────────────────────────────────────────────────────────────
const created = await call(host, 'create_room', {
  name: 'Alice',
  size: 3,
  categories: ['hobbies', 'skills'],
  theme: 'small startup team',
});
assert(created.ok && /^[A-Z0-9]{4}$/.test(created.code), `room created (code ${created.code})`);
room = created.room;
const code = created.code;

// ── names ─────────────────────────────────────────────────────────────
const dupe = await call(b, 'join_room', { code, name: 'alice' });
assert(!dupe.ok && /taken/i.test(dupe.error), `host's name is reserved too -> "${dupe.error}"`);

const bad = await call(b, 'join_room', { code: 'ZZZZ', name: 'Bob' });
assert(!bad.ok, `unknown room code rejected -> "${bad.error}"`);

const blank = await call(b, 'join_room', { code, name: '   ' });
assert(!blank.ok, `blank name rejected -> "${blank.error}"`);

// ── the host does not count towards the minimum ──────────────────────
assert((await call(b, 'join_room', { code, name: 'Bob' })).ok, 'Bob joined');
const carolJoin = await call(c, 'join_room', { code, name: 'Carol' });
assert(carolJoin.ok, 'Carol joined');
const carolToken = carolJoin.token;
await wait(150);

assert(room.playerCount === 2, `host excluded from the player count (${room.playerCount})`);
const tooEarly = await call(host, 'start_game');
assert(
  !tooEarly.ok && /at least 3 players besides yourself/.test(tooEarly.error),
  `start blocked with host + 2 players -> "${tooEarly.error}"`
);

assert((await call(d, 'join_room', { code, name: 'Dan' })).ok, 'Dan joined');
await wait(150);
assert(room.playerCount === 3, `three players now (${room.playerCount})`);

const notHost = await call(b, 'start_game');
assert(!notHost.ok && /host/i.test(notHost.error), `non-host cannot start -> "${notHost.error}"`);

// ── start ─────────────────────────────────────────────────────────────
console.log('\n… generating boards');
const t0 = Date.now();
const started = await call(host, 'start_game');
assert(started.ok, `game started in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!started.ok) {
  console.log('   error:', started.error);
  process.exit(1);
}
await wait(400);

// ── the host gets no card ────────────────────────────────────────────
assert(boards.host.board.length === 0, `host has no card (${boards.host.board.length} squares)`);
const hostEntry = room.players.find((p) => p.name === 'Alice');
assert(hostEntry.isHost && !hostEntry.isPlayer, 'host is flagged as a non-player');

// ── boards ────────────────────────────────────────────────────────────
const texts = (tag) => boards[tag].board.map((cell) => cell.text);
const bT = texts('B');
const cT = texts('C');
const dT = texts('D');
assert(bT.length === 9, `player board has 9 squares (got ${bT.length})`);
assert(new Set(bT).size === 9, 'no repeated question inside one board');
const overlap = bT.filter((t) => cT.includes(t) || dT.includes(t));
assert(overlap.length === 0, `no question shared between players (overlap ${overlap.length})`);

const norm = (x) => x.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const all = [...bT, ...cT, ...dT];
const near = [];
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const x = norm(all[i]);
    const y = norm(all[j]);
    if (x.includes(y) || y.includes(x)) near.push([all[i], all[j]]);
  }
}
assert(near.length === 0, `no near-duplicate questions across boards (${near.length})`);
console.log(`  degraded: ${room.degraded} (true = Groq unavailable, bank used)`);
console.log("\n  Bob's card:");
bT.forEach((t, i) => console.log(`   ${i}. ${t}`));
console.log('');

// ── the host cannot be marked, and cannot mark ───────────────────────
const bobId = idOf('Bob');
const carolId = idOf('Carol');
const danId = idOf('Dan');
const aliceId = idOf('Alice');
assert(Boolean(bobId && carolId && danId && aliceId), 'resolved every player id');

const markHost = await call(b, 'mark_cell', { cellIndex: 0, targetId: aliceId });
assert(
  !markHost.ok && /running the game/i.test(markHost.error),
  `host can't be put on a square -> "${markHost.error}"`
);

const hostMarks = await call(host, 'mark_cell', { cellIndex: 0, targetId: bobId });
assert(
  !hostMarks.ok && /don't have a card/i.test(hostMarks.error),
  `host can't mark squares -> "${hostMarks.error}"`
);

// ── marking rules ────────────────────────────────────────────────────
assert((await call(b, 'mark_cell', { cellIndex: 0, targetId: carolId })).ok, 'cell 0 marked with Carol');

const selfMark = await call(b, 'mark_cell', { cellIndex: 1, targetId: bobId });
assert(!selfMark.ok && /someone else/i.test(selfMark.error), `cannot use own name -> "${selfMark.error}"`);

const twice = await call(b, 'mark_cell', { cellIndex: 1, targetId: carolId });
assert(!twice.ok && /just used/i.test(twice.error), `same name twice in a row blocked -> "${twice.error}"`);

assert((await call(b, 'mark_cell', { cellIndex: 1, targetId: danId })).ok, 'cell 1 marked with Dan');
await wait(100);
assert(
  boards.B.usage.carol === 1 && boards.B.usage.dan === 1,
  `usage map counts each name once (${JSON.stringify(boards.B.usage)})`
);

assert((await call(b, 'mark_cell', { cellIndex: 4, targetId: carolId })).ok, 'Carol usable again after Dan');

const clear = await call(b, 'clear_cell', { cellIndex: 4 });
assert(clear.ok, 'square cleared');
await wait(100);
assert(boards.B.lastUsedName === 'Dan', `last-used name recomputed after clear (${boards.B.lastUsedName})`);

// ── bingo on the top row ─────────────────────────────────────────────
assert((await call(b, 'mark_cell', { cellIndex: 2, targetId: carolId })).ok, 'cell 2 marked with Carol');
await wait(300);
assert(bingoEvent?.winner?.name === 'Bob', 'bingo event fired for Bob');
assert(boards.B.bingoLine?.join() === '0,1,2', `winning line = [${boards.B.bingoLine}]`);
assert(room.status === 'finished', `room status is finished (${room.status})`);

const afterWin = await call(b, 'mark_cell', { cellIndex: 3, targetId: danId });
assert(!afterWin.ok && /not running/i.test(afterWin.error), `marking locked after win -> "${afterWin.error}"`);

// ── reconnect / token ────────────────────────────────────────────────
const wrongToken = await call(spare, 'join_room', { code, name: 'Carol', token: 'deadbeef' });
assert(!wrongToken.ok && /taken/i.test(wrongToken.error), `wrong token rejected -> "${wrongToken.error}"`);

const reconnect = await call(spare, 'join_room', { code, name: 'Carol', token: carolToken });
assert(reconnect.ok && reconnect.playerId === carolId, 'correct token reconnects as the same player');

// ── host keeps the role across a refresh ─────────────────────────────
const hostAgain = await connect();
host.close();
await wait(500);
assert(room.hostId === created.playerId, 'host role kept while host is offline');

hostAgain.on('room_update', (r) => (room = r));
let hostBoard = null;
hostAgain.on('private_update', (p) => (hostBoard = p));
const hostBack = await call(hostAgain, 'join_room', { code, name: 'Alice', token: created.token });
assert(hostBack.ok && hostBack.playerId === created.playerId, 'host reconnected as the same player');
await wait(200);
assert(room.hostId === created.playerId, 'host role still belongs to Alice after reconnect');

// ── restart ──────────────────────────────────────────────────────────
assert((await call(hostAgain, 'play_again')).ok, 'host restarted the room');
await wait(200);
assert(hostBoard?.board.length === 0, 'host still has no card after restart');
assert(room.status === 'lobby', `back in lobby (${room.status})`);

[b, c, d, spare, hostAgain].forEach((s) => s.close());
console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll checks passed.');
setTimeout(() => process.exit(process.exitCode || 0), 200);
