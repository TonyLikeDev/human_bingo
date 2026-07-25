/**
 * Poll endpoint. The client hits this every couple of seconds; it doubles as the
 * presence heartbeat (getState bumps the caller's lastSeen). Returns the public room
 * plus the caller's private board, or { gone: true } once they're no longer a member.
 */
import { getState } from '../lib/engine.js';
import { getStore } from '../lib/store.js';

export default async function handler(req, res) {
  const code = String(req.query.code || '').toUpperCase();
  const playerId = String(req.query.playerId || '');
  const token = String(req.query.token || '');
  if (!code || !playerId || !token) {
    return res.status(400).json({ ok: false, error: 'Missing session.' });
  }

  try {
    const result = await getState(getStore(), { code, playerId, token });
    // Don't let a client cache game state.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[state]', err);
    return res.status(200).json({ ok: false, error: err.message || 'Server error.' });
  }
}
