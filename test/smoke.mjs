/**
 * Headless 3-player game against the real server.
 * Verifies: room creation, duplicate-name rejection, per-player board uniqueness,
 * the "no same name twice in a row" rule, late joiners, and bingo detection.
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

const a = await connect();
const b = await connect();
const c = await connect();
const d = await connect();
const e = await connect();

const boards = {};
a.on('private_update', (p) => (boards.A = p));
b.on('private_update', (p) => (boards.B = p));
c.on('private_update', (p) => (boards.C = p));
d.on('private_update', (p) => (boards.D = p));

let room = null;
a.on('room_update', (r) => (room = r));

let bingoEvent = null;
a.on('bingo', (ev) => (bingoEvent = ev));

const idOf = (name) => room?.players.find((p) => p.name === name)?.id;

// ── create ────────────────────────────────────────────────────────────
const created = await call(a, 'create_room', {
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
assert(!dupe.ok && /taken/i.test(dupe.error), `duplicate name rejected -> "${dupe.error}"`);

const bad = await call(b, 'join_room', { code: 'ZZZZ', name: 'Bob' });
assert(!bad.ok, `unknown room code rejected -> "${bad.error}"`);

const blank = await call(b, 'join_room', { code, name: '   ' });
assert(!blank.ok, `blank name rejected -> "${blank.error}"`);

// ── joins ─────────────────────────────────────────────────────────────
const bobJoin = await call(b, 'join_room', { code, name: 'Bob' });
assert(bobJoin.ok, 'Bob joined');

const tooEarly = await call(a, 'start_game');
assert(!tooEarly.ok && /at least 3/.test(tooEarly.error), `start blocked with 2 players -> "${tooEarly.error}"`);

const carolJoin = await call(c, 'join_room', { code, name: 'Carol' });
assert(carolJoin.ok, 'Carol joined');
const carolToken = carolJoin.token;
await wait(150);

const notHost = await call(b, 'start_game');
assert(!notHost.ok && /host/i.test(notHost.error), `non-host cannot start -> "${notHost.error}"`);

// ── start ─────────────────────────────────────────────────────────────
console.log('\n… generating boards');
const t0 = Date.now();
const started = await call(a, 'start_game');
assert(started.ok, `game started in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!started.ok) {
  console.log('   error:', started.error);
  process.exit(1);
}
await wait(400);

// ── boards ────────────────────────────────────────────────────────────
const texts = (tag) => boards[tag].board.map((cell) => cell.text);
const aT = texts('A'), bT = texts('B'), cT = texts('C');
assert(aT.length === 9, `board has 9 squares (got ${aT.length})`);
assert(new Set(aT).size === 9, 'no repeated question inside one board');
const overlap = aT.filter((t) => bT.includes(t) || cT.includes(t));
assert(overlap.length === 0, `no question shared between players (overlap ${overlap.length})`);
assert(aT.every((t) => t.length <= 80), 'all questions within length limit');
console.log(`  room degraded flag: ${room.degraded} (true = Groq unavailable, bank used)`);
console.log("\n  Alice's card:");
aT.forEach((t, i) => console.log(`   ${i}. ${t}`));
console.log("  Bob's card (first 3):");
bT.slice(0, 3).forEach((t, i) => console.log(`   ${i}. ${t}`));

// ── late joiner gets their own board ─────────────────────────────────
assert((await call(d, 'join_room', { code, name: 'Dan' })).ok, 'Dan joined mid-game');
await wait(1500);
const dT = boards.D ? texts('D') : [];
assert(dT.length === 9, `late joiner received a full board (${dT.length} squares)`);
assert(!dT.some((t) => aT.includes(t)), 'late joiner questions differ from Alice\'s');

// ── marking rules ────────────────────────────────────────────────────
const bobId = idOf('Bob');
const carolId = idOf('Carol');
assert(Boolean(bobId && carolId), 'resolved Bob + Carol ids from room state');

assert((await call(a, 'mark_cell', { cellIndex: 0, targetId: bobId })).ok, 'cell 0 marked with Bob');

const selfMark = await call(a, 'mark_cell', { cellIndex: 1, targetId: idOf('Alice') });
assert(!selfMark.ok && /someone else/i.test(selfMark.error), `cannot use own name -> "${selfMark.error}"`);

const twice = await call(a, 'mark_cell', { cellIndex: 1, targetId: bobId });
assert(!twice.ok && /just used/i.test(twice.error), `same name twice in a row blocked -> "${twice.error}"`);

assert((await call(a, 'mark_cell', { cellIndex: 1, targetId: carolId })).ok, 'cell 1 marked with Carol');
await wait(100);
assert(boards.A.usage.bob === 1 && boards.A.usage.carol === 1, `usage map counts each name once (${JSON.stringify(boards.A.usage)})`);

const bobAgain = await call(a, 'mark_cell', { cellIndex: 4, targetId: bobId });
assert(bobAgain.ok, 'Bob usable again after someone else in between');

const clear = await call(a, 'clear_cell', { cellIndex: 4 });
assert(clear.ok, 'square cleared');
await wait(100);
assert(boards.A.lastUsedName === 'Carol', `last-used name recomputed after clear (${boards.A.lastUsedName})`);

// ── bingo on the top row ─────────────────────────────────────────────
assert((await call(a, 'mark_cell', { cellIndex: 2, targetId: bobId })).ok, 'cell 2 marked with Bob');
await wait(300);
assert(bingoEvent?.winner?.name === 'Alice', 'bingo event fired for Alice');
assert(boards.A.bingoLine?.join() === '0,1,2', `winning line = [${boards.A.bingoLine}]`);
assert(room.status === 'finished', `room status is finished (${room.status})`);

const afterWin = await call(a, 'mark_cell', { cellIndex: 3, targetId: carolId });
assert(!afterWin.ok && /not running/i.test(afterWin.error), `marking locked after win -> "${afterWin.error}"`);

// ── reconnect / token ────────────────────────────────────────────────
const wrongToken = await call(e, 'join_room', { code, name: 'Carol', token: 'deadbeef' });
assert(!wrongToken.ok && /taken/i.test(wrongToken.error), `wrong token for taken name rejected -> "${wrongToken.error}"`);

const reconnect = await call(e, 'join_room', { code, name: 'Carol', token: carolToken });
assert(reconnect.ok && reconnect.playerId === carolId, 'correct token reconnects as the same player');

// ── host keeps the role across a refresh ─────────────────────────────
const hostSock = await connect();
a.close();
await wait(500);
assert(room.hostId === created.playerId, `host role kept while host is offline (host=${room.players.find((p) => p.isHost)?.name})`);

hostSock.on('room_update', (r) => (room = r));
let hostBoard = null;
hostSock.on('private_update', (p) => (hostBoard = p));
const hostBack = await call(hostSock, 'join_room', { code, name: 'Alice', token: created.token });
assert(hostBack.ok && hostBack.playerId === created.playerId, 'host reconnected as the same player');
await wait(200);
assert(room.hostId === created.playerId, 'host role still belongs to Alice after reconnect');

// ── restart ──────────────────────────────────────────────────────────
assert((await call(hostSock, 'play_again')).ok, 'host restarted the room');
await wait(200);
assert(hostBoard?.board.length === 0, 'boards cleared on restart');
assert(room.status === 'lobby', `back in lobby (${room.status})`);

[b, c, d, e, hostSock].forEach((s) => s.close());
console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll checks passed.');
setTimeout(() => process.exit(process.exitCode || 0), 200);
