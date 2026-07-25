/* Human Bingo client. Talks to the serverless API over plain fetch + short polling. */

const POLL_MS = 2000; // how often we refresh room + board state
const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'humanBingo.session';

const state = {
  room: null,      // public room snapshot
  me: null,        // { id, name, token, code }
  board: [],
  bingoLine: null,
  lastUsedName: null,
  usage: {},
  activeCell: null,
  winAcknowledged: false,
};

const nameKey = (name) =>
  String(name ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/* ── session persistence (survives a refresh) ───────────────── */
function saveSession() {
  if (!state.me) return sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.me));
}
function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

/* ── ui helpers ─────────────────────────────────────────────── */
function show(screen) {
  const target = $(`screen-${screen}`);
  // applyRoom re-runs on every poll, so bail if we're already on this screen -
  // otherwise the scroll-to-top below would yank you back up every couple of seconds.
  if (target.classList.contains('is-active')) return;
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('is-active'));
  target.classList.add('is-active');
  window.scrollTo({ top: 0 });
}

let toastTimer;
function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

/**
 * Run a game action. Sends the caller's session (once they have one) so the server can
 * authenticate them, and opportunistically applies any fresh room/board in the reply so
 * the player's own actions feel instant rather than waiting for the next poll.
 */
async function emit(action, payload = {}) {
  const session = state.me
    ? { code: state.me.code, playerId: state.me.id, token: state.me.token }
    : null;
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload, session }),
    });
    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, error: 'No response from server.' };
    if (state.me && data.ok) {
      if (data.room) applyRoom(data.room);
      if (data.private) applyPrivate(data.private);
    }
    return data;
  } catch {
    return { ok: false, error: 'No response from server.' };
  }
}

const inviteUrl = (code) => `${location.origin}${location.pathname}?room=${code}`;

/**
 * The clipboard API needs a secure context, and over plain http on a LAN address it may be
 * missing, denied, or just never settle while a permission prompt sits there. Time it out so
 * the player always gets feedback, and fall back to selecting the link for a manual copy.
 */
async function copyInvite(code) {
  const url = inviteUrl(code);
  const field = $('invite-link');
  const onLobby = $('screen-lobby').classList.contains('is-active');

  try {
    await Promise.race([
      navigator.clipboard.writeText(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1500)),
    ]);
    toast('Invite link copied');
  } catch {
    if (onLobby) {
      field.focus();
      field.select();
      toast('Link selected — press Ctrl+C to copy');
    } else {
      toast(url);
    }
  }
}

/* ── home / navigation ──────────────────────────────────────── */
$('go-create').onclick = () => show('create');
$('go-join').onclick = () => show('join');
document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.onclick = () => show(btn.dataset.back);
});

/* ── create form ────────────────────────────────────────────── */
let chosenSize = 4;
$('size-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.size');
  if (!btn) return;
  chosenSize = Number(btn.dataset.size);
  $('size-picker').querySelectorAll('.size').forEach((b) => b.classList.toggle('is-on', b === btn));
});

const chosenCategories = () =>
  [...$('category-picker').querySelectorAll('input:checked')].map((i) => i.value);

$('form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;

  const res = await emit('create_room', {
    name: $('create-name').value,
    size: chosenSize,
    categories: chosenCategories(),
    theme: $('create-theme').value,
  });

  btn.disabled = false;
  if (!res.ok) return toast(res.error, true);

  state.me = { id: res.playerId, token: res.token, code: res.code, name: $('create-name').value.trim() };
  saveSession();
  applyRoom(res.room);
  startPolling();
});

/* ── join form ──────────────────────────────────────────────── */
$('join-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

$('form-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;

  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  const res = await emit('join_room', { code, name });

  btn.disabled = false;
  if (!res.ok) return toast(res.error, true);

  state.me = { id: res.playerId, token: res.token, code: res.code, name };
  saveSession();
  applyRoom(res.room);
  if (res.private) applyPrivate(res.private);
  startPolling();
});

/* ── room code copy buttons ─────────────────────────────────── */
$('lobby-code').onclick = () => state.room && copyInvite(state.room.code);
$('game-code').onclick = () => state.room && copyInvite(state.room.code);
$('copy-invite').onclick = () => state.room && copyInvite(state.room.code);

/* ── lobby ──────────────────────────────────────────────────── */
function renderLobby() {
  const room = state.room;
  $('lobby-code').textContent = room.code;

  const catText = room.categories.length ? room.categories.join(', ') : 'everything';
  $('lobby-meta').innerHTML = `
    <div><b>${room.size}&times;${room.size}</b> grid</div>
    <div>${escapeHtml(catText)}</div>
    ${room.theme ? `<div>“${escapeHtml(room.theme)}”</div>` : ''}
  `;

  $('invite-link').value = inviteUrl(room.code);
  // Only reset the QR src when the room changes, so it doesn't reload on every lobby update.
  const qrSrc = `/api/qr?room=${encodeURIComponent(room.code)}`;
  if ($('qr-img').getAttribute('src') !== qrSrc) $('qr-img').src = qrSrc;

  // A localhost link is useless to anyone else on the network - say so rather than let
  // the host share a link that silently fails on their friends' phones.
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  $('invite-hint').hidden = !isLocal;
  $('invite-hint').textContent = isLocal
    ? "This link and QR only work on this computer. Reopen the app on your machine's network address to share them."
    : '';

  const isHost = room.hostId === state.me.id;
  $('role-note').hidden = !isHost;
  $('role-note').textContent = isHost
    ? "You're running this game, so you won't get a card and players can't use your name."
    : '';

  // The host is not a player, so they are not counted here or towards the minimum.
  $('lobby-count').textContent = room.players.filter((p) => p.isPlayer).length;
  $('lobby-players').innerHTML = room.players.map((p) => playerRow(p, false)).join('');

  const short = room.minPlayers - room.playerCount;
  $('lobby-need').textContent =
    short > 0
      ? `${short} more player${short > 1 ? 's' : ''} needed`
      : 'Ready when you are';

  const actions = $('lobby-actions');
  actions.innerHTML = '';

  if (isHost) {
    const start = document.createElement('button');
    start.className = 'btn btn-primary btn-lg';
    start.textContent = 'Start game';
    start.disabled = room.playerCount < room.minPlayers;
    start.onclick = async () => {
      start.disabled = true;
      const res = await emit('start_game');
      if (!res.ok) {
        toast(res.error, true);
        start.disabled = false;
      }
    };
    actions.append(start);
  } else {
    const waiting = document.createElement('p');
    waiting.className = 'hint';
    waiting.textContent = 'Waiting for the host to start…';
    actions.append(waiting);
  }

  const leave = document.createElement('button');
  leave.className = 'btn btn-danger';
  leave.textContent = 'Leave room';
  leave.onclick = leaveRoom;
  actions.append(leave);
}

function playerRow(p, withScore) {
  const isMe = p.id === state.me?.id;
  return `
    <li class="${p.connected ? '' : 'off'} ${isMe ? 'me' : ''}">
      <span class="dot"></span>
      <span class="who">${escapeHtml(p.name)}${isMe ? ' (you)' : ''}</span>
      ${p.isHost ? '<span class="tag host">Host &middot; not playing</span>' : ''}
      ${p.hasBingo ? '<span class="tag win">Bingo</span>' : ''}
      ${withScore && p.isPlayer ? `<span class="score">${p.marked}/${p.total}</span>` : ''}
    </li>`;
}

/* ── game board ─────────────────────────────────────────────── */
let lastBoardSignature = null;
let lastActionsSignature = null;

function renderGame() {
  renderGameChrome();

  const room = state.room;
  // The host has no card - renderGameChrome already put the scoreboard on screen for them.
  if (room.hostId === state.me.id) return;

  const board = $('board');
  const winSet = new Set(state.bingoLine || []);
  const locked = room.status !== 'playing';

  // Rebuilding the grid on every broadcast would swallow taps: a re-render between
  // mousedown and mouseup replaces the button, so no click event ever fires. Other
  // players' marks arrive constantly, so only touch the DOM when my board changed.
  const signature = [
    room.size,
    locked,
    (state.bingoLine || []).join(','),
    state.board.map((c) => `${c.text}${c.markedWith || ''}`).join(''),
  ].join('|');

  if (signature === lastBoardSignature) return;
  lastBoardSignature = signature;

  board.style.setProperty('--n', room.size);
  board.innerHTML = '';

  state.board.forEach((cell, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell';
    if (cell.markedWith) btn.classList.add('done');
    if (winSet.has(i)) btn.classList.add('win');
    btn.disabled = locked;

    const q = document.createElement('span');
    q.className = 'q';
    q.textContent = cell.text;
    btn.append(q);

    if (cell.markedWith) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = cell.markedWith;
      btn.append(who);
    }

    btn.onclick = () => (cell.markedWith ? confirmClear(i, cell) : openSheet(i, cell));
    board.append(btn);
  });
}

/** Everything around the grid. Safe to re-run on every update. */
function renderGameChrome() {
  const room = state.room;
  const iAmHost = room.hostId === state.me.id;
  $('game-code').textContent = room.code;

  // Host view: no card, no personal progress - just everyone else's scoreboard.
  $('board-wrap').hidden = iAmHost;
  $('host-panel').hidden = !iAmHost;
  $('toggle-scores').hidden = iAmHost;
  document.querySelector('.progress').hidden = iAmHost;
  if (iAmHost) {
    $('host-players').innerHTML = room.players
      .filter((p) => p.isPlayer)
      .map((p) => playerRow(p, true))
      .join('');
  }

  const total = state.board.length || room.size * room.size;
  const marked = state.board.filter((c) => c.markedWith).length;
  $('progress-fill').style.width = total ? `${(marked / total) * 100}%` : '0%';
  $('progress-text').textContent = `${marked} / ${total}`;

  const banner = $('game-banner');
  if (room.winner) {
    banner.hidden = false;
    banner.className = 'banner win';
    banner.textContent =
      room.winner.id === state.me.id
        ? 'You got BINGO! 🎉'
        : `${room.winner.name} got BINGO first.`;
  } else if (room.degraded) {
    banner.hidden = false;
    banner.className = 'banner';
    banner.textContent = 'Groq was unavailable, so some squares came from the built-in question bank.';
  } else if (state.lastUsedName) {
    banner.hidden = false;
    banner.className = 'banner';
    banner.textContent = `You just used ${state.lastUsedName} — pick someone else for your next square.`;
  } else {
    banner.hidden = true;
  }

  $('game-players').innerHTML = room.players.map((p) => playerRow(p, true)).join('');

  // Same reasoning as the grid: don't replace live buttons unless they actually change.
  const actionsSignature = `${room.status}|${room.hostId === state.me.id}`;
  if (actionsSignature === lastActionsSignature) return;
  lastActionsSignature = actionsSignature;

  const actions = $('game-actions');
  actions.innerHTML = '';
  if (room.status === 'finished' && iAmHost) {
    const again = document.createElement('button');
    again.className = 'btn btn-primary';
    again.textContent = 'Play again';
    again.onclick = async () => {
      const res = await emit('play_again');
      if (!res.ok) toast(res.error, true);
    };
    actions.append(again);
  }
  if (room.status === 'playing' && iAmHost) {
    // Stopping wipes everyone's marked squares, so require a confirming second tap.
    const stop = document.createElement('button');
    stop.className = 'btn';
    stop.textContent = 'Stop game';
    let armed = false;
    let armTimer;
    stop.onclick = async () => {
      if (!armed) {
        armed = true;
        stop.textContent = 'Tap again to end the round';
        stop.classList.add('btn-danger');
        armTimer = setTimeout(() => {
          armed = false;
          stop.textContent = 'Stop game';
          stop.classList.remove('btn-danger');
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      const res = await emit('stop_game');
      if (!res.ok) toast(res.error, true);
    };
    actions.append(stop);
  }
  const leave = document.createElement('button');
  leave.className = 'btn btn-danger';
  leave.textContent = 'Leave room';
  leave.onclick = leaveRoom;
  actions.append(leave);
}

$('toggle-scores').onclick = () => {
  const el = $('scores');
  el.hidden = !el.hidden;
  $('toggle-scores').textContent = el.hidden ? 'Players' : 'Hide';
};

/* ── pick-a-player sheet ────────────────────────────────────── */
function openSheet(index, cell) {
  state.activeCell = index;
  $('sheet-question').textContent = cell.text;
  $('sheet-search').value = '';
  $('sheet-search').hidden = state.room.players.length <= 8;
  renderPickList('');
  $('sheet').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
  state.activeCell = null;
}

document.querySelectorAll('[data-close-sheet]').forEach((el) => {
  el.onclick = closeSheet;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
});
$('sheet-search').addEventListener('input', (e) => renderPickList(e.target.value));

function renderPickList(filter) {
  const list = $('sheet-list');
  const needle = filter.trim().toLowerCase();
  const blocked = state.lastUsedName ? nameKey(state.lastUsedName) : null;

  const candidates = state.room.players
    .filter((p) => p.id !== state.me.id)
    .filter((p) => p.isPlayer) // the host runs the game and can't be put on a square
    .filter((p) => !needle || p.name.toLowerCase().includes(needle));

  if (!candidates.length) {
    list.innerHTML = '<li class="pick-empty">No matching players.</li>';
    return;
  }

  list.innerHTML = '';
  for (const p of candidates) {
    const used = state.usage[nameKey(p.name)] || 0;
    const isBlocked = blocked && nameKey(p.name) === blocked;

    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick';
    btn.disabled = Boolean(isBlocked);

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name + (p.connected ? '' : ' (offline)');
    btn.append(who);

    const note = document.createElement('span');
    note.className = 'note';
    if (isBlocked) note.textContent = 'just used';
    else if (used) note.textContent = `${used} square${used > 1 ? 's' : ''}`;
    btn.append(note);

    btn.onclick = () => mark(p.id);
    li.append(btn);
    list.append(li);
  }
}

async function mark(targetId) {
  const cellIndex = state.activeCell;
  if (cellIndex === null) return;
  closeSheet();
  const res = await emit('mark_cell', { cellIndex, targetId });
  if (!res.ok) toast(res.error, true);
}

async function confirmClear(index, cell) {
  if (state.room.status !== 'playing') return;
  const res = await emit('clear_cell', { cellIndex: index });
  if (res.ok) toast(`Cleared ${cell.markedWith} from that square`);
  else toast(res.error, true);
}

/* ── leaving ────────────────────────────────────────────────── */
async function leaveRoom() {
  await emit('leave_room');
  stopPolling();
  state.room = null;
  state.me = null;
  state.board = [];
  state.bingoLine = null;
  state.usage = {};
  state.lastUsedName = null;
  state.winAcknowledged = false;
  lastBoardSignature = null;
  lastActionsSignature = null;
  saveSession();
  closeSheet();
  $('overlay-win').hidden = true;
  $('overlay-loading').hidden = true;
  $('invite-note').hidden = true;
  // Drop ?room= so a refresh after leaving doesn't drag you back to the join screen.
  if (location.search) history.replaceState(null, '', location.pathname);
  show('home');
}

/* ── applying server state ──────────────────────────────────── */
function applyRoom(room) {
  const previousStatus = state.room?.status;
  state.room = room;
  if (room.status === 'lobby') {
    // Back in the lobby after a restart: clear the result overlay from the last game.
    state.winAcknowledged = false;
    $('overlay-win').hidden = true;
  }

  $('overlay-loading').hidden = room.status !== 'generating';

  if (room.status === 'lobby') {
    show('lobby');
    renderLobby();
  } else if (room.status === 'generating') {
    if (previousStatus === 'lobby' || !previousStatus) {
      show('lobby');
      renderLobby();
    }
  } else {
    show('game');
    renderGame();
  }

  // The win is announced via the room's winner field now (no separate push event).
  if (room.winner && !state.winAcknowledged) {
    state.winAcknowledged = true;
    const mine = room.winner.id === state.me?.id;
    $('win-title').textContent = mine ? 'BINGO!' : 'Game over';
    $('win-sub').textContent = mine
      ? 'You completed a line first. Nicely mingled.'
      : `${room.winner.name} completed a line first.`;
    $('overlay-win').hidden = false;
  }
}

function applyPrivate(payload) {
  if (!payload) return;
  state.board = payload.board || [];
  state.bingoLine = payload.bingoLine;
  state.lastUsedName = payload.lastUsedName;
  state.usage = payload.usage || {};
  if (state.room && state.room.status !== 'lobby' && state.room.status !== 'generating') {
    renderGame();
    if (!$('sheet').hidden) renderPickList($('sheet-search').value);
  }
}

$('win-close').onclick = () => {
  $('overlay-win').hidden = true;
};

/* ── invite links (?room=CODE) ──────────────────────────────── */
const invitedCode = (new URLSearchParams(location.search).get('room') || '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '')
  .slice(0, 4);

if (invitedCode) {
  const saved = loadSession();
  // Following an invite to a different room means leaving whatever this tab was in.
  if (!saved || saved.code !== invitedCode) {
    sessionStorage.removeItem(SESSION_KEY);
    state.me = null;
    $('join-code').value = invitedCode;
    $('invite-note').hidden = false;
    $('invite-note').textContent = `You've been invited to room ${invitedCode}. Enter your name to join.`;
    show('join');
    $('join-name').focus();
  }
}

/* ── polling ────────────────────────────────────────────────── */
let pollTimer = null;
let pollFails = 0;

async function pollOnce() {
  if (!state.me) return;
  const qs = new URLSearchParams({
    code: state.me.code,
    playerId: state.me.id,
    token: state.me.token,
  });
  try {
    const res = await fetch(`/api/state?${qs}`, { headers: { 'Cache-Control': 'no-cache' } });
    const data = await res.json();
    if (data.ok) {
      pollFails = 0;
      if (data.room) applyRoom(data.room);
      if (data.private) applyPrivate(data.private);
    } else if (data.gone) {
      // Removed from the room, or the room expired - drop back home cleanly.
      endSession(data.error || 'This room has closed.');
    }
  } catch {
    // A couple of missed polls are normal; only nag if it persists.
    if (++pollFails === 3) toast('Connection hiccup — retrying…', true);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollOnce, POLL_MS);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Wipe local session state and return to the home screen (used when the room is gone). */
function endSession(message) {
  stopPolling();
  if (message) toast(message, true);
  state.room = null;
  state.me = null;
  state.board = [];
  state.bingoLine = null;
  state.usage = {};
  state.lastUsedName = null;
  state.winAcknowledged = false;
  lastBoardSignature = null;
  lastActionsSignature = null;
  sessionStorage.removeItem(SESSION_KEY);
  closeSheet();
  $('overlay-win').hidden = true;
  $('overlay-loading').hidden = true;
  if (location.search) history.replaceState(null, '', location.pathname);
  show('home');
}

/* ── resume an existing session on load / refresh ───────────── */
async function boot() {
  const saved = state.me || loadSession();
  if (!saved) return;

  const res = await emit('join_room', { code: saved.code, name: saved.name, token: saved.token });
  if (!res.ok) {
    sessionStorage.removeItem(SESSION_KEY);
    state.me = null;
    return; // stay on whatever screen we're on (home, or the invite join screen)
  }
  state.me = { id: res.playerId, token: res.token, code: res.code, name: saved.name };
  saveSession();
  applyRoom(res.room);
  if (res.private) applyPrivate(res.private);
  startPolling();
}

boot();

/* ── util ───────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
