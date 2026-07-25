# Human Bingo

An online icebreaker. The host creates a room, everyone joins from their own phone with a
4-letter code, and each player gets a bingo card where **every square is a statement about a
person** — "Plays a musical instrument", "Has visited more than 3 countries". You walk around,
talk to people, and when someone matches a square you tap it and pick their name.

First player to complete a full row, column or diagonal wins.

**The host runs the game and does not play.** They get no card, nobody can put their name on a
square, and their screen is a live scoreboard of everyone's progress instead of a grid.

Every player's questions are generated separately by **Groq**, so no two cards share a single
square.

## Setup

```bash
npm install
cp .env.example .env       # then paste your key into .env
npm start
```

Open http://localhost:3000. Get a free API key at https://console.groq.com/keys.

To play across phones on the same wifi, find your machine's LAN address
(`hostname -I` on Linux, `ipconfig getifaddr en0` on macOS) and have everyone open
`http://<that-address>:3000`.

### Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `GROQ_API_KEY` | — | Required. Without it the server falls back to a small built-in question bank and shows a warning in the room. |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Any Groq chat model. |
| `PORT` | `3000` | Local dev server only. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Redis (Vercel KV / Upstash) credentials. Set automatically when you add the integration on Vercel. Only needed for the serverless deployment; local dev keeps rooms in memory. `UPSTASH_REDIS_REST_URL` / `_TOKEN` are also accepted. |

## Inviting people

The lobby shows an invite link — `http://<host>:3000/?room=SSSZ` — with a **Copy link** button
and a **QR code** underneath. Anyone can point a phone camera at the QR to open the join screen;
tapping the big room code (in the lobby or during the game) copies the same link.

The QR is served by `GET /api/qr?room=CODE` as an SVG. The server rebuilds the invite URL from
the `Host` header the browser used, so the QR encodes exactly the address the host is on — LAN
IP and port included — without the server having to know its own hostname.

Opening that link drops the player straight onto the join screen with the code already filled
in and the cursor in the name box, so all they do is type a name and tap Join. They can still
join the old way by typing the 4-letter code by hand.

Details worth knowing:

- If you are running on `localhost`, the lobby warns you that the link only works on your own
  machine. Reopen the app on your LAN address so the link is shareable.
- Following an invite to a *different* room leaves whatever room that tab was in.
- Refreshing on an invite URL reconnects you to your existing board rather than asking for a
  name again.
- A link to a room that no longer exists leaves you on the join screen with "No room with that
  code."
- Copying falls back to selecting the link for a manual Ctrl+C if the browser blocks clipboard
  access, which it does over plain http on a LAN address.

## Rules

- **Grid size** — the host picks 3×3, 4×4, 5×5 or 6×6 when creating the room.
- **The host doesn't play.** No card, and they can't be named on anyone's square. Their game
  screen is a scoreboard, and they keep the Start / Play again controls.
- **Minimum 3 players, not counting the host** — so four people in the room. The "not twice in
  a row" rule below means each player needs two others to alternate between, so the server
  blocks a smaller start.
- **Names are unique per room**, compared case-insensitively — a second "tony" is refused while
  "Tony" is in the room.
- **Marking is trust-based.** Tap a square, pick a player, it marks immediately. Nobody has to
  confirm.
- **You can reuse a name, but never twice in a row.** After you put Mai on a square, your next
  square must be someone else; Mai is greyed out in the picker until then.
- **You can't use your own name.**
- **Tap a filled square to clear it** if you made a mistake.
- **Winning** — first full row, column or diagonal. The room announces the winner and locks;
  the host can then start a fresh round with new questions.

## Question generation

The host picks any of six categories (hobbies, personality, travel, food, skills, quirky) and
can add a free-text theme like "remote dev team" or "university freshers", which Groq uses to
tailor every square.

For a room of P players on an N×N grid the server needs P×N×N distinct statements. It requests
them in parallel batches of 20, each batch nudged toward a different angle, then dedupes
globally (case- and punctuation-insensitive) and deals every player a disjoint slice. Short
batches trigger up to two top-up rounds. If Groq is unreachable the room still starts, filled
from `FALLBACK_BANK` in `lib/questions.js`, and every player sees a banner saying so.

Players who join mid-game get their own board generated on the spot, excluding every question
already in play.

## Tests

With the server running (`npm start`) in one terminal:

```bash
npm test
```

`test/smoke.mjs` drives a real 3-player game over the HTTP API and asserts every rule above:
duplicate names, the 3-player minimum, per-player question uniqueness, self-marking, the
not-twice-in-a-row rule, clearing squares, bingo detection, late joiners, token reconnects and
host retention across a refresh.

## Layout

```
api/action.js       one endpoint for every game action (create/join/mark/...)
api/state.js        poll + presence heartbeat the client hits every 2s
api/qr.js           invite QR as an SVG
lib/engine.js       all rule enforcement, operating on the store
lib/store.js        room persistence: Redis (KV/Upstash) or in-memory for local dev
lib/game.js         room codes, name matching, bingo detection, serialisation
lib/questions.js    Groq calls, dedupe, fallback bank
server.js           local dev server — serves public/ and mounts the api/ handlers
public/             single-page client (no build step, no dependencies)
```

The client is a plain fetch + short-polling app (no WebSockets), so it runs on stateless
serverless platforms. See **[DEPLOY.md](DEPLOY.md)** for deploying to Vercel.

Rooms live in the store and expire 6 hours after their last activity. Locally that store is an
in-process map (restarting drops rooms); in production it's Redis, shared across instances.

Reconnects are handled: each player holds a token in `sessionStorage`, so refreshing the page
puts you back on your own board. A host who refreshes keeps the host role.

Host handover is deliberately cautious, because becoming host now means losing your card. If
the host leaves or stays disconnected past 45 seconds, the role passes to the longest-present
player — but **only in the lobby or after a round has finished**. A room whose host vanishes
mid-round plays on to the end untouched, and picks a new host once someone wins. Nobody's card
is ever taken away mid-game.
