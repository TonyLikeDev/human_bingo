# Deploying Human Bingo (Vercel frontend + external socket server)

Vercel's serverless platform can't run a persistent WebSocket server or hold in-memory
room state, so this app is deployed in two pieces:

- **Frontend** (`public/`) — static, on **Vercel**.
- **Realtime server** (`server.js`) — a long-lived Node process, on **Render / Railway / Fly.io**.

## 1. Deploy the server (Render example)

1. New **Web Service** → connect this repo.
2. Build command: `npm install` — Start command: `npm start`.
3. Environment variables:
   - `GROQ_API_KEY` — your Groq key (required for question generation).
   - `CLIENT_ORIGIN` — your Vercel URL, e.g. `https://human-bingo.vercel.app`
     (comma-separate if you have several; controls who may connect).
   - `PUBLIC_ORIGIN` — same Vercel URL. Makes the QR code / invite link send players
     to the Vercel frontend instead of to this server.
   - `PORT` is provided by the host automatically — don't set it.
4. Deploy, then note the service URL, e.g. `https://human-bingo.onrender.com`.

## 2. Point the frontend at the server

Edit `public/config.js` and set the server URL (no trailing slash):

```js
window.BINGO_SERVER = "https://human-bingo.onrender.com";
```

Commit this change.

## 3. Deploy the frontend on Vercel

Import the repo. `vercel.json` already tells Vercel to serve `public/` as a static site
(no build step). No environment variables are needed on Vercel.

## Local development (unchanged)

Leave `window.BINGO_SERVER = ""`. Then `npm start` serves the page and the socket server
together on `http://localhost:3000` — same as before.
