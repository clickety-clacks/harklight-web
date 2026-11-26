// Client API v2 for the fake Server, written from the field contract
// (docs/client-api-v2.md in the Server repository). Items and entries are
// derived from the world's messages and events, and every difference since
// the last look becomes one change in the person's change log, numbered by
// rev. It is not a server implementation.

import { createHash, randomUUID } from 'node:crypto';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Inbox page size when the client asks for none. Smaller than the contract's 50, so paging gets exercised. */
const INBOX_PAGE = 20;
const ENTRY_PAGE = 50;
const HEARTBEAT_MS = 5000;
/** The answer-screen limits Harklight Server publishes (answer_ui_limits). */
const PUBLISHED_UI1_LIMITS = {
  document_bytes: 1_048_576,
  requires: 32,
  illustrations: 256,
  primitives_per_illustration: 4_096,
  primitives_total: 16_384,
  inputs: 128,
  actions: 512,
  scene_nodes: 4_096,
  scene_depth: 64,
  result_nodes: 4_096,
  result_depth: 64,
  result_point_path: 64,
  array_items: 4_096,
  object_members: 4_096,
  identifier_bytes: 512,
};

const key = (s, m) => `${s}\u0000${m}`;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const pad = (n, w = 10) => String(Math.max(0, Math.floor(n))).padStart(w, '0');

/** An opaque item id: never parsed by the client. */
export function itemIdOf(m) {
  return `it_${Buffer.from(key(m.sender_id, m.message_id)).toString('base64url')}`;
}

function v2State(w) {
  if (!w.v2) {
    w.v2 = {
      rev: 0,
      floor: 0, // changes with rev <= floor are no longer retained
      changes: [],
      last: new Map(), // resource id -> JSON of its last emitted state (without rev)
      revs: new Map(), // resource id -> rev
      positions: new Map(), // entry id -> position
      nextPosition: new Map(), // item id -> next position
      entryIds: new Map(), // world event -> entry id
      idem: new Map(), // Idempotency-Key -> {digest, status, body}
      downloadableUploads: new Map(), // download FileRef id -> upload
      inlineFiles: new Map(), // file id -> {bytes, name}
      feeds: new Set(),
      continuations: new Map(),
      removed: new Set(),
      failFeeds: 0,
    };
  }
  return w.v2;
}

// ---------- deriving resources from the world ----------

function fileRef(w, f) {
  const v = v2State(w);
  if (f.fixtureBytesBase64 !== undefined) {
    const bytes = Buffer.from(f.fixtureBytesBase64, 'base64');
    const id = `f_${sha(bytes).slice(0, 32)}`;
    if (!v.inlineFiles.has(id)) v.inlineFiles.set(id, { bytes, name: f.name });
    return { file_id: id, name: f.name, size: bytes.length, sha256: sha(bytes) };
  }
  const content_type = v.downloadableUploads.get(f.file_id)?.contentType;
  return { file_id: f.file_id, name: f.name, size: f.size, sha256: f.sha256, ...(content_type ? { content_type } : {}) };
}

/** The fake's priority level: the message's urgency. */
function levelOf(m) {
  return m.payload.urgency === 'now' ? 'now' : m.payload.urgency === 'high' ? 'high' : 'normal';
}

function score(m) {
  return m.payload.urgency === 'now' ? 0.95 : m.payload.urgency === 'high' ? 0.75 : 0.4;
}

/**
 * Rank from the world's placement (w.placement):
 * an item's key is its row's place, its section current or resolved, and an
 * unread chat-reply row gets its own key in the same space.
 */
function placementOf(w, m) {
  const list = w.placement ? w.placement() : [];
  const at = (kind) => list.findIndex((it) => it.kind === kind && it.sender_id === m.sender_id && it.message_id === m.message_id);
  const row = list[at('message')];
  const reply = at('reply');
  const resolved = row?.free_section?.state === 'history' || (!row && !!m.terminal);
  // A progress message is not in the priority view: no score, no level. A
  // selected ranking (the selected-ranking control) sends scores but no level.
  // Tests can set either directly with x_rank on a sent message (null omits it).
  const override = m.payload.x_rank ?? {};
  const sc = 'score' in override ? override.score : m.payload.progress ? null : score(m);
  const lv = 'level' in override ? override.level : w.selectedRanking || m.payload.progress ? null : levelOf(m);
  return {
    rank: {
      key: pad(at('message') + 1, 6),
      ...(sc === null ? {} : { score: sc }),
      section: resolved ? 'resolved' : 'current',
      ...(resolved ? {} : { ...(w.standardOrder ? {} : { group: 'common' }), ...(lv === null ? {} : { level: lv }) }),
    },
    replyKey: reply >= 0 && list[reply].unseen_count > 0 ? pad(reply + 1, 6) : null,
  };
}

/** When each terminal state was first seen, so it reads the same every time. */
const terminalAt = new WeakMap();

function terminalOf(w, m) {
  const t = m.terminal;
  if (!t) return null;
  if (!terminalAt.has(t)) terminalAt.set(t, t.at ?? Date.now());
  const at_ms = terminalAt.get(t);
  if (t.terminal_reason === 'retracted') return { state: 'retracted', at_ms };
  const state = ['answered', 'cleared', 'expired', 'superseded'].includes(t.state) ? t.state : 'answered';
  // Terminal.answer is the person-facing answer outcome, carried as it is.
  const o = t.terminal_kind === 'no_comment' ? { kind: 'no_comment' } : t.answer_outcome;
  const answer = o && ['seen', 'reply', 'default', 'no_comment', 'choice', 'result'].includes(o.kind)
    ? {
        kind: o.kind,
        ...(typeof o.text === 'string' ? { text: o.text } : {}),
        ...((o.kind === 'default' || o.kind === 'result') && 'value' in o ? { value: o.value } : {}),
        ...(o.kind === 'choice' ? { id: o.id, label: o.label } : {}),
      }
    : null;
  return { state, at_ms, ...(answer ? { answer } : {}), by_this_person: state === 'answered' };
}

function convOf(w, m) {
  return w.conv.filter((e) => e.sender_id === m.sender_id && e.message_id === m.message_id);
}

function entryIdFor(w, ev) {
  const v = v2State(w);
  let id = v.entryIds.get(ev);
  if (!id) {
    id = ev.type === 'lifecycle' ? `en_l${ev.seq}` : `en_${ev.event_id ?? ev.conversation_seq}`;
    v.entryIds.set(ev, id);
  }
  return id;
}

function positionFor(w, itemId, entryId) {
  const v = v2State(w);
  if (!v.positions.has(entryId)) {
    const next = v.nextPosition.get(itemId) ?? 1;
    v.positions.set(entryId, next);
    v.nextPosition.set(itemId, next + 1);
  }
  return v.positions.get(entryId);
}

/** The item's entries, without rev, in creation order. */
function sharedEnabled(req, w) {
  return w.sharedMessages && req.headers['harklight-features'] === 'shared_messages';
}

function fixtureSpeaker(w, m, entry) {
  if (entry.speaker) return entry.speaker;
  if (entry.author === 'person') return w.sharedViewer;
  return { kind: 'sender', id: m.sender_id, display_name: 'Release team' };
}

function visibleChange(change, shared, w) {
  return shared || !w.sharedFixture || change.data.item_id !== itemIdOf(w.sharedFixture);
}

function entriesOf(w, m) {
  const itemId = itemIdOf(m);
  const conv = convOf(w, m);
  const out = [];
  // Delivered: a receipt says so, or the agent replied to the turn.
  const delivered = new Set([
    ...conv.filter((e) => e.kind === 'receipt' && e.delivered !== false).map((e) => e.event_id),
    ...conv.filter((e) => e.kind === 'reply' && e.in_reply_to).map((e) => e.in_reply_to),
  ]);
  for (const e of conv) {
    if (e.kind !== 'discussion' && e.kind !== 'reply' && e.kind !== 'availability') continue;
    const entry_id = entryIdFor(w, e);
    const base = {
      entry_id,
      item_id: itemId,
      position: positionFor(w, itemId, entry_id),
      ...(e.at_ms !== undefined ? { at_ms: e.at_ms } : {}),
      request_revision: e.request_revision ?? m.revision,
    };
    if (e.kind === 'availability') {
      out.push({ ...base, kind: 'availability', author: 'server', availability: { state: e.availability } });
      continue;
    }
    const files = (e.files ?? []).map((f) => fileRef(w, f));
    const person = e.author === 'person';
    out.push({
      ...base,
      kind: 'reply',
      author: e.author === 'server' ? 'server' : person ? 'person' : 'origin',
      text: e.text ?? '',
      ...(files.length ? { files } : {}),
      ...(!person && e.in_reply_to ? { in_reply_to: `en_${e.in_reply_to}` } : {}),
      state: e.state ?? 'active',
      ...(m.shared ? { shared_entry_id: `shared_${entry_id}`, speaker: fixtureSpeaker(w, m, e) } : {}),
      ...(person ? { delivery: { delivered: delivered.has(e.event_id), acted: false, ...e.delivery } } : {}),
    });
  }
  // A lifecycle entry is only the retraction fact; answers live on Item.terminal.
  for (const ev of w.events) {
    if (ev.type !== 'lifecycle' || ev.terminal_reason !== 'retracted' || ev.sender_id !== m.sender_id || ev.message_id !== m.message_id) continue;
    const entry_id = entryIdFor(w, ev);
    out.push({
      entry_id,
      item_id: itemId,
      position: positionFor(w, itemId, entry_id),
      at_ms: ev.at ?? 0,
      request_revision: m.revision,
      kind: 'lifecycle',
      author: 'origin',
      terminal: { state: 'retracted', at_ms: ev.at ?? 0 },
    });
  }
  return out.sort((a, b) => a.position - b.position);
}

/** When each message first reached the person. */
const firstSeen = new WeakMap();

function itemOf(w, m) {
  const conv = convOf(w, m);
  const entries = entriesOf(w, m);
  const replies = entries.filter((e) => e.kind === 'reply' && e.author === 'origin');
  const readSeq = w.readPositions.get(key(m.sender_id, m.message_id));
  const readEv = readSeq === undefined ? null : conv.find((e) => e.conversation_seq === readSeq);
  const placed = placementOf(w, m);
  const unread = conv.filter((e) => e.conversation_seq > (readSeq ?? 0) &&
    ((e.kind === 'reply' && e.author !== 'server') || (m.shared && e.kind === 'discussion' && e.speaker?.id && e.speaker.id !== w.sharedViewer.id))).length;
  const terminal = terminalOf(w, m);
  if (terminal && m.answerSpeaker) Object.assign(terminal, {
    speaker: m.answerSpeaker, answer_id: 'example-answer', by_this_person: false,
  });
  if (!firstSeen.has(m)) firstSeen.set(m, Date.now());
  return {
    item_id: itemIdOf(m),
    sender: m.sender_id,
    request_revision: m.revision,
    message: m.payload,
    files: (m.files ?? []).map((f) => fileRef(w, f)),
    seen: m.seenRevision === m.revision,
    as: 'knock',
    chat: {
      available: !!m.session_handle,
      started: conv.some((e) => e.kind === 'discussion' || e.kind === 'reply'),
      read_position: readEv ? entryIdFor(w, readEv) : null,
      last_origin_reply: replies.length ? replies[replies.length - 1].entry_id : null,
      unread_replies: unread,
      ...(unread > 0 && placed.replyKey ? { reply_rank_key: placed.replyKey, reply_priority: { level: levelOf(m) } } : {}),
    },
    created_at_ms: firstSeen.get(m),
    // The fake's effective thread is the message's own thread, when it has one.
    ...(typeof m.payload.thread === 'string' ? { thread: m.payload.thread } : {}),
    ...(m.session_handle ? { availability: { state: m.availability ?? 'listening' } } : {}),
    terminal,
    ...(m.shared ? { shared: m.shared } : {}),
    rank: placed.rank,
  };
}

function append(w, kind, id, data) {
  const v = v2State(w);
  v.rev += 1;
  v.revs.set(id, v.rev);
  const change = { rev: v.rev, kind, data: kind === 'item_removed' || kind === 'counts' ? data : { ...data, rev: v.rev } };
  v.changes.push(change);
  return change;
}

/** Turn every difference since the last look into changes, then feed them out. */
export function syncV2(w) {
  const v = v2State(w);
  for (const m of w.messages.values()) {
    const item = itemOf(w, m);
    const s = JSON.stringify(item);
    // A removed item that comes back is a new change, with a rev above its tombstone.
    if (v.removed.delete(item.item_id)) v.last.delete(item.item_id);
    if (v.last.get(item.item_id) !== s) {
      v.last.set(item.item_id, s);
      append(w, 'item', item.item_id, item);
    }
    for (const e of entriesOf(w, m)) {
      const es = JSON.stringify(e);
      if (v.last.get(e.entry_id) !== es) {
        v.last.set(e.entry_id, es);
        append(w, 'entry', e.entry_id, e);
      }
    }
  }
  for (const id of v.last.keys()) {
    if (!id.startsWith('it_') || v.removed.has(id)) continue;
    if (![...w.messages.values()].some((m) => itemIdOf(m) === id)) {
      v.removed.add(id);
      append(w, 'item_removed', id, { item_id: id });
    }
  }
  for (const f of v.feeds) f.pump();
}

function withRev(w, id, data) {
  return { ...data, rev: v2State(w).revs.get(id) };
}

// ---------- HTTP ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'request-id': res.requestId, ...headers });
  res.end(JSON.stringify(body));
}

function fail(res, status, error, { retryAfter = 0, ...extra } = {}) {
  const retryable = status === 503;
  send(res, status, { error, retryable, request_id: res.requestId, ...extra }, retryable ? { 'retry-after': String(retryAfter) } : {});
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function findItem(w, id) {
  return [...w.messages.values()].find((m) => itemIdOf(m) === id);
}

/** Serve one /v2 request. `ctx` carries the world's mutators from fake-server.mjs. */
export async function serveV2(req, res, url, w, ctx) {
  res.requestId = `rq_${randomUUID()}`;
  const v = v2State(w);
  const p = url.pathname.slice('/v2'.length);
  const method = req.method;
  // A signed-out browser gets 401 JSON on every /v2 path, never a redirect.
  if (!w.sessionLive) return fail(res, 401, 'unauthorized');
  // A paused account: 403 account_paused on every /v2 request but GET /v2/me.
  if (w.inactive && p !== '/me') return fail(res, 403, 'account_paused');
  const fault = v.internalError;
  if (fault?.path === p && fault.method === method &&
      !(p === '/changes' && String(req.headers.accept ?? '').includes('text/event-stream'))) {
    return fail(res, 500, 'internal_error');
  }
  if (p.startsWith('/devices/me') && !(method === 'PUT' && p === '/devices/me/focus')) {
    return fail(res, 403, 'forbidden');
  }
  if (w.refuseReads && method === 'GET' && (p === '/inbox' || p === '/changes')) return fail(res, 400, 'invalid_field');
  if (w.badGateway && method === 'GET' && (p === '/inbox' || p === '/changes')) {
    res.writeHead(502, { 'content-type': 'text/html' });
    return res.end('<html><body>Bad gateway</body></html>');
  }
  if (method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return fail(res, 403, 'forbidden');
  }
  syncV2(w);

  if (method === 'PUT' && p === '/devices/me/focus') {
    const body = JSON.parse((await readBody(req)).toString());
    if (!w.sessionLive) return fail(res, 401, 'unauthorized');
    const { screen, ttl_s, device_name, item_id, visible_entry_id } = body;
    if (!['inbox', 'fyi', 'message', 'chat', 'settings', 'signed_out', 'not_in_front'].includes(screen) ||
        !Number.isInteger(ttl_s) || ttl_s < 1 || ttl_s > 3600 ||
        ((device_name !== undefined || screen !== 'signed_out') &&
          (typeof device_name !== 'string' || !device_name.trim() || Buffer.byteLength(device_name) > 128))) {
      return fail(res, 400, 'invalid_field');
    }
    if (screen === 'message' || screen === 'chat') {
      if (!findItem(w, item_id)) return fail(res, 400, 'invalid_field');
    } else if (item_id !== undefined) return fail(res, 400, 'invalid_field');
    if (visible_entry_id !== undefined && (screen !== 'chat' || typeof visible_entry_id !== 'string')) {
      return fail(res, 400, 'invalid_field');
    }
    (w.focusReports ??= []).push(body);
    return send(res, 200, { rev: v.rev });
  }

  if (method === 'GET' && p === '/changes') return changes(req, res, url, w);
  if (method === 'GET' && p === '/me') {
    return send(res, 200, {
      account: { state: w.inactive ? 'paused' : 'active' },
      limits: {
        upload_cap_bytes_per_file: w.uploadCap ?? 'none',
        inline_decoded_bytes_per_entry: 262_144,
        answer_ui_limits: PUBLISHED_UI1_LIMITS,
        retention_days: 30,
      },
      features: { server_matched_push_routing: true, priority_level_editing: true,
        ...(w.sharedMessages !== undefined ? { shared_messages: w.sharedMessages } : {}) },
      ...(w.sharedViewer ? { principal: { kind: 'person', person_id: w.sharedViewer.id } } : {}),
    });
  }
  if (method === 'GET' && p === '/inbox') {
    const shared = sharedEnabled(req, w);
    const items = [...w.messages.values()].filter((m) => shared || !m.shared).map((m) => withRev(w, itemIdOf(m), itemOf(w, m)));
    items.sort((a, b) => (a.rank.key < b.rank.key ? -1 : a.rank.key > b.rank.key ? 1 : 0));
    const limit = Math.min(Number(url.searchParams.get('limit') ?? INBOX_PAGE) || INBOX_PAGE, 200);
    const token = url.searchParams.get('page');
    const prefix = 'shared:';
    if (token && token.startsWith(prefix) !== !!shared) return fail(res, 410, 'cursor_expired');
    const at = Number(token ? (shared ? token.slice(prefix.length) : token) : 0);
    const page = items.slice(at, at + limit);
    const continuation = shared ? randomUUID() : null;
    if (continuation) v.continuations.set(continuation, v.rev);
    return send(res, 200, {
      rev: v.rev,
      items: page,
      ...(continuation ? { continuation } : {}),
      counts: { unresolved: items.filter((i) => !i.terminal).length },
      ...(items.length > at + limit ? { next_page: (shared ? prefix : '') + (at + limit) } : {}),
    });
  }
  if (method === 'GET' && p.startsWith('/files/')) {
    const id = decodeURIComponent(p.slice('/files/'.length));
    if (!sharedEnabled(req, w) && w.sharedFixture?.files.some((f) => fileRef(w, f).file_id === id)) {
      return fail(res, 404, 'not_found');
    }
    const up = v.downloadableUploads.get(id);
    const inline = v.inlineFiles.get(id);
    const bytes = up?.bytes ?? inline?.bytes;
    if (!bytes) return fail(res, 404, 'not_found');
    // Served to a browser as a download, never inline on the web origin.
    const name = up?.name ?? inline?.name ?? 'file';
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      etag: `"${sha(bytes)}"`,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'x-content-type-options': 'nosniff',
      'request-id': res.requestId,
    });
    return res.end(bytes);
  }
  if (method === 'DELETE' && p.startsWith('/files/')) {
    const handle = decodeURIComponent(p.slice('/files/'.length));
    if (!w.uploads.has(handle)) return fail(res, 404, 'not_found');
    if (v.downloadableUploads.has(`fu${handle}`)) return fail(res, 409, 'already_closed');
    w.uploads.delete(handle);
    res.writeHead(204, { 'request-id': res.requestId });
    return res.end();
  }
  if (method === 'POST' && p === '/files') {
    if (!UUID4.test(String(req.headers['idempotency-key'] ?? ''))) return fail(res, 400, 'invalid_field', { field: 'Idempotency-Key' });
    return upload(req, res, w);
  }

  const m = /^\/items\/([^/]+)(\/[a-z-]+(?:\/[0-9]+)?)?$/.exec(p);
  if (!m) return fail(res, 404, 'not_found');
  const item = findItem(w, decodeURIComponent(m[1]));
  if (!item || (item.shared && !sharedEnabled(req, w))) return fail(res, 404, 'not_found');
  const k = key(item.sender_id, item.message_id);
  const sub = m[2] ?? '';
  if (method === 'GET' && sub === '') return send(res, 200, { rev: v.rev, item: withRev(w, itemIdOf(item), itemOf(w, item)) });
  const revision = /^\/revisions\/([0-9]+)$/.exec(sub);
  if (method === 'GET' && revision) {
    // The fake keeps one revision of each message.
    if (Number(revision[1]) !== item.revision) return fail(res, 404, 'not_found');
    return send(res, 200, { rev: v.rev, revision: { request_revision: item.revision, message: item.payload, files: (item.files ?? []).map((f) => fileRef(w, f)) } });
  }
  if (method === 'GET' && sub === '/entries') {
    const all = entriesOf(w, item).map((e) => withRev(w, e.entry_id, e));
    const before = url.searchParams.get('before');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? ENTRY_PAGE) || ENTRY_PAGE, 200);
    const cut = before ? all.filter((e) => e.position < (all.find((x) => x.entry_id === before)?.position ?? 0)) : all;
    const page = cut.slice(Math.max(0, cut.length - limit));
    return send(res, 200, { rev: v.rev, entries: page, older: cut.length > page.length });
  }

  const raw = await readBody(req);
  let body;
  try {
    body = raw.length ? JSON.parse(raw.toString()) : {};
  } catch {
    return fail(res, 400, 'invalid_field');
  }
  const done = (entryOf) => {
    syncV2(w);
    const out = { rev: v.rev, item: withRev(w, itemIdOf(item), itemOf(w, item)) };
    const entry = entryOf?.();
    if (entry) out.entry = withRev(w, entry.entry_id, entry);
    return out;
  };

  if (method === 'POST' && sub === '/seen') {
    return idempotent(req, res, w, raw, () => {
      if (item.shared) {
        if (Object.keys(body).length !== 1 || !Number.isInteger(body.request_revision)) {
          return [400, { error: 'invalid_field', retryable: false }];
        }
        if (body.request_revision !== item.revision) return [409, { error: 'stale_request', retryable: false }];
        item.shared = { ...item.shared, members: item.shared.members.map((member) => member.person.id === w.sharedViewer.id
          ? { ...member, seen_revision: item.revision, seen_at_ms: member.seen_at_ms ?? Date.now() } : member) };
      } else if (Object.keys(body).length) return [400, { error: 'invalid_field', retryable: false }];
      item.seenRevision = item.revision;
      w.opens = (w.opens ?? 0) + 1;
      return [200, done()];
    });
  }
  if (method === 'PUT' && sub === '/read-position') {
    const keys = Object.keys(body);
    if (keys.length !== 1 || typeof body.entry_id !== 'string') return fail(res, 400, 'invalid_field', { field: 'entry_id' });
    const ev = convOf(w, item).find((e) => (e.kind === 'reply' || (item.shared && e.kind === 'discussion')) && entryIdFor(w, e) === body.entry_id);
    if (!ev) return fail(res, 400, 'invalid_field', { field: 'entry_id' });
    const cur = w.readPositions.get(k) ?? 0;
    if (ev.conversation_seq > cur) ctx.readTo(k, ev.conversation_seq);
    return send(res, 200, done());
  }
  if (method === 'POST' && sub === '/replies') {
    return idempotent(req, res, w, raw, () => {
      if (w.refuseInactive) return [403, { error: 'account_paused', retryable: false }];
      // An item with no agent conversation takes no reply (Chat.available false).
      if (!item.session_handle) return [400, { error: 'unsupported', retryable: false }];
      const extra = Object.keys(body).filter((x) => x !== 'text' && x !== 'file_ids');
      if (extra.length || typeof body.text !== 'string') return [400, { error: 'invalid_field', field: 'text', retryable: false }];
      const ids = body.file_ids ?? [];
      if (!Array.isArray(ids)) return [400, { error: 'invalid_field', field: 'file_ids', retryable: false }];
      if (body.text === '' && ids.length === 0) return [400, { error: 'invalid_field', field: 'text', retryable: false }];
      const uploads = ids.map((id) => w.uploads.get(id));
      if (uploads.some((up) => !up)) return [400, { error: 'invalid_field', field: 'file_ids', retryable: false }];
      const files = uploads.map((up) => {
        const file_id = `fu${up.id}`;
        v.downloadableUploads.set(file_id, up);
        return { name: up.name, file_id, size: up.size, sha256: up.sha256 };
      });
      // Replies are taken in every item state (answered, finished, retracted,
      // agent not listening): they are stored and delivered when the agent is back.
      const ev = ctx.personTurn(k, body.text, files);
      w.lastDiscussion = { key: k, text: body.text, files };
      return [200, done(() => entriesOf(w, item).find((e) => e.entry_id === entryIdFor(w, ev)))];
    });
  }
  if (method === 'POST' && sub === '/answer') return answer(req, res, w, raw, body, item, k, ctx, done);
  return fail(res, 404, 'not_found');
}

/** Answer validation and effect, as the contract's section 5 states it. */
function answer(req, res, w, raw, body, item, k, ctx, done) {
  const idemKey = req.headers['idempotency-key'] ?? null;
  // What the request answers (answerFrames[].answer), for tests.
  const actions = Array.isArray(item.payload.answer_ui?.actions) ? item.payload.answer_ui.actions : [];
  const chosen = actions.find((x) => x.id === body.choice);
  const answer = 'comment' in body ? body.comment : 'result' in body ? body.result : chosen ? (chosen.id === 'seen' && actions.length === 1 ? null : chosen.value) : null;
  // The client resends a 503 by itself, with the same key, twice before it
  // shows the failure (Retry-After 0 here). Those resends are kept apart from
  // the person's own sends, so tests count what the person did.
  w.busyStreak = w.busyStreak ?? new Map();
  const streak = w.busyStreak.get(idemKey) ?? 0;
  const auto = w.failAnswers && streak % 3 !== 0;
  const record = () => (auto ? (w.answerResends = w.answerResends ?? []) : (w.answerFrames = w.answerFrames ?? [])).push({ op_id: idemKey, answer, body });
  const run = () => {
    const extra = Object.keys(body).filter((x) => !['request_revision', 'choice', 'comment', 'result'].includes(x));
    // Presence counts: "result": null is a result whose value is null.
    const given = ['choice', 'comment', 'result'].filter((x) => x in body);
    if (extra.length || !Number.isInteger(body.request_revision) || given.length > 1) return [400, { error: 'invalid_field', retryable: false }];
    if (w.refuseAnswers) {
      const token = { closed: 'already_answered', retracted: 'already_retracted', stale_revision: 'stale_request' }[w.refuseAnswers] ?? w.refuseAnswers;
      return [409, { error: token, retryable: false }];
    }
    if (item.terminal?.terminal_reason === 'retracted') return [409, { error: 'already_retracted', retryable: false }];
    if (item.terminal) return [409, { error: 'already_answered', retryable: false }];
    if (body.request_revision !== item.revision) return [409, { error: 'stale_request', retryable: false }];
    const ui = item.payload.answer_ui;
    const actions = ui && ui.schema === 'attention-client.actions/1' && Array.isArray(ui.actions) ? ui.actions : [];
    let value;
    let chosen = null;
    let isResult = false;
    let text;
    if ('choice' in body) {
      const a = actions.find((x) => x.id === body.choice && x.kind === 'value');
      if (!a) return [400, { error: 'invalid_field', field: 'choice', retryable: false }];
      value = a.id === 'seen' && actions.length === 1 ? null : a.value;
      chosen = value === null ? null : a;
    } else if ('comment' in body) {
      // A plain written answer is taken on every answerable item (terminal is
      // null), whatever its answer screen, an FYI included.
      if (typeof body.comment !== 'string') return [400, { error: 'invalid_field', field: 'comment', retryable: false }];
      value = body.comment;
      text = body.comment;
    } else if ('result' in body) {
      // Any JSON value, stored unchanged; only a ui/1 item takes one.
      if (!ui || ui.schema !== 'attention-client.ui/1') return [400, { error: 'invalid_field', field: 'result', retryable: false }];
      value = body.result;
      isResult = true;
    } else {
      ctx.terminate(k, { state: 'answered', terminal_kind: 'no_comment', by: 'answer_no_comment', answer_outcome: { kind: 'no_comment' } });
      w.lastAnswer = { key: k, answer: null, noComment: true };
      return [200, done()];
    }
    // A value action's answer names the action (kind choice); a written one is a reply.
    // The kind follows what was answered, never the value's shape.
    const outcome = isResult
      ? { kind: 'result', value }
      : 'choice' in body
        ? chosen
          ? { kind: 'choice', id: chosen.id, label: chosen.label }
          : { kind: 'seen' }
        : text !== undefined
          ? { kind: 'reply', text }
          : undefined;
    ctx.terminate(k, { state: 'answered', by: 'answer', ...(outcome ? { answer_outcome: outcome } : {}) });
    w.lastAnswer = { key: k, answer: value };
    return [200, done()];
  };
  record();
  if (w.failAnswers) {
    w.busyStreak.set(idemKey, streak + 1);
    return fail(res, 503, 'storage_unavailable', { retryAfter: 0 });
  }
  w.busyStreak.delete(idemKey);
  if (w.holdAnswers) {
    w.held = w.held ?? [];
    (w.heldSockets = w.heldSockets ?? []).push(req.socket);
    let alive = true;
    req.socket.once('close', () => (alive = false));
    // On release the answer is applied even if the client is gone: the
    // Server did the work and only the response was lost.
    const lost = { requestId: res.requestId, writeHead() {}, end() {} };
    w.held.push(() => idempotent(req, alive ? res : lost, w, raw, run));
    return;
  }
  return idempotent(req, res, w, raw, run);
}

/** Every POST needs an Idempotency-Key; a repeat replays the stored response. */
function idempotent(req, res, w, raw, run) {
  const k = req.headers['idempotency-key'];
  if (req.method === 'POST' && (typeof k !== 'string' || !UUID4.test(k))) return fail(res, 400, 'invalid_field', { field: 'Idempotency-Key' });
  if (typeof k !== 'string') {
    const [status, body] = run();
    return send(res, status, status >= 400 ? { ...body, request_id: res.requestId } : body);
  }
  const v = v2State(w);
  const digest = sha(Buffer.concat([Buffer.from(`${req.method} ${req.url}\n`), raw]));
  const held = v.idem.get(k);
  if (held) {
    if (held.digest !== digest) return fail(res, 409, 'idempotency_conflict');
    w.replays = (w.replays ?? 0) + 1;
    return send(res, held.status, held.body, { 'idempotent-replayed': 'true' });
  }
  const out = run();
  if (!out) return; // the handler answered itself
  const [status, body] = out;
  const full = status >= 400 ? { ...body, request_id: res.requestId } : body;
  v.idem.set(k, { digest, status, body: full });
  return send(res, status, full);
}

/** The name from `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>` (RFC 6266, 5987). */
function fileNameOf(header) {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(String(header ?? ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].trim()) || null;
  } catch {
    return null;
  }
}

async function upload(req, res, w) {
  const len = Number(req.headers['content-length'] ?? -1);
  if (len > w.uploadCap) return fail(res, 413, 'payload_too_large');
  const bytes = await readBody(req);
  const k = req.headers['idempotency-key'];
  const v = v2State(w);
  const digest = sha(Buffer.concat([Buffer.from(`${req.method} ${req.url}\n`), bytes]));
  const held = v.idem.get(k);
  if (held) {
    if (held.digest !== digest) return fail(res, 409, 'idempotency_conflict');
    w.replays = (w.replays ?? 0) + 1;
    return send(res, held.status, held.body, { 'idempotent-replayed': 'true' });
  }
  const name = fileNameOf(req.headers['content-disposition']);
  if (!name) return fail(res, 400, 'invalid_field', { field: 'name' });
  const id = `f_${randomUUID()}`;
  const up = { id, name, size: bytes.length, sha256: sha(bytes), bytes, contentType: req.headers['content-type'] };
  w.uploads.set(id, up);
  const body = { file_id: id, name, sha256: up.sha256, size: up.size };
  v.idem.set(k, { digest, status: 201, body });
  (w.v2Uploads = w.v2Uploads ?? []).push({ size: up.size, contentType: up.contentType });
  return send(res, 201, body);
}

// ---------- the change feed ----------

function changes(req, res, url, w) {
  const v = v2State(w);
  const lastId = req.headers['last-event-id'];
  // Last-Event-ID takes precedence over ?after.
  const afterText = typeof lastId === 'string' && lastId !== '' ? lastId : (url.searchParams.get('after') ?? '0');
  const after = Number(afterText);
  if (!Number.isInteger(after) || after < 0) return fail(res, 400, 'invalid_field', { field: 'after' });
  const shared = sharedEnabled(req, w);
  const token = req.headers['harklight-continuation'];
  const baseline = v.continuations.get(token);
  if ((shared && (baseline === undefined || baseline > after)) || (!shared && token !== undefined)) {
    return fail(res, 410, 'cursor_expired');
  }
  if (after < v.floor) return fail(res, 410, 'cursor_expired');
  const sse = String(req.headers.accept ?? '').includes('text/event-stream');
  if (!sse) {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 500);
    const eligible = v.changes.filter((c) => c.rev > after && visibleChange(c, shared, w));
    const list = eligible.slice(0, limit);
    const more = eligible.length > list.length;
    // rev is the position the batch is complete through: past its last change
    // when the rest of the log is rows with nothing to send.
    return send(res, 200, { changes: list, rev: more ? list[list.length - 1].rev : Math.max(v.rev, after), more });
  }
  if (v.failFeeds > 0) {
    v.failFeeds -= 1;
    return fail(res, 503, 'retry_later', { retryAfter: 0 });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'request-id': res.requestId, 'x-accel-buffering': 'no' });
  res.flushHeaders();
  (w.feedOpens = w.feedOpens ?? []).push({ after, lastEventId: typeof lastId === 'string' ? lastId : null });
  const feed = {
    sent: after,
    res,
    muted: false,
    pump() {
      if (this.muted) return;
      for (const c of v.changes) {
        if (c.rev <= this.sent) continue;
        this.sent = c.rev;
        if (!visibleChange(c, shared, w)) continue;
        res.write(`id: ${c.rev}\nevent: ${c.kind}\ndata: ${JSON.stringify(c.data)}\n\n`);
      }
    },
    close(reason) {
      // The closing event carries no id: it is not a change and must not move Last-Event-ID.
      if (reason) res.write(`event: closing\ndata: ${JSON.stringify({ reason })}\n\n`);
      res.end();
      v.feeds.delete(feed);
    },
    drop() {
      res.socket?.destroy();
      v.feeds.delete(feed);
    },
  };
  v.feeds.add(feed);
  // The heartbeat is an event with no id: it never moves Last-Event-ID.
  const beat = setInterval(() => feed.muted || res.write('event: heartbeat\ndata: {}\n\n'), w.heartbeatMs ?? HEARTBEAT_MS);
  res.on('close', () => {
    clearInterval(beat);
    v.feeds.delete(feed);
  });
  feed.pump();
}

/** Test controls on the v2 side of the world. */
export function v2Control(w, what, body) {
  const v = v2State(w);
  switch (what) {
    case 'change-shared-scope':
      v.continuations.clear();
      for (const f of [...v.feeds]) body.drop ? f.drop() : f.close('cursor_expired');
      return true;
    case 'expire-cursor': {
      // Cursors from before now are past retention: the next resume gets 410.
      // With `remove`, that message is removed first, so no tab sees the
      // removal as a change.
      for (const f of [...v.feeds]) f.drop();
      const m = body.remove ? [...w.messages.values()].find((x) => x.payload?.title === body.remove) : null;
      if (m) w.messages.delete(key(m.sender_id, m.message_id));
      syncV2(w);
      // One more change the tab never sees, then prune everything before now:
      // a cursor from before is expired, a snapshot read now is not.
      append(w, 'counts', 'counts', { unresolved: [...w.messages.values()].filter((x) => !x.terminal).length });
      v.floor = v.rev;
      return true;
    }
    case 'internal-error':
      v.internalError = body.on === false ? null : { path: body.path ?? '/changes', method: body.method ?? 'GET' };
      if (body.drop) for (const f of [...v.feeds]) f.drop();
      return true;
    case 'revoke':
      for (const f of [...v.feeds]) f.close('revoked');
      return true;
    case 'server-shutdown':
      for (const f of [...v.feeds]) f.close('server_shutdown');
      return true;
    case 'closing': {
      // End open feeds with a closing event of the given reason. For
      // cursor_expired the log before now is pruned first (optionally after
      // removing a message by title, so no tab sees that as a change).
      if (body.reason === 'cursor_expired') {
        const m = body.remove ? [...w.messages.values()].find((x) => x.payload?.title === body.remove) : null;
        for (const f of [...v.feeds]) f.muted = true;
        if (m) w.messages.delete(key(m.sender_id, m.message_id));
        syncV2(w);
        append(w, 'counts', 'counts', { unresolved: [...w.messages.values()].filter((x) => !x.terminal).length });
        v.floor = v.rev;
      }
      for (const f of [...v.feeds]) f.close(body.reason);
      return true;
    }
    case 'fail-feeds':
      v.failFeeds = body.count ?? 1;
      return true;
    case 'formless':
      // Log rows with nothing a client is sent (count of them): the position moves, no change does.
      v.rev += body.count ?? 1;
      return true;
    case 'selected-ranking':
      // A selected ranking is in use: current items carry a score but no level.
      w.selectedRanking = body.on !== false;
      return true;
    case 'heartbeat':
      // Heartbeat interval for feeds opened from now on.
      w.heartbeatMs = body.ms;
      return true;
    case 'mute-feeds':
      // Open feeds go silent (no changes, no heartbeat) without closing: a dead path the browser has not noticed.
      for (const f of v.feeds) f.muted = true;
      return true;
    case 'refuse-reads':
      // Every read is refused (400) and open feeds drop: a failure no retry fixes.
      w.refuseReads = body.on !== false;
      if (w.refuseReads) for (const f of [...v.feeds]) f.drop();
      return true;
    case 'bad-gateway':
      // A front end answers reads and feed opens with 502 and no contract body,
      // as while the Server restarts behind a proxy; open feeds drop.
      w.badGateway = body.on !== false;
      if (w.badGateway) for (const f of [...v.feeds]) f.drop();
      return true;
    case 'drop-feeds':
      for (const f of [...v.feeds]) f.drop();
      return true;
    default:
      return false;
  }
}

/** End feeds whose sign-in ended or whose account was paused. */
export function v2Tick(w) {
  const v = v2State(w);
  if (!w.sessionLive) for (const f of [...v.feeds]) f.close('revoked');
  else if (w.inactive) for (const f of [...v.feeds]) f.close('account_paused');
  else syncV2(w);
}

export function v2Feeds(w) {
  return v2State(w).feeds.size;
}

export function v2DropAll(w) {
  const v = v2State(w);
  for (const f of [...v.feeds]) f.drop();
}
