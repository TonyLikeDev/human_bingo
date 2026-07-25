# Human Bingo — Project Specification

A complete description of this project, written so it can be rebuilt from scratch without
reading the existing source. Everything below reflects the app as it currently stands.

---

## 1. What it is

An online **Human Bingo** icebreaker for a room full of people, played on phones.

- A **host** creates a room and gets a 4-letter code.
- Everyone else joins from their own phone with that code (or by scanning a QR).
- Each player receives a bingo card where **every square is a statement about a person** —
  "Plays a musical instrument", "Has visited more than 3 countries".
- Players walk around and talk to each other. When someone matches a square, you tap the
  square and pick that person's name from a list.
- First player to complete a full **row, column or diagonal** wins.

Two design decisions define the whole app:

1. **The host runs the game and does not play.** No card, nobody may put their name on a
   square, and their game screen is a live scoreboard instead of a grid.
2. **Every player's questions are generated separately by an LLM (Groq)**, so no two cards in
   a room share a single square.

---

## 2. Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js, ESM (`"type": "module"`) | — |
| Local server | Express 4 | Serves `public/` and mounts the same `/api` handlers Vercel runs |
| Production | Vercel serverless functions + static `public/` | No build step |
| State | Redis over Upstash REST (Vercel KV / Upstash), in-memory fallback | Serverless instances share no memory |
| Realtime | **Short polling every 2s over plain `fetch`** — *no WebSockets* | Vercel serverless can't hold sockets open |
| Questions | Groq chat completions (`llama-3.3-70b-versatile` by default) | Fast, cheap, free tier |
| QR | `qrcode` npm package, rendered as SVG | — |
| Frontend | One HTML file + one CSS file + one JS file, **no framework, no build, no dependencies** | — |

Dependencies are only: `express`, `dotenv`, `qrcode`.

---

## 3. Game rules (the authoritative list)

- **Grid size** — the host picks 3×3, 4×4, 5×5 or 6×6 at room creation; changeable in the
  lobby only.
- **The host doesn't play.** No card; can't be marked on anyone's square; can't mark.
- **Minimum 3 players *besides* the host** (so 4 people in the room). Rationale: the
  "not twice in a row" rule means each player needs at least two other people to alternate
  between, so the server refuses to start with fewer. Only *connected* players count.
- **Names are unique per room**, compared case- **and accent-insensitively** — a second
  "tony" is refused while "Tony" is present, and so is "Tóny".
- **Marking is trust-based.** Tap a square, pick a player, it marks immediately. No
  confirmation from the other person.
- **You may reuse a name, but never twice in a row.** After putting Mai on a square, the next
  square must be someone else. Mai is greyed out in the picker (labelled "just used") until
  another name is used.
- **You can't use your own name.**
- **Tap a filled square to clear it** (mistake recovery). Clearing also resets that player's
  `bingoLine`.
- **Winning** — first full row, column or diagonal. The room records the winner, status flips
  to `finished` and the room locks. The host can start a fresh round with brand-new questions.
- **Late joiners** get their own freshly generated board on the spot, excluding every question
  already in play in that room.
- **Rooms expire 6 hours after their last activity.**
- A room caps at **60 players**.

---

## 4. Repository layout

```
api/action.js       one POST endpoint for every game action (create/join/mark/...)
api/state.js        GET poll + presence heartbeat, hit by every client every 2s
api/qr.js           GET invite QR as an SVG
lib/engine.js       all rule enforcement; operates on the store, transport-agnostic
lib/store.js        room persistence: Redis (KV/Upstash) or in-memory for local dev
lib/game.js         pure helpers: room codes, name matching, bingo detection, serialisation
lib/questions.js    Groq calls, prompt, dedupe, fallback bank
server.js           local dev server — serves public/ and mounts the api/ handlers
public/index.html   all five screens, the pick sheet, overlays
public/style.css    dark theme, CSS custom properties, mobile-first
public/app.js       the entire client: state, rendering, polling, session
test/smoke.mjs      end-to-end test driving a real 3-player game over HTTP
vercel.json         static + functions wiring, maxDuration 60
render.yaml         alternative single-process deploy (no database needed)
```

**Dependency direction:** `api/*` → `lib/engine.js` → `lib/{game,questions,store}.js`.
`lib/game.js` is pure and has no I/O. `lib/engine.js` never touches HTTP.

---

## 5. Data model

### Room (in memory, after load)

```js
{
  code: 'XKPQ',              // 4 chars
  size: 4,                   // 3 | 4 | 5 | 6
  theme: 'remote dev team',  // free text, max 120 chars
  categories: ['hobbies', 'quirky'],
  status: 'lobby',           // 'lobby' | 'generating' | 'playing' | 'finished'
  hostId: '<playerId>',
  players: Map<playerId, Player>,
  winner: { id, name } | null,
  degraded: false,           // true when the fallback bank had to be used
  lastActivity: <ms>,
}
```

### Player

```js
{
  id: '<16 hex>',            // randomBytes(8)
  token: '<32 hex>',         // randomBytes(16) — the auth secret, never broadcast
  name: 'Mai',
  board: [{ text: 'Plays guitar', markedWith: null | 'Mai' }, ...],
  history: [cellIndex, ...], // order of marks, used for "last used name"
  bingoLine: [0,1,2,3] | null,
  joinedAt: <ms>,
  connected: <derived>,      // never stored — computed from the seen-hash
  lastSeen: <derived>,
}
```

### Storage keys

Two Redis keys per room, both with a **6-hour TTL**:

- `room:{CODE}` — the full room JSON. Written **only on real mutations**.
- `seen:{CODE}` — a hash of `playerId → lastSeen(ms)`, bumped on every heartbeat.

Splitting presence into its own key is deliberate: a heartbeat every 2s from every player must
not rewrite the whole room and race with someone's mark.

`connected` is derived at load time: `now - lastSeen < 8000ms` (≈4 missed 2-second polls).

---

## 6. Public vs private state

The server never sends a player another player's board, and never sends anyone's token to
anyone else.

**`publicRoom(room)`** — broadcast to everybody:
`code, size, status, theme, categories, degraded, hostId, minPlayers, playerCount` (connected
*players*, host excluded), `winner`, and a `players[]` array sorted by `joinedAt` where each
entry is `{ id, name, connected, isHost, isPlayer, marked, total, hasBingo }`. Note `marked`
is a **count**, not the board.

**`privateState(player)`** — only to that player:
`{ playerId, board, bingoLine, lastUsedName, usage }` where `usage` maps `nameKey → count` of
how many of your squares each person already fills (shown as "3 squares" in the picker).

---

## 7. API contract

Three endpoints. All responses are `200` with `{ ok: false, error }` on rule violations —
HTTP status is only used for genuinely malformed requests.

### `POST /api/action`

Body: `{ action, payload, session }` where `session` is `{ code, playerId, token }` once the
caller is in a room, `null` before. The handler merges `{...session, ...payload}` and
dispatches on `action`:

| Action | Payload | Notes |
| --- | --- | --- |
| `create_room` | `name, size, theme, categories` | Returns `code, playerId, token, room` |
| `join_room` | `code, name, token?` | `token` present ⇒ reconnect; a taken name is only allowed back with the matching token |
| `start_game` | — | Host only. Runs the slow Groq generation inline |
| `mark_cell` | `cellIndex, targetId` | All marking rules enforced here |
| `clear_cell` | `cellIndex` | |
| `play_again` | — | Host only. Back to lobby, boards wiped |
| `update_settings` | `size?, categories?, theme?` | Host only, lobby only |
| `leave_room` | — | Deletes the room when the last member leaves |

### `GET /api/state?code&playerId&token`

The poll **and** the heartbeat — it bumps the caller's `lastSeen` before reading. Returns
`{ ok, room, private }`, or `{ ok: false, gone: true, error }` once the caller is no longer a
member (kicked, left, room expired), which tells the client to reset to the home screen.
Sends `Cache-Control: no-store`.

### `GET /api/qr?room=CODE`

Returns an **SVG** QR encoding `{origin}/?room=CODE`. The origin is rebuilt from the request's
`Host` header (plus `x-forwarded-proto`), so the QR encodes exactly the address the host is
browsing — LAN IP and port included — without the server knowing its own hostname.
`PUBLIC_ORIGIN` overrides this when the frontend lives on another domain.
Validates the code against `/^[A-Z0-9]{4}$/` and the host against a strict character set.

---

## 8. Presence and host handover

Both are **derived from timestamps**, never from live sockets or `setTimeout`, so they stay
correct across stateless serverless invocations.

- `PRESENCE_MS = 8_000` — a player shows as offline after ~4 missed polls.
- `HOST_GRACE_MS = 45_000` — a host who refreshes keeps the role this long.

Handover is deliberately cautious, because becoming host means **losing your card**:

> If the host is gone past the grace window, the role passes to the longest-present player —
> **but only while `status` is `lobby` or `finished`.** A room whose host vanishes mid-round
> plays on untouched to the end, and picks a new host at the moment someone wins.

Nobody's card is ever taken away mid-game. When the role does transfer, the new host's board,
history and bingo line are cleared (they stop being a player).

`reconcileHost` runs on join, leave, poll, and immediately after a win.

---

## 9. Question generation

### Categories

Six, each a phrase spliced into the prompt:

```
hobbies      → hobbies, sports and pastimes
personality  → personality traits, habits and daily routines
travel       → travel, places lived and languages
food         → food, drink and cooking preferences
skills       → skills, talents and things they can do
quirky       → quirky, surprising or funny personal facts
```

The host ticks any subset (none ticked = mix everything) and can add a free-text **theme**
("remote dev team", "university freshers") that tailors every square.

### The generation algorithm

For P players on an N×N grid the room needs **P × N × N distinct statements**.

1. Seed a `seen` set with every trait already in play in the room (so late joiners never get a
   square someone else has).
2. Up to **3 rounds**. Each round over-requests `ceil(missing × 1.25) + 4` traits, splits that
   into **parallel batches of 20** via `Promise.allSettled`, and gives each batch a different
   **angle** from a rotating list of six ("Lean towards everyday routines…", "…things a person
   has done at least once…", "…abilities…", "…tastes that split a group in half…",
   "…childhood…", "…mildly unusual facts…"). The tail of the accepted list (last 60) is sent
   back as a "do NOT reuse" block.
3. Accept traits through the dedupe filter; stop as soon as the target count is reached.
4. Deal every player a **disjoint slice** of the result.

### Dedupe

Normalise to lowercase, strip non-alphanumerics, collapse whitespace. Exact matching is not
enough — the model happily returns both "Can swim" and "Can swim laps", which look silly on
one card. So **one trait is a duplicate of another when either string fully contains the
other**.

### Groq request

`POST https://api.groq.com/openai/v1/chat/completions` with
`temperature: 1.1`, `top_p: 0.95`, `max_tokens: 2048`,
`response_format: { type: 'json_object' }`, and a **30-second AbortController timeout**.
Accepts `{traits|squares|questions: [...]}` or a bare array. Each string is trimmed, stripped
of list bullets, and kept only if 8–80 characters.

### The system prompt (the important part)

Each square must:

- Start with a third-person verb — "Plays…", "Has…", "Can…", "Speaks…", "Prefers…".
- Be **max 55 characters**, short and scannable.
- Be verifiable by simply asking someone. No opinions, no maths, no trivia.
- Be common enough that in ~15 people at least one matches, but **not so common that everyone
  matches** — "Has a phone", "Drinks water", "Can cook", "Likes music" are explicitly called
  out as mistakes that make the game boring.
- Be **safe for any workplace or classroom**: nothing about religion, politics, sex, health
  conditions, income or appearance.
- Never repeat an idea, and never two statements about the same activity.
- Be **specific** — a statement that needs a detail to be true is far more fun than a vague one.

Good examples given to the model: "Has run a half marathon", "Speaks three languages",
"Has lived abroad for a year", "Can solve a Rubik's cube in under a minute".

Reply is JSON only: `{"traits": [...]}`.

### Fallback

A hardcoded `FALLBACK_BANK` of ~65 generic squares. If Groq is unreachable or short, the room
**still starts**, padded from the bank (shuffled, deduped), and `room.degraded` is set so every
player sees a banner explaining the questions aren't custom. As an absolute last resort the
bank is recycled so a board is never short of squares. A missing `GROQ_API_KEY` skips the API
entirely and goes straight to the bank with a console warning.

---

## 10. Frontend

A single-page app in three files, no build step. Five screens toggled by an `.is-active` class:
**home → create → join → lobby → game**, plus a pick-a-player bottom sheet, a "Groq is writing
the cards" loading overlay, a win overlay, and a toast.

### Client state

```js
{ room, me: {id, name, token, code}, board, bingoLine, lastUsedName, usage,
  activeCell, winAcknowledged }
```

`me` is mirrored into **`sessionStorage`** under `humanBingo.session`, so a refresh puts you
back on your own board. On load, `boot()` replays `join_room` with the saved token.

### Polling

`setInterval(pollOnce, 2000)`. Each successful poll applies `room` and `private`. Three
consecutive failures show a "Connection hiccup — retrying…" toast; `{gone: true}` ends the
session cleanly. Action responses also carry fresh `room`/`private`, so your own taps feel
instant instead of waiting for the next poll.

### Two rendering subtleties worth keeping

1. **Don't rebuild the grid on every poll.** Other players' marks arrive constantly; a
   re-render between `mousedown` and `mouseup` replaces the button and the click event never
   fires, swallowing taps. The board is only rebuilt when a **signature** of *your own* board
   actually changes. The action buttons use the same trick.
2. **Clipboard fallback.** `navigator.clipboard` needs a secure context and may hang behind a
   permission prompt on plain http over a LAN. The copy is raced against a **1.5s timeout**,
   falling back to selecting the link and toasting "press Ctrl+C".

### Invite flow

The lobby shows `http://<host>/?room=CODE` in a read-only field with a **Copy link** button and
the QR beneath it. Tapping the big room code (lobby or game bar) copies the same link.

- Opening the link lands on the join screen with the code pre-filled and the cursor in the
  name box.
- Following an invite to a **different** room leaves whatever room that tab was in.
- Refreshing on an invite URL reconnects to your existing board rather than re-asking.
- A link to a dead room leaves you on the join screen with "No room with that code."
- On `localhost`/`127.0.0.1`, the lobby warns that the link only works on your own machine —
  reopen the app on the LAN address to share it.
- Leaving strips `?room=` via `history.replaceState` so a refresh doesn't drag you back.

### Styling

Dark theme driven by CSS custom properties on `:root`: `--bg #0b0e1a`, `--bg-2 #12162a`,
`--text #eef0fb`, `--muted #9aa1c4`, `--accent #7c6cff` (violet), `--accent-2 #22d3a6`
(mint), `--accent-warm #ffb84d`, `--danger #ff6b81`, `--radius 16px`. Body background is two
radial gradients over a vertical linear gradient, `background-attachment: fixed`. System font
stack, fluid `clamp()` headings, mobile-first with `viewport-fit=cover`.

---

## 11. Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `GROQ_API_KEY` | — | Required for real questions. Without it, the built-in bank is used and the room shows a warning banner. Free key from https://console.groq.com/keys |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Any Groq chat model |
| `PORT` | `3000` | Local dev server only |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Redis credentials; set automatically by the Vercel KV integration. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are also accepted |
| `PUBLIC_ORIGIN` | — | Overrides the origin baked into invite links and QR codes |

`.env` is gitignored. Loaded via `dotenv/config` in `server.js` only (Vercel injects its own).

---

## 12. Running it

```bash
npm install
cp .env.example .env      # paste your Groq key
npm start                 # http://localhost:3000
npm run dev               # node --watch
npm test                  # requires the server to already be running
```

To play across phones on the same wifi, find the machine's LAN address
(`ipconfig getifaddr en0` on macOS, `hostname -I` on Linux) and have everyone open
`http://<that-address>:3000`.

---

## 13. Deployment

### Vercel (the primary target)

`vercel.json` sets `framework: null`, no build command, `outputDirectory: public`,
`cleanUrls: true`, and `functions: { "api/*.js": { maxDuration: 60 } }` — the 60s ceiling
matters because `start_game` runs the Groq generation inline.

Steps: import the repo → **Storage → Create Database → KV (Upstash Redis)** → add
`GROQ_API_KEY` in Settings → Environment Variables → redeploy.

> **Redis is required on Vercel.** Without it the functions fall back to in-memory state, which
> is not shared between serverless instances — two players can land on different instances and
> never see each other. The in-memory store exists only so local `npm start` needs no external
> service.

### Render (the no-database alternative)

`render.yaml` runs one always-on Node process (`npm install` / `npm start`, free plan). A
single persistent process shares one memory across every request, so the in-memory store just
works. Only `GROQ_API_KEY` is needed.

---

## 14. Tests

`test/smoke.mjs` drives a real 4-person game (host + 3 players) against a running server over
the HTTP API, with plain `assert`. It covers:

- Room creation and settings round-trip
- Duplicate names rejected; unknown room code; blank name
- The **3-player minimum excluding the host** — starting with 2 players fails, 3 succeeds
- Non-host can't start
- The host gets **no card**
- **Per-player question uniqueness** across all boards
- The host can't be marked and can't mark
- Self-marking rejected
- The **not-twice-in-a-row** rule, and that the name becomes usable again after another
- Clearing a square
- **Bingo detection** on the top row, and that the room locks afterwards
- Token reconnect (wrong token rejected, right token resumes)
- **Host role retained across a refresh**
- `play_again` returning everyone to the lobby with boards wiped

---

## 15. Rebuild order

If starting from an empty directory, this order keeps every step testable:

1. `lib/game.js` — pure helpers. Room codes use the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
   (**no O/0/I/1**, which get misread when a code is called out across a room). Write
   `findBingoLine`, `nameKey`, `publicRoom`, `privateState` first; they're trivially unit-testable.
2. `lib/store.js` — the two-key Redis shape plus the in-memory twin, behind one `getStore()`.
   Serialise the players `Map` to an array; never persist `connected`/`lastSeen`.
3. `lib/questions.js` — the prompt, batching, dedupe, fallback bank.
4. `lib/engine.js` — every rule, returning `{ok}` / `{ok:false, error}`. No HTTP here.
5. `api/*.js` — thin handlers using only the `(req, res)` subset shared by Express and Vercel,
   so `server.js` can mount the exact same functions.
6. `server.js` — Express, static `public/`, three routes, a `/health` check, and a friendly
   `EADDRINUSE` message.
7. `public/*` — home/create/join screens first, then lobby + polling, then the board and sheet.
8. `test/smoke.mjs` — then work backwards through any rule it catches.

### Traps that cost time the first way round

- Re-rendering the grid on every 2s poll **swallows taps**. Signature-check before touching
  the DOM.
- Substring-overlapping traits ("Can swim" / "Can swim laps") need containment dedupe, not
  equality.
- Presence stored inside the room document turns every heartbeat into a room write, which
  races with marks. Keep it in a separate hash.
- Host handover mid-round would confiscate someone's card. Gate it on `lobby`/`finished`.
- The QR must be built from the request `Host` header, or it encodes `localhost` and nobody on
  the wifi can join.
- The clipboard API silently hangs over plain http on a LAN. Always race it against a timeout.
