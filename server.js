/**
 * Local development server.
 *
 * In production this app runs as Vercel serverless functions (see /api) backed by
 * Vercel KV / Upstash. For local `npm start` we don't want to require any of that, so
 * this tiny Express app serves the static frontend and mounts the exact same /api
 * handlers. With no KV credentials the store falls back to in-process memory, which is
 * perfectly fine for a single local process.
 */
import 'dotenv/config';

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import action from './api/action.js';
import state from './api/state.js';
import qr from './api/qr.js';
import { usingRedis } from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());

// The same functions Vercel serves, at the same paths the client calls.
app.post('/api/action', action);
app.get('/api/state', state);
app.get('/api/qr', qr);
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`\n  Human Bingo running at http://localhost:${PORT}`);
  console.log(`  State store: ${usingRedis ? 'Redis (KV/Upstash)' : 'in-memory (local only)'}`);
  if (!process.env.GROQ_API_KEY) {
    console.warn('  WARNING: GROQ_API_KEY is not set - squares come from the built-in bank.');
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use by another process.`);
    console.error(`  Start on a different port with:  PORT=${PORT + 1} npm start\n`);
    process.exit(1);
  }
  throw err;
});
