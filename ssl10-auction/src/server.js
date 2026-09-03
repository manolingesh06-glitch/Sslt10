require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');
const routes = require('./routes');
const live = require('./liveState');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

app.use('/api', routes);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'public'))); // serves your index.html as-is

app.get('/health', (req, res) => res.json({ ok: true }));

// http.createServer + Socket.IO on the same port as everything else — one
// server, one port, nothing extra to deploy or point DNS at.
const server = http.createServer(app);
const io = new Server(server);

// This replaces the Firestore document your app used to read/write in
// real time. See src/liveState.js for the merge/transaction semantics —
// they're built to match Firestore's behavior exactly so index.html
// doesn't need any logic changes, only a different transport underneath.
io.on('connection', (socket) => {
  // Every new connection (page load, reconnect after a dropped wifi
  // signal, etc.) gets the current state immediately, same as Firestore's
  // onSnapshot firing once right away with existing data.
  socket.emit('snapshot', live.getDoc());

  socket.on('get', (ack) => {
    if (typeof ack === 'function') ack(live.getDoc());
  });

  socket.on('set', (fields, ack) => {
    try {
      const { patch } = live.applySet(fields);
      // Broadcast only what changed, not the entire doc (which can hold
      // 500+ players' worth of data plus growing bid/chat history) — this
      // is the fix for lag once a lot of people are connected for hours:
      // every bid/chat/presence update used to resend everything to
      // everyone; now it sends just the diff. Each client's shim
      // (index.html) merges it into its own local copy of the doc, the
      // same way this server merges it into `doc`.
      io.emit('patch', patch);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) {
      console.error('live set failed', e);
      if (typeof ack === 'function') ack({ error: 'Write failed' });
    }
  });

  socket.on('beginTransaction', async (ack) => {
    try {
      const result = await live.beginTransaction(socket.id);
      if (typeof ack === 'function') ack(result);
    } catch (e) {
      console.error('beginTransaction failed', e);
      if (typeof ack === 'function') ack({ error: 'Could not start transaction' });
    }
  });

  socket.on('commitTransaction', (payload, ack) => {
    try {
      const { txId, updates } = payload || {};
      const { patch } = live.commitTransaction(socket.id, txId, updates);
      io.emit('patch', patch);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  socket.on('abortTransaction', (payload, ack) => {
    const { txId } = payload || {};
    live.abortTransaction(socket.id, txId);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    // If someone's connection drops mid-bid, don't leave the whole room
    // frozen waiting for the 8s transaction timeout.
    live.releaseIfHeldBy(socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () =>
  console.log(`Auction app + realtime backend running at http://localhost:${PORT}`)
);
