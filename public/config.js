// Where the realtime (Socket.IO) server lives.
//
//   ""  (empty)                     -> same origin. Use this for local `npm start`,
//                                      where server.js serves this page itself.
//   "https://your-app.onrender.com" -> the external server. Use this for the Vercel
//                                      deployment, where the frontend is static and the
//                                      Socket.IO server runs on Render/Railway/Fly.
//
// No trailing slash. This file is plain static config, safe to edit per-deploy.
window.BINGO_SERVER = "";
