// A local stand-in for Harklight Server's browser door, written from the
// browser messaging contract. It serves the web client and speaks the relay
// frames the client uses, with sample messages, so the client can be developed
// and tested before the real door exists. It is not a server implementation.
//
//   node dev/fake-server.mjs [--vite] [--dist] [--port 5173] [--flags attachments]
//
// Test controls (POST, JSON body) live under /__fake/.

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { fixture, formFixture } from './fixture.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(opt('port', process.env.PORT ?? 5173));
const USE_VITE = args.includes('--vite');
const DIST = resolve(opt('dist-dir', 'dist'));
const FLAGS = (opt('flags', '') || '').split(',').filter(Boolean);
const UPLOAD_CAP = Number(opt('upload-cap', 20_000_000));
const INLINE_LIMIT = 262_144;

// ---------- account state ----------

export function createWorld(now = Date.now(), forms = false) {
  const w = {
    seq: 0,
    convSeq: 0,
    events: [], // inbox sequence events (delivery and lifecycle frames)
    conv: [], // conversation events
    messages: new Map(), // key -> {sender_id, message_id, revision, payload, session_handle, terminal, files}
    readPositions: new Map(),
    receipts: new Map(), // recipient|op_id -> reply
    // Recipients whose session finished a replay attach. Like the Server, a
    // recipient's session outlives its connection, and a ready one refuses
    // a fresh inbox_start with sync_mode_conflict.
    readyRecipients: new Set(),
    uploads: new Map(),
    viewRev: 1,
    arrival: new Map(), // conversation_seq -> arrival tick
    sessionLive: true,
    inactive: false,
    displayName: 'Dana Reyes',
  };
  for (const m of [...(forms ? formFixture(now) : []), ...fixture(now)]) addMessage(w, m.message, m);
  return w;
}

const key = (s, m) => `${s}\u0000${m}`;

function pushEvent(w, frame) {
  w.tick = (w.tick ?? 0) + 1;
  w.seq += 1;
  const ev = { v: 1, ...frame, seq: w.seq };
  w.events.push(ev);
  return ev;
}

function pushConv(w, k, frame) {
  w.tick = (w.tick ?? 0) + 1;
  w.convSeq += 1;
  const m = w.messages.get(k);
  const ev = {
    v: 1,
    type: 'conversation',
    conversation_seq: w.convSeq,
    sender_id: m.sender_id,
    message_id: m.message_id,
    origin: 'a'.repeat(64),
    request_revision: m.revision,
    ...frame,
  };
  if (frame.kind === 'read_position') delete ev.request_revision;
  w.viewRev += 1;
  w.conv.push(ev);
  w.arrival.set(ev.conversation_seq, w.tick);
  return ev;
}

export function addMessage(w, payload, opts = {}) {
  const k = key(payload.sender_id, payload.message_id);
  const m = {
    sender_id: payload.sender_id,
    message_id: payload.message_id,
    revision: 1,
    payload,
    session_handle: opts.chat === false ? null : `h-${payload.message_id}`,
    terminal: null,
    files: opts.files ?? [],
    eventId: String(1000 + w.seq),
  };
  w.messages.set(k, m);
  const ev = pushEvent(w, {
    type: 'delivery',
    sender_id: m.sender_id,
    message_id: m.message_id,
    origin: 'a'.repeat(64),
    as: 'knock',
    message: payload,
    ...(m.session_handle
      ? { request_revision: 1, session_handle: m.session_handle, event_id: m.eventId, availability: 'listening' }
      : {}),
    ...(m.files.length ? { files: m.files } : {}),
  });
  m.acceptedSeq = ev.seq;
  m.arrival = w.tick;
  for (const c of opts.chatTurns ?? []) agentOrPersonTurn(w, k, c);
  if (opts.answered) terminate(w, k, { state: 'answered', answer_outcome: opts.answered });
  if (opts.readThrough) {
    const replies = w.conv.filter((e) => e.kind === 'reply' && key(e.sender_id, e.message_id) === k);
    const last = replies[replies.length - 1];
    if (last) w.readPositions.set(k, last.conversation_seq);
  }
  w.viewRev += 1;
  return m;
}

function agentOrPersonTurn(w, k, c) {
  if (c.author === 'person') {
    const ev = pushConv(w, k, {
      kind: 'discussion',
      author: 'person',
      delivery_acks: true,
      session_handle: `h`,
      op_id: randomUUID(),
      text: c.text,
      channel: 'chat',
      event_id: `e${w.convSeq + 1}`,
      ...(c.files ? { files: c.files } : {}),
    });
    if (c.delivered) pushConv(w, k, { kind: 'receipt', author: 'origin', event_id: ev.event_id, delivered: true });
    return ev;
  }
  const prev = [...w.conv].reverse().find((e) => e.kind === 'discussion' && key(e.sender_id, e.message_id) === k);
  return pushConv(w, k, {
    kind: 'reply',
    author: 'origin',
    session_handle: 'h',
    in_reply_to: prev?.event_id ?? null,
    op_id: randomUUID(),
    text: c.text,
    channel: 'chat',
    event_id: `e${w.convSeq + 1}`,
    ...(c.files ? { files: c.files } : {}),
  });
}

function terminate(w, k, extra) {
  const m = w.messages.get(k);
  m.terminal = extra;
  w.viewRev += 1;
  return pushEvent(w, {
    type: 'lifecycle',
    sender_id: m.sender_id,
    message_id: m.message_id,
    origin: 'a'.repeat(64),
    at: Date.now(),
    ...extra,
  });
}

function outcomeFor(answer) {
  if (answer === null) return { kind: 'seen' };
  if (typeof answer === 'string') return { kind: 'reply', text: answer };
  return undefined;
}

/** The baseline view with free order: active (waiting messages and chats
 * with unread replies, newest first), then history (the rest). */
function listItemsOf(w) {
  const active = [];
  const history = [];
  for (const m of w.messages.values()) {
    const item = { kind: 'message', sender_id: m.sender_id, message_id: m.message_id, at: m.arrival };
    (m.terminal ? history : active).push(item);
    const k = key(m.sender_id, m.message_id);
    const replies = w.conv.filter((e) => e.kind === 'reply' && key(e.sender_id, e.message_id) === k);
    if (!replies.length) continue;
    const read = w.readPositions.get(k) ?? 0;
    const unread = replies.filter((e) => e.conversation_seq > read);
    const newest = replies[replies.length - 1];
    const reply = {
      kind: 'reply',
      sender_id: m.sender_id,
      message_id: m.message_id,
      conversation_seq: (unread[unread.length - 1] ?? newest).conversation_seq,
      open_at_conversation_seq: (unread[0] ?? newest).conversation_seq,
      unseen_count: unread.length,
      at: w.arrival.get(newest.conversation_seq),
    };
    (unread.length ? active : history).push(reply);
  }
  const order = (a, b) => b.at - a.at;
  const tag = (list, state) => list.sort(order).map(({ at, ...it }) => ({ ...it, free_section: { state, group: 'common' } }));
  return [...tag(active, 'active'), ...tag(history, 'history')];
}

function viewOf(w) {
  const waiting = [...w.messages.values()].filter((m) => !m.terminal);
  const score = (m) => (m.payload.urgency === 'now' ? 0.95 : m.payload.urgency === 'high' ? 0.75 : 0.4);
  waiting.sort((a, b) => score(b) - score(a) || b.acceptedSeq - a.acceptedSeq);
  return waiting.map((m) => ({ sender_id: m.sender_id, message_id: m.message_id, score: score(m) }));
}

function items(w, highWater) {
  const all = [...w.messages.values()].filter((m) => m.acceptedSeq <= highWater);
  const rank = new Map(viewOf(w).map((e, i) => [key(e.sender_id, e.message_id), i]));
  const waiting = all.filter((m) => !m.terminal).sort((a, b) => {
    const ra = rank.get(key(a.sender_id, a.message_id)) ?? 1e9;
    const rb = rank.get(key(b.sender_id, b.message_id)) ?? 1e9;
    return ra - rb || b.acceptedSeq - a.acceptedSeq;
  });
  const done = all.filter((m) => m.terminal).sort((a, b) => b.acceptedSeq - a.acceptedSeq);
  return [...waiting, ...done].map((m) => {
    const acceptance = w.events.find((e) => e.type === 'delivery' && e.sender_id === m.sender_id && e.message_id === m.message_id);
    const terminal = [...w.events].reverse().find(
      (e) => e.type === 'lifecycle' && e.sender_id === m.sender_id && e.message_id === m.message_id && e.seq <= highWater,
    );
    return terminal ? { acceptance, terminal } : { acceptance };
  });
}

// ---------- the relay door ----------

const PAGE = 20;

function attachRelay(server, getWorld) {
  const wss = new WebSocketServer({ noServer: true });
  const conns = new Map(); // recipient -> socket
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/browser/relay') return socket.destroy();
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || (origin !== `http://${host}` && origin !== `https://${host}`)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const w = getWorld();
      if (!w.sessionLive) return ws.close(4401, 'session_ended');
      if (w.inactive) return ws.close(4403, 'inactive_account');
      w.lastSubprotocol = req.headers['sec-websocket-protocol'] ?? null;
      const recipient = url.searchParams.get('recipient') ?? '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recipient)) return ws.close(1008, 'recipient');
      const older = conns.get(recipient);
      if (older) older.close(4409, 'replaced');
      conns.set(recipient, ws);
      serveConnection(ws, w, recipient);
      ws.on('close', () => conns.get(recipient) === ws && conns.delete(recipient));
    });
  });
  return {
    closeAll(code, reason) {
      for (const ws of conns.values()) ws.close(code, reason);
    },
    dropAll() {
      for (const ws of conns.values()) ws.terminate();
    },
    count: () => conns.size,
  };
}

const snapshots = new Map();

function serveConnection(ws, w, recipient) {
  const st = { ready: false, stream: 0, convReady: false, conv: 0, view: false, viewRev: null };
  const send = (f) => ws.readyState === 1 && ws.send(JSON.stringify(f) + '\n');
  const drain = () => {
    if (st.ready) for (const e of w.events) if (e.seq > st.stream) (send(e), (st.stream = e.seq));
    if (st.convReady) for (const e of w.conv) if (e.conversation_seq > st.conv) (send(e), (st.conv = e.conversation_seq));
    if (st.view && st.viewRev !== w.viewRev) {
      st.viewRev = w.viewRev;
      send({ v: 1, type: 'view_changed', view_rev: `fake:${w.viewRev}` });
    }
  };
  const timer = setInterval(() => {
    if (!w.sessionLive) return ws.close(4401, 'session_ended');
    drain();
  }, 50);
  ws.on('close', () => clearInterval(timer));
  ws.on('message', (data) => {
    const text = data.toString();
    if (!text.endsWith('\n')) return send({ v: 1, type: 'error', reason: 'bad_frame' });
    let f;
    try {
      f = JSON.parse(text);
    } catch {
      return send({ v: 1, type: 'error', reason: 'bad_frame' });
    }
    const ref = typeof f.ref === 'string' ? { ref: f.ref } : {};
    const ok = (x = {}) => send({ v: 1, type: 'ok', ...ref, ...x });
    const err = (reason, x = {}) => send({ v: 1, type: 'error', reason, ...ref, ...x });
    if (!w.sessionLive) return ws.close(4401, 'session_ended');
    // Test controls: hold answers in flight, or refuse them.
    if (f.type === 'answer' || f.type === 'answer_no_comment') {
      (w.answerFrames = w.answerFrames ?? []).push({ op_id: f.op_id ?? null, answer: f.answer ?? null });
      if (w.failAnswers) return send({ v: 1, type: 'error', reason: 'storage_unavailable' });
      if (w.refuseAnswers) return send({ v: 1, type: 'error', reason: w.refuseAnswers });
      if (w.holdAnswers && !w.releasing?.has(text)) {
        w.held = w.held ?? [];
        w.held.push(() => {
          (w.releasing = w.releasing ?? new Set()).add(text);
          ws.emit('message', Buffer.from(text));
        });
        return;
      }
    }
    switch (f.type) {
      case 'inbox_start': {
        if (w.readyRecipients.has(recipient)) return err('sync_mode_conflict');
        const id = randomUUID().replace(/-/g, '');
        const list = items(w, w.seq);
        snapshots.set(id, { recipient, high: w.seq, list, accepted: false });
        st.snapshot = id;
        ok({
          paging_version: 1,
          snapshot_id: id,
          high_water: w.seq,
          items: list.slice(0, PAGE),
          next_cursor: list.length > PAGE ? String(PAGE) : null,
          receipt_cursor: null,
        });
        break;
      }
      case 'inbox_page': {
        const snap = snapshots.get(f.snapshot_id);
        if (!snap || snap.recipient !== recipient) return err('invalid_snapshot');
        const at = Number(f.cursor);
        ok({
          paging_version: 1,
          snapshot_id: f.snapshot_id,
          high_water: snap.high,
          items: snap.list.slice(at, at + PAGE),
          next_cursor: snap.list.length > at + PAGE ? String(at + PAGE) : null,
        });
        break;
      }
      case 'inbox_checkpoint_ack': {
        const snap = snapshots.get(f.snapshot_id);
        if (!snap || snap.recipient !== recipient) return err('invalid_snapshot');
        if (f.high_water !== snap.high || f.pending_manifest_complete !== true) return err('checkpoint_conflict');
        snap.accepted = true;
        ok({ paging_version: 1, snapshot_id: f.snapshot_id, high_water: snap.high, checkpoint_accepted: true });
        break;
      }
      case 'inbox_attach': {
        const snap = snapshots.get(f.snapshot_id);
        if (!snap || snap.recipient !== recipient) return err('invalid_snapshot');
        if (!snap.accepted) return err('checkpoint_pending');
        if (f.since < snap.high || f.since > w.seq) return err('invalid_cursor');
        ok({ paging_version: 1, snapshot_id: f.snapshot_id, high_water: snap.high, checkpoint_accepted: true, replay_started: true });
        const barrier = w.seq;
        for (const e of w.events) if (e.seq > f.since && e.seq <= barrier) send(e);
        send({ v: 1, type: 'resynced', seq: barrier });
        st.ready = true;
        w.readyRecipients.add(recipient);
        st.stream = barrier;
        break;
      }
      case 'conversation_open': {
        if (!st.ready) return err('resync_required');
        ok({});
        const high = w.convSeq;
        for (const e of w.conv) if (e.conversation_seq > f.since && e.conversation_seq <= high) send(e);
        send({
          v: 1,
          type: 'conversation_resynced',
          conversation_seq: high,
          chat_read_positions: [...w.readPositions].map(([k, at]) => {
            const [sender_id, message_id] = k.split('\u0000');
            return { sender_id, message_id, read_through_conversation_seq: at };
          }),
        });
        st.convReady = true;
        st.conv = high;
        break;
      }
      case 'conversation_ack':
        ok({ conversation_seq: f.conversation_seq });
        break;
      case 'view_get': {
        st.view = true;
        const rev = `fake:${w.viewRev}`;
        st.viewRev = w.viewRev;
        if (f.known_view_rev === rev) return ok({ view_rev: rev, unchanged: true });
        ok({ view_rev: rev, algorithm: 'baseline', basis: 'selected', entries: viewOf(w), replies: [], list_items: listItemsOf(w), free_order_version: 1 });
        break;
      }
      case 'message_open': {
        const m = w.messages.get(key(f.sender_id, f.message_id));
        if (!m) return err('not_found');
        ok({ op_id: f.op_id, sender_id: f.sender_id, message_id: f.message_id, request_revision: f.request_revision, opened: true });
        w.opens = (w.opens ?? 0) + 1;
        break;
      }
      case 'answer': {
        const rk = `${recipient}|${f.op_id}`;
        if (w.receipts.has(rk)) return send({ ...w.receipts.get(rk), duplicate: true });
        const k = key(f.sender_id, f.message_id);
        const m = w.messages.get(k);
        if (!m) return err('unknown_message');
        if (m.terminal) return err('closed');
        if (f.request_revision !== undefined && f.request_revision !== m.revision)
          return err('stale_revision', { field: 'request_revision', current_revision: m.revision });
        const outcome = outcomeFor(f.answer);
        const ev = terminate(w, k, { state: 'answered', by: 'answer', ...(outcome ? { answer_outcome: outcome } : {}) });
        const reply = { v: 1, type: 'ok', seq: ev.seq };
        w.receipts.set(rk, reply);
        w.lastAnswer = { key: k, answer: f.answer };
        send(reply);
        break;
      }
      case 'answer_no_comment': {
        const keys = Object.keys(f).sort().join(',');
        if (keys !== 'request_id,request_revision,type') return send({ v: 1, type: 'error', reason: 'invalid_field' });
        const m = [...w.messages.values()].find((x) => x.message_id === f.request_id);
        if (!m) return send({ v: 1, type: 'error', reason: 'not_found' });
        if (m.terminal?.terminal_kind === 'no_comment') return send({ v: 1, type: 'ok', seq: 1, terminal_kind: 'no_comment', duplicate: true });
        if (m.terminal) return send({ v: 1, type: 'error', reason: 'closed' });
        const ev = terminate(w, key(m.sender_id, m.message_id), {
          state: 'answered',
          terminal_kind: 'no_comment',
          by: 'answer_no_comment',
          answer_outcome: { kind: 'no_comment' },
        });
        send({ v: 1, type: 'ok', seq: ev.seq, terminal_kind: 'no_comment' });
        break;
      }
      case 'discussion': {
        if (w.refuseInactive) return err('inactive_account');
        const rk = `${recipient}|${f.op_id}`;
        if (w.receipts.has(rk)) return send({ ...w.receipts.get(rk), ...ref, duplicate: true });
        const k = key(f.sender_id, f.message_id);
        const m = w.messages.get(k);
        if (!m) return err('not_found');
        if (typeof f.text !== 'string' || f.text === '') return err('invalid_field', { field: 'text' });
        if (!m.session_handle) return err(m.terminal ? 'closed' : 'not_found');
        if (m.terminal) return err('closed');
        const files = [];
        let inline = 0;
        for (const x of f.files ?? []) {
          if (x.data_base64 !== undefined) {
            const buf = Buffer.from(x.data_base64, 'base64');
            inline += buf.length;
            files.push({ name: x.name, tier: 'inline', size: buf.length, sha256: sha(buf), data_base64: x.data_base64 });
          } else {
            const up = w.uploads.get(x.upload_id);
            if (!up || up.recipient !== recipient || up.op_id !== f.op_id || up.size !== x.size || up.sha256 !== x.sha256)
              return err('invalid_field', { field: 'files' });
            up.referenced = true;
            files.push({ name: x.name, tier: 'upload', upload_id: x.upload_id, size: x.size, sha256: x.sha256 });
          }
        }
        if (inline > INLINE_LIMIT) return err('invalid_field', { field: 'files' });
        const ev = pushConv(w, k, {
          kind: 'discussion',
          author: 'person',
          delivery_acks: true,
          session_handle: m.session_handle,
          op_id: f.op_id,
          text: f.text,
          channel: 'chat',
          event_id: `e${w.convSeq + 1}`,
          ...(files.length ? { files } : {}),
        });
        const reply = { v: 1, type: 'ok', seq: ev.conversation_seq, event_id: ev.event_id };
        w.receipts.set(rk, reply);
        w.lastDiscussion = { key: k, text: f.text, files };
        send({ ...reply, ...ref });
        break;
      }
      case 'conversation_read': {
        const k = key(f.sender_id, f.message_id);
        const reply = w.conv.find((e) => e.conversation_seq === f.read_through_conversation_seq && e.kind === 'reply');
        if (!reply || key(reply.sender_id, reply.message_id) !== k) return err('invalid_field', { field: 'read_through_conversation_seq' });
        const cur = w.readPositions.get(k) ?? 0;
        if (f.read_through_conversation_seq <= cur) return ok({ read_through_conversation_seq: cur });
        w.readPositions.set(k, f.read_through_conversation_seq);
        const ev = pushConv(w, k, { kind: 'read_position', event_id: `read:${w.convSeq + 1}`, read_through_conversation_seq: f.read_through_conversation_seq });
        ok({ read_through_conversation_seq: f.read_through_conversation_seq, seq: ev.conversation_seq, event_id: ev.event_id });
        break;
      }
      default:
        err('unknown_type');
    }
    drain();
  });
}

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------- HTTP ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.map': 'application/json' };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startFakeServer({ port = PORT, vite = USE_VITE, dist = DIST, flags = FLAGS } = {}) {
  const forms = flags.includes('answer-forms');
  let world = createWorld(Date.now(), forms);
  let webClient = !flags.includes('customer-off');
  let attachments = flags.includes('attachments');
  let viteServer = null;
  if (vite) {
    const { createServer: createVite } = await import('vite');
    viteServer = await createVite({ server: { middlewareMode: true }, appType: 'spa' });
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      // test controls
      if (p === '/__fake/me') return json(res, 200, { display_name: world.displayName });
      if (p.startsWith('/__fake/')) return control(req, res, p.slice(8));
      if (p === '/app/config.json')
        return json(res, 200, {
          accountInfoPath: '/__fake/me',
          flags: { webClient, attachments, answerForms: flags.includes('answer-forms') },
        });
      if (p === '/sign-out' && req.method === 'POST') {
        const body = (await readBody(req)).toString();
        if (body !== 'confirm=sign_out') return json(res, 403, { error: 'Sign out refused' });
        world.sessionLive = false;
        relay.closeAll(4401, 'session_ended');
        res.writeHead(303, { location: '/account/sign-out' });
        return res.end();
      }
      if (p.startsWith('/account/') || p === '/devices' || p === '/components') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><title>${p}</title><p>Stand-in for ${p}</p>`);
      }
      if (p.startsWith('/browser/v1')) return files(req, res, url);
      const page = p === '/' || p === '/inbox' || p === '/settings';
      if (viteServer) {
        if (page) req.url = '/app/';
        return viteServer.middlewares(req, res);
      }
      if (!page && !p.startsWith('/app/')) return json(res, 404, {});
      let file = join(dist, page ? 'index.html' : p.slice('/app/'.length));
      if (!file.startsWith(dist)) return json(res, 404, {});
      try {
        await stat(file);
      } catch {
        file = join(dist, 'index.html');
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });

  async function files(req, res, url) {
    if (!world.sessionLive) {
      res.writeHead(303, { location: '/account/sign-in' });
      return res.end();
    }
    const recipient = url.searchParams.get('recipient');
    if (req.method === 'GET' && url.pathname.startsWith('/browser/v1/files/')) {
      const id = url.pathname.slice('/browser/v1/files/'.length);
      const up = world.uploads.get(id);
      if (!up || !up.referenced) return json(res, 404, { v: 1, type: 'error', reason: 'not_found' });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment',
        'x-content-type-options': 'nosniff',
        'x-harklight-sha256': up.sha256,
        'cache-control': 'no-store',
      });
      return res.end(up.bytes);
    }
    if (req.method !== 'POST') return json(res, 405, {});
    if (url.pathname === '/browser/v1/upload') {
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > UPLOAD_CAP) return json(res, 413, { v: 1, type: 'error', reason: 'upload_cap_exceeded', upload_cap_bytes_per_file: UPLOAD_CAP });
      const bytes = await readBody(req);
      const name = Buffer.from(String(req.headers['x-harklight-file-name']), 'base64url').toString('utf8');
      const op = String(req.headers['x-harklight-op-id']);
      const existing = [...world.uploads.values()].find((u) => u.op_id === op && u.name === name && u.recipient === recipient);
      if (existing) return json(res, 200, { v: 1, type: 'ok', upload_id: existing.id, name, size: existing.size, sha256: existing.sha256, duplicate: true });
      const id = randomUUID();
      const up = { id, recipient, op_id: op, name, size: bytes.length, sha256: sha(bytes), bytes, referenced: false };
      world.uploads.set(id, up);
      return json(res, 200, { v: 1, type: 'ok', upload_id: id, name, size: up.size, sha256: up.sha256, duplicate: false });
    }
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (body.type === 'file_limits') return json(res, 200, { v: 1, type: 'ok', inline_decoded_bytes_per_entry: INLINE_LIMIT, upload_cap_bytes_per_file: UPLOAD_CAP });
    if (body.type === 'discard_uploads') {
      let n = 0;
      for (const [id, u] of world.uploads) if (u.recipient === recipient && !u.referenced) (world.uploads.delete(id), n++);
      return json(res, 200, { v: 1, type: 'ok', state: 'discarded', discarded: n });
    }
    return json(res, 200, { v: 1, type: 'error', reason: 'invalid_field', field: 'type' });
  }

  async function control(req, res, what) {
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {};
    switch (what) {
      case 'web-client':
        webClient = body.on !== false;
        return json(res, 200, { ok: true });
      case 'attachments':
        attachments = body.on !== false;
        return json(res, 200, { ok: true });
      case 'reset':
        webClient = !flags.includes('customer-off');
        attachments = flags.includes('attachments');
        world = createWorld(body.now ?? Date.now(), forms);
        relay.dropAll();
        return json(res, 200, { ok: true });
      case 'state':
        return json(res, 200, { subprotocol: world.lastSubprotocol ?? null, lastAnswer: world.lastAnswer ?? null, lastDiscussion: world.lastDiscussion ?? null, opens: world.opens ?? 0, answerFrames: world.answerFrames ?? [], connections: relay.count() });
      case 'send': {
        const m = addMessage(world, { created_at: Date.now(), ...body.message }, { chat: body.chat });
        return json(res, 200, { ok: true, seq: m.acceptedSeq });
      }
      case 'reply': {
        const k = key(body.sender_id, body.message_id);
        agentOrPersonTurn(world, k, { author: 'origin', text: body.text, files: body.files });
        return json(res, 200, { ok: true });
      }
      case 'bulk': {
        // Many open requests, newer than everything else, to push older messages to later pages.
        for (let i = 0; i < (body.count ?? 25); i++)
          addMessage(world, { sender_id: 'agent:bulk', message_id: `bulk-${i}`, title: `Bulk request ${i}`, created_at: Date.now(), message_type: 'request', answer_ui: { schema: 'attention-client.actions/1', actions: [{ id: 'ok', label: 'OK', kind: 'value', value: 'ok' }] } }, { chat: false });
        return json(res, 200, { ok: true });
      }
      case 'answer-oldest': {
        // Answer the oldest open message, so it belongs to Replied and to a later page.
        const m = [...world.messages.values()].filter((x) => !x.terminal).sort((a, b) => a.acceptedSeq - b.acceptedSeq)[0];
        terminate(world, key(m.sender_id, m.message_id), { state: 'answered', answer_outcome: { kind: 'reply', text: 'Done' } });
        return json(res, 200, { ok: true });
      }
      case 'answer-elsewhere': {
        // Another device answers a message first (by title), with a written reply.
        const m = [...world.messages.values()].find((x) => (x.payload?.title ?? x.title) === body.title && !x.terminal);
        if (!m) return json(res, 404, { error: 'no open message with that title' });
        // text: null answers it with no outcome text.
        const outcome = body.text === null ? {} : { answer_outcome: { kind: 'reply', text: body.text ?? 'Done' } };
        terminate(world, key(m.sender_id, m.message_id), { state: 'answered', ...outcome });
        return json(res, 200, { ok: true });
      }
      case 'hold-answers':
        world.holdAnswers = body.on !== false;
        return json(res, 200, { ok: true });
      case 'release-answers': {
        world.holdAnswers = false;
        const held = world.held ?? [];
        world.held = [];
        held.forEach((run) => run());
        return json(res, 200, { released: held.length });
      }
      case 'refuse-answers':
        // Refuse answers as if the message had closed or been retracted first.
        world.refuseAnswers = body.reason ?? null;
        return json(res, 200, { ok: true });
      case 'fail-answers':
        world.failAnswers = body.on !== false;
        return json(res, 200, { ok: true });
      case 'refuse-inactive':
        world.refuseInactive = true;
        return json(res, 200, { ok: true });
      case 'end-session':
        world.sessionLive = false;
        return json(res, 200, { ok: true });
      case 'start-session':
        world.sessionLive = true;
        return json(res, 200, { ok: true });
      case 'inactive':
        world.inactive = true;
        relay.closeAll(4403, 'inactive_account');
        return json(res, 200, { ok: true });
      case 'forget-snapshots':
        // The next resume finds no snapshot (invalid_snapshot).
        snapshots.clear();
        return json(res, 200, { ok: true });
      case 'drop':
        relay.dropAll();
        return json(res, 200, { ok: true });
      default:
        return json(res, 404, {});
    }
  }

  const relay = attachRelay(server, () => world);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: async () => {
      relay.dropAll();
      await viteServer?.close();
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startFakeServer().then(({ port }) => console.log(`Harklight web client on http://127.0.0.1:${port}/inbox (fake Server)`));
}
