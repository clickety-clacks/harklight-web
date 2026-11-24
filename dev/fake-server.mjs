// A local stand-in for Harklight Server, for development and tests. It serves
// the web client and Harklight client API v2 under /v2 (dev/fake-v2.mjs), with
// sample messages. Its world records messages and events in the shapes the
// Server's own store keeps them, and the /v2 door renders items, entries and
// the change log from them. It is not a server implementation.
//
//   node dev/fake-server.mjs [--vite] [--dist] [--port 5173] [--flags attachments,answer-forms]
//
// Test controls (POST, JSON body) live under /__fake/.

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fixture, formFixture } from './fixture.mjs';
import { serveV2, syncV2, v2Control, v2DropAll, v2Feeds, v2Tick } from './fake-v2.mjs';

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

// ---------- account state ----------

export function createWorld(now = Date.now(), forms = false) {
  const w = {
    seq: 0,
    convSeq: 0,
    events: [], // inbox sequence events (delivery and lifecycle frames)
    conv: [], // conversation events
    messages: new Map(), // key -> {sender_id, message_id, revision, payload, session_handle, terminal, files}
    readPositions: new Map(),
    uploads: new Map(),
    arrival: new Map(), // conversation_seq -> arrival tick
    sessionLive: true,
    inactive: false,
    displayName: 'Dana Reyes',
  };
  for (const m of [...(forms ? formFixture(now) : []), ...fixture(now)]) addMessage(w, m.message, m);
  // Client API v2 sees the same world: its change log starts here, from rev 1,
  // and its inbox order and sections come from the world's placement.
  w.placement = () => listItemsOf(w);
  syncV2(w);
  return w;
}

const key = (s, m) => `${s}\u0000${m}`;

function pushEvent(w, frame) {
  w.tick = (w.tick ?? 0) + 1;
  w.seq += 1;
  const ev = { ...frame, seq: w.seq };
  w.events.push(ev);
  return ev;
}

function pushConv(w, k, frame) {
  w.tick = (w.tick ?? 0) + 1;
  w.convSeq += 1;
  const m = w.messages.get(k);
  const ev = {
    type: 'conversation',
    conversation_seq: w.convSeq,
    sender_id: m.sender_id,
    message_id: m.message_id,
    origin: 'a'.repeat(64),
    request_revision: m.revision,
    ...frame,
  };
  if (frame.kind === 'read_position') delete ev.request_revision;
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

/** A chat turn from the person, as the world stores it. */
function personTurn(w, k, text, files) {
  const m = w.messages.get(k);
  return pushConv(w, k, {
    kind: 'discussion',
    author: 'person',
    delivery_acks: true,
    session_handle: m.session_handle ?? 'h',
    op_id: randomUUID(),
    text,
    channel: 'chat',
    event_id: `e${w.convSeq + 1}`,
    ...(files.length ? { files } : {}),
  });
}

function terminate(w, k, extra) {
  const m = w.messages.get(k);
  m.terminal = extra;
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

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------- HTTP ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.ico': 'image/vnd.microsoft.icon', '.png': 'image/png', '.map': 'application/json' };

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
  world.uploadCap = UPLOAD_CAP;
  // What the v2 door changes in the world.
  const v2ctx = {
    personTurn: (k, text, files) => personTurn(world, k, text, files),
    terminate: (k, extra) => terminate(world, k, extra),
    readTo: (k, seq) => {
      world.readPositions.set(k, seq);
      pushConv(world, k, { kind: 'read_position', event_id: `read:${world.convSeq + 1}`, read_through_conversation_seq: seq });
    },
  };
  const v2Timer = setInterval(() => v2Tick(world), 50);
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
          flags: { webClient, attachments, answerForms: flags.includes('answer-forms'), fyiInbox: flags.includes('fyi-inbox') },
        });
      if (p === '/sign-out' && req.method === 'POST') {
        const body = (await readBody(req)).toString();
        if (body !== 'confirm=sign_out') return json(res, 403, { error: 'Sign out refused' });
        world.sessionLive = false;
        res.writeHead(303, { location: '/account/sign-out' });
        return res.end();
      }
      if (p.startsWith('/account/') || p === '/devices' || p === '/components') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><title>${p}</title><p>Stand-in for ${p}</p>`);
      }
      if (p === '/v2' || p.startsWith('/v2/')) return serveV2(req, res, url, world, v2ctx);
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
        v2DropAll(world);
        world = createWorld(body.now ?? Date.now(), forms);
        world.uploadCap = UPLOAD_CAP;
        return json(res, 200, { ok: true });
      case 'standard-order':
        world.standardOrder = true;
        return json(res, 200, { ok: true });
      case 'state':
        return json(res, 200, { lastAnswer: world.lastAnswer ?? null, lastDiscussion: world.lastDiscussion ?? null, opens: world.opens ?? 0, answerFrames: world.answerFrames ?? [], feeds: v2Feeds(world), feedOpens: world.feedOpens ?? [], v2Uploads: world.v2Uploads ?? [], replays: world.replays ?? 0, v2Rev: world.v2?.rev ?? 0 });
      case 'send': {
        const m = addMessage(world, { created_at: Date.now(), ...body.message }, { chat: body.chat });
        return json(res, 200, { ok: true, seq: m.acceptedSeq });
      }
      case 'reply': {
        const k = key(body.sender_id, body.message_id);
        const ev = agentOrPersonTurn(world, k, { author: 'origin', text: body.text, files: body.files });
        // to: the text of the person's turn it answers, else the newest one.
        if (body.to !== undefined) ev.in_reply_to = world.conv.find((e) => e.kind === 'discussion' && e.text === body.to).event_id;
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
        return json(res, 200, { ok: true });
      case 'drop':
        v2DropAll(world);
        for (const sock of world.heldSockets ?? []) sock.destroy();
        world.heldSockets = [];
        return json(res, 200, { ok: true });
      case 'revise': {
        // The origin revises a message (by title): the given members replace its own.
        const m = [...world.messages.values()].find((x) => x.payload?.title === body.title);
        if (!m) return json(res, 404, { error: 'no message with that title' });
        if (m.terminal) return json(res, 409, { error: 'already_closed' });
        m.payload = { ...m.payload, ...body.message };
        m.revision += 1;
        return json(res, 200, { ok: true });
      }
      case 'answer-elsewhere': {
        // Another client of the person answers a message (by title) in text.
        const m = [...world.messages.values()].find((x) => x.payload?.title === body.title);
        if (!m) return json(res, 404, { error: 'no message with that title' });
        terminate(world, key(m.sender_id, m.message_id), { state: 'answered', answer_outcome: { kind: 'reply', text: body.text } });
        return json(res, 200, { ok: true });
      }
      case 'retract': {
        // The origin retracts a message (by title); it stays listed and readable.
        const m = [...world.messages.values()].find((x) => x.payload?.title === body.title);
        if (!m) return json(res, 404, { error: 'no message with that title' });
        terminate(world, key(m.sender_id, m.message_id), { state: 'cleared', terminal_reason: 'retracted' });
        return json(res, 200, { ok: true });
      }
      case 'delivery': {
        // Set members of a person's chat turn's delivery, by the turn's text.
        const ev = world.conv.find((e) => e.kind === 'discussion' && e.author === 'person' && e.text === body.text);
        if (!ev) return json(res, 404, { error: 'no such chat turn' });
        ev.delivery = { ...ev.delivery, ...body.delivery };
        return json(res, 200, { ok: true });
      }
      case 'withdraw-reply': {
        // The agent withdraws a chat reply, by its text.
        const ev = world.conv.find((e) => e.kind === 'reply' && e.text === body.text);
        if (!ev) return json(res, 404, { error: 'no such reply' });
        ev.state = 'withdrawn';
        return json(res, 200, { ok: true });
      }
      case 'availability': {
        // The agent stops or starts listening to a message's chat (by title).
        const m = [...world.messages.values()].find((x) => x.payload?.title === body.title);
        if (!m) return json(res, 404, { error: 'no message with that title' });
        m.availability = body.state;
        pushConv(world, key(m.sender_id, m.message_id), { kind: 'availability', availability: body.state, event_id: `av${world.convSeq + 1}` });
        return json(res, 200, { ok: true });
      }
      case 'remove': {
        const m = [...world.messages.values()].find((x) => x.payload?.title === body.title);
        if (!m) return json(res, 404, { error: 'no message with that title' });
        world.messages.delete(key(m.sender_id, m.message_id));
        (world.removedMessages = world.removedMessages ?? []).push(m);
        return json(res, 200, { ok: true });
      }
      case 'restore': {
        // The last removed message comes back.
        const m = world.removedMessages?.pop();
        if (!m) return json(res, 404, { error: 'nothing removed' });
        world.messages.set(key(m.sender_id, m.message_id), m);
        return json(res, 200, { ok: true });
      }
      case 'active':
        // The account's pause is lifted.
        world.inactive = false;
        return json(res, 200, { ok: true });
      default:
        if (v2Control(world, what, body)) return json(res, 200, { ok: true });
        return json(res, 404, {});
    }
  }

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: async () => {
      clearInterval(v2Timer);
      v2DropAll(world);
      await viteServer?.close();
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startFakeServer().then(({ port }) => console.log(`Harklight web client on http://127.0.0.1:${port}/inbox (fake Server)`));
}
