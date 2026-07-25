# Deploying Human Bingo to Vercel

The whole app runs on Vercel: the frontend in `public/` is served as static files, and
everything server-side (`/api/action`, `/api/state`, `/api/qr`) runs as serverless functions.

Because serverless functions are stateless and don't share memory, rooms are kept in **Redis**
(Vercel KV / Upstash) instead of a process-local map, and the client uses short polling instead
of WebSockets (which Vercel serverless can't hold open). `vercel.json` already wires the static
site + functions together — you don't need to configure a build.

## Steps

1. **Import the repo** into Vercel (New Project → pick this repository → Deploy). No framework,
   no build command — `vercel.json` handles it.

2. **Add a Redis store.** In the project: **Storage → Create Database → KV** (Upstash Redis).
   Connect it to the project. This injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` as
   environment variables automatically. (An existing Upstash database works too — its
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are also accepted.)

3. **Add your Groq key.** Project → **Settings → Environment Variables**:
   - `GROQ_API_KEY` = your key from https://console.groq.com/keys
   - `GROQ_MODEL` (optional) = a Groq chat model; defaults to `llama-3.3-70b-versatile`.

4. **Redeploy** so the new environment variables take effect (Deployments → ⋯ → Redeploy).

That's it — open the deployment URL and create a room. The invite link and QR point at the
same Vercel URL, so players just scan and join.

## Notes

- **No Redis = broken multiplayer.** Without KV/Upstash credentials the functions fall back to
  in-memory state, which is *not* shared between serverless instances, so two players can land
  on different instances and never see each other. The database in step 2 is required. (The
  in-memory fallback exists only so local `npm start` needs no external service.)
- **Free tiers are fine.** Vercel Hobby + Upstash free tier comfortably run this. Board
  generation calls Groq inline on `start_game`; the function's `maxDuration` is set to 60s.
- **Custom domain / another host for the frontend?** Set `PUBLIC_ORIGIN` to that URL so the QR
  and invite links point there instead of the deployment's default domain.

## Local development

`npm start` runs `server.js`, a tiny Express server that serves `public/` and mounts the same
`/api` handlers. With no Redis credentials it keeps rooms in memory — no external service
needed. Open http://localhost:3000.
