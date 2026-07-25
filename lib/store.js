/**
 * Room persistence for a serverless deployment.
 *
 * Vercel functions are stateless and don't share memory, so rooms live in Redis
 * (Vercel KV / Upstash) instead of a process-local Map. When no Redis credentials
 * are present we fall back to an in-process store so `npm start` still works locally
 * with no external service - that fallback is single-process only and must never be
 * relied on in a real (multi-instance) deployment.
 *
 * Two keys per room:
 *   room:{CODE}  - the full room JSON (written only on real mutations)
 *   seen:{CODE}  - a hash of playerId -> lastSeen(ms), bumped on every heartbeat so
 *                  presence updates never rewrite the whole room and race with marks.
 */

const TTL_SEC = 6 * 60 * 60; // rooms/presence expire 6h after the last write

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const usingRedis = Boolean(REST_URL && REST_TOKEN);

/* ── serialisation ──────────────────────────────────────────────────────── */
// The live room keeps players in a Map and (in the socket world) carried timers and
// socket ids; none of that survives JSON, so we store a plain, minimal shape.
function serialize(room) {
  return JSON.stringify({
    code: room.code,
    size: room.size,
    theme: room.theme,
    categories: room.categories,
    status: room.status,
    hostId: room.hostId,
    winner: room.winner ? { id: room.winner.id, name: room.winner.name } : null,
    degraded: room.degraded,
    lastActivity: room.lastActivity,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      token: p.token,
      name: p.name,
      board: p.board || [],
      history: p.history || [],
      bingoLine: p.bingoLine ?? null,
      joinedAt: p.joinedAt,
    })),
  });
}

function deserialize(json) {
  const r = typeof json === 'string' ? JSON.parse(json) : json;
  const players = new Map();
  for (const p of r.players || []) {
    // `connected` is derived from the seen-hash at load time, never stored.
    players.set(p.id, { ...p, connected: false, lastSeen: 0 });
  }
  return { ...r, players };
}

/* ── Redis (Upstash REST) ───────────────────────────────────────────────── */
async function cmd(args) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`Redis ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return data.result;
}

const redisStore = {
  async getRoom(code) {
    const json = await cmd(['GET', `room:${code}`]);
    return json ? deserialize(json) : null;
  },
  async putRoom(room) {
    await cmd(['SET', `room:${room.code}`, serialize(room), 'EX', String(TTL_SEC)]);
  },
  async putRoomNX(room) {
    const r = await cmd(['SET', `room:${room.code}`, serialize(room), 'NX', 'EX', String(TTL_SEC)]);
    return r === 'OK';
  },
  async delRoom(code) {
    await cmd(['DEL', `room:${code}`]);
    await cmd(['DEL', `seen:${code}`]);
  },
  async touchSeen(code, playerId, ts) {
    await cmd(['HSET', `seen:${code}`, playerId, String(ts)]);
    await cmd(['EXPIRE', `seen:${code}`, String(TTL_SEC)]);
  },
  async getSeen(code) {
    const flat = (await cmd(['HGETALL', `seen:${code}`])) || [];
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]);
    return out;
  },
  async remSeen(code, playerId) {
    await cmd(['HDEL', `seen:${code}`, playerId]);
  },
};

/* ── in-memory fallback (local dev only) ────────────────────────────────── */
const mem = { rooms: new Map(), seen: new Map() };

const memStore = {
  async getRoom(code) {
    const json = mem.rooms.get(code);
    return json ? deserialize(json) : null;
  },
  async putRoom(room) {
    mem.rooms.set(room.code, serialize(room));
  },
  async putRoomNX(room) {
    if (mem.rooms.has(room.code)) return false;
    mem.rooms.set(room.code, serialize(room));
    return true;
  },
  async delRoom(code) {
    mem.rooms.delete(code);
    mem.seen.delete(code);
  },
  async touchSeen(code, playerId, ts) {
    let h = mem.seen.get(code);
    if (!h) mem.seen.set(code, (h = new Map()));
    h.set(playerId, ts);
  },
  async getSeen(code) {
    return Object.fromEntries(mem.seen.get(code) || []);
  },
  async remSeen(code, playerId) {
    mem.seen.get(code)?.delete(playerId);
  },
};

let warned = false;
export function getStore() {
  if (usingRedis) return redisStore;
  if (!warned && process.env.VERCEL) {
    warned = true;
    console.warn(
      '[store] No KV/Upstash credentials found on Vercel - falling back to in-memory state, ' +
        'which does NOT work across serverless instances. Add a Vercel KV / Upstash integration.'
    );
  }
  return memStore;
}

export { TTL_SEC };
