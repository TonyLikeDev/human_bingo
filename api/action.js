/**
 * Single entry point for every game action. The client POSTs
 *   { action, payload, session }
 * where `session` is { code, playerId, token } for an in-room player (null before
 * they've joined). We merge the two into the input each engine action expects.
 *
 * Written with the plain (req, res) subset shared by Vercel functions and Express,
 * so the local dev server (server.js) mounts this exact handler.
 */
import { ACTIONS } from '../lib/engine.js';
import { getStore } from '../lib/store.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body || '{}');
    } catch {
      return {};
    }
  }
  return req.body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const { action, payload = {}, session = null } = parseBody(req);
  const fn = ACTIONS[action];
  if (!fn) return res.status(400).json({ ok: false, error: 'Unknown action.' });

  // session (code/playerId/token) first, so payload can still carry code/name/token on join.
  const input = { ...(session || {}), ...(payload || {}) };

  try {
    const result = await fn(getStore(), input);
    return res.status(200).json(result);
  } catch (err) {
    console.error(`[action ${action}]`, err);
    return res.status(200).json({ ok: false, error: err.message || 'Server error.' });
  }
}

// start_game runs the (potentially slow) Groq generation inline; its 60s maxDuration
// is set in vercel.json.
