/**
 * Drives a real game against a running server (npm start) over the HTTP API and
 * asserts every rule: the non-playing host, duplicate names, per-player question
 * uniqueness, the not-twice-in-a-row rule, bingo detection and reconnects.
 *
 * A "session" here is just { code, playerId, token }; there are no sockets. Actions
 * return the fresh room + the caller's private board, and /api/state is polled when a
 * specific player's view is needed.
 */
const BASE = process.env.URL || 'http://localhost:3000';

const call = async (session, action, payload = {}) => {
  const res = await fetch(`${BASE}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload, session }),
  });
  return res.json();
};

const stateOf = async (session) => {
  const qs = new URLSearchParams(session);
  const res = await fetch(`${BASE}/api/state?${qs}`);
  return res.json();
};

const sessionFrom = (res) => ({ code: res.code, playerId: res.playerId, token: res.token });

const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── create ────────────────────────────────────────────────────────────
const created = await call(null, 'create_room', {
  name: 'Alice',
  size: 3,
  categories: ['hobbies', 'skills'],
  theme: 'small startup team',
});
assert(created.ok && /^[A-Z0-9]{4}$/.test(created.code), `room created (code ${created.code})`);
const hostS = sessionFrom(created);
const code = created.code;
let room = created.room;

const refresh = async (session = hostS) => {
  room = (await stateOf(session)).room;
  return room;
};
const idOf = (name) => room?.players.find((p) => p.name === name)?.id;

// ── names ─────────────────────────────────────────────────────────────
const dupe = await call(null, 'join_room', { code, name: 'alice' });
assert(!dupe.ok && /taken/i.test(dupe.error), `host's name is reserved too -> "${dupe.error}"`);

const bad = await call(null, 'join_room', { code: 'ZZZZ', name: 'Bob' });
assert(!bad.ok, `unknown room code rejected -> "${bad.error}"`);

const blank = await call(null, 'join_room', { code, name: '   ' });
assert(!blank.ok, `blank name rejected -> "${blank.error}"`);

// ── the host does not count towards the minimum ──────────────────────
const bobJoin = await call(null, 'join_room', { code, name: 'Bob' });
assert(bobJoin.ok, 'Bob joined');
const bS = sessionFrom(bobJoin);

const carolJoin = await call(null, 'join_room', { code, name: 'Carol' });
assert(carolJoin.ok, 'Carol joined');
const cS = sessionFrom(carolJoin);
const carolToken = carolJoin.token;

await refresh();
assert(room.playerCount === 2, `host excluded from the player count (${room.playerCount})`);
const tooEarly = await call(hostS, 'start_game');
assert(
  !tooEarly.ok && /at least 3 players besides yourself/.test(tooEarly.error),
  `start blocked with host + 2 players -> "${tooEarly.error}"`
);

const danJoin = await call(null, 'join_room', { code, name: 'Dan' });
assert(danJoin.ok, 'Dan joined');
const dS = sessionFrom(danJoin);
await refresh();
assert(room.playerCount === 3, `three players now (${room.playerCount})`);

const notHost = await call(bS, 'start_game');
assert(!notHost.ok && /host/i.test(notHost.error), `non-host cannot start -> "${notHost.error}"`);

// ── start ─────────────────────────────────────────────────────────────
console.log('\n… generating boards');
const t0 = Date.now();
const started = await call(hostS, 'start_game');
assert(started.ok, `game started in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!started.ok) {
  console.log('   error:', started.error);
  process.exit(1);
}
room = started.room;

// ── the host gets no card ────────────────────────────────────────────
const hostState = await stateOf(hostS);
assert(hostState.private === null, 'host has no card');
const hostEntry = room.players.find((p) => p.name === 'Alice');
assert(hostEntry.isHost && !hostEntry.isPlayer, 'host is flagged as a non-player');

// ── boards ────────────────────────────────────────────────────────────
const boards = {
  B: (await stateOf(bS)).private,
  C: (await stateOf(cS)).private,
  D: (await stateOf(dS)).private,
};
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

const markHost = await call(bS, 'mark_cell', { cellIndex: 0, targetId: aliceId });
assert(
  !markHost.ok && /running the game/i.test(markHost.error),
  `host can't be put on a square -> "${markHost.error}"`
);

const hostMarks = await call(hostS, 'mark_cell', { cellIndex: 0, targetId: bobId });
assert(
  !hostMarks.ok && /don't have a card/i.test(hostMarks.error),
  `host can't mark squares -> "${hostMarks.error}"`
);

// ── marking rules ────────────────────────────────────────────────────
assert((await call(bS, 'mark_cell', { cellIndex: 0, targetId: carolId })).ok, 'cell 0 marked with Carol');

const selfMark = await call(bS, 'mark_cell', { cellIndex: 1, targetId: bobId });
assert(!selfMark.ok && /someone else/i.test(selfMark.error), `cannot use own name -> "${selfMark.error}"`);

const twice = await call(bS, 'mark_cell', { cellIndex: 1, targetId: carolId });
assert(!twice.ok && /just used/i.test(twice.error), `same name twice in a row blocked -> "${twice.error}"`);

const markDan = await call(bS, 'mark_cell', { cellIndex: 1, targetId: danId });
assert(markDan.ok, 'cell 1 marked with Dan');
assert(
  markDan.private.usage.carol === 1 && markDan.private.usage.dan === 1,
  `usage map counts each name once (${JSON.stringify(markDan.private.usage)})`
);

assert((await call(bS, 'mark_cell', { cellIndex: 4, targetId: carolId })).ok, 'Carol usable again after Dan');

const clear = await call(bS, 'clear_cell', { cellIndex: 4 });
assert(clear.ok, 'square cleared');
assert(clear.private.lastUsedName === 'Dan', `last-used name recomputed after clear (${clear.private.lastUsedName})`);

// ── bingo on the top row ─────────────────────────────────────────────
const winMark = await call(bS, 'mark_cell', { cellIndex: 2, targetId: carolId });
assert(winMark.ok, 'cell 2 marked with Carol');
assert(winMark.room.winner?.name === 'Bob', 'winner recorded as Bob');
assert(winMark.private.bingoLine?.join() === '0,1,2', `winning line = [${winMark.private.bingoLine}]`);
assert(winMark.room.status === 'finished', `room status is finished (${winMark.room.status})`);

const afterWin = await call(bS, 'mark_cell', { cellIndex: 3, targetId: danId });
assert(!afterWin.ok && /not running/i.test(afterWin.error), `marking locked after win -> "${afterWin.error}"`);

// ── reconnect / token ────────────────────────────────────────────────
const wrongToken = await call(null, 'join_room', { code, name: 'Carol', token: 'deadbeef' });
assert(!wrongToken.ok && /taken/i.test(wrongToken.error), `wrong token rejected -> "${wrongToken.error}"`);

const reconnect = await call(null, 'join_room', { code, name: 'Carol', token: carolToken });
assert(reconnect.ok && reconnect.playerId === carolId, 'correct token reconnects as the same player');

// ── host keeps the role across a refresh ─────────────────────────────
await refresh(bS); // read the room as Bob, without the host heartbeating
assert(room.hostId === created.playerId, 'host role kept while host is offline');

const hostBack = await call(null, 'join_room', { code, name: 'Alice', token: created.token });
assert(hostBack.ok && hostBack.playerId === created.playerId, 'host reconnected as the same player');
await refresh();
assert(room.hostId === created.playerId, 'host role still belongs to Alice after reconnect');

// ── restart ──────────────────────────────────────────────────────────
const again = await call(hostS, 'play_again');
assert(again.ok, 'host restarted the room');
assert(again.room.status === 'lobby', `back in lobby (${again.room.status})`);
const hostAfter = await stateOf(hostS);
assert(hostAfter.private === null, 'host still has no card after restart');

// ── host can stop a game early ────────────────────────────────────────
await Promise.all([stateOf(bS), stateOf(cS), stateOf(dS)]); // refresh presence before restart
const restart = await call(hostS, 'start_game');
assert(restart.ok, 'game started again for the stop-game check');

const notHostStop = await call(bS, 'stop_game');
assert(!notHostStop.ok && /host/i.test(notHostStop.error), `non-host cannot stop -> "${notHostStop.error}"`);

const stopped = await call(hostS, 'stop_game');
assert(stopped.ok && stopped.room.status === 'lobby', `host stopped the game -> lobby (${stopped.room?.status})`);

const stopAgain = await call(hostS, 'stop_game');
assert(!stopAgain.ok && /not running/i.test(stopAgain.error), `stopping in the lobby is rejected -> "${stopAgain.error}"`);

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll checks passed.');
process.exit(process.exitCode || 0);
