/**
 * Spec 104: the script of the MCP Apps view (runs in the host's sandboxed iframe, after the inlined SDK).
 *
 * Read and preview only. It draws `structuredContent.view` with createElement and textContent (never innerHTML,
 * never a parsed string), opens links only through the host (`app.openLink`, http(s) only), and never calls a tool,
 * sends a chat message or updates the model's context. A test checks the script for those calls.
 *
 * Kept as a plain-JS string (no build step for the view): no backticks and no template placeholders inside.
 */
export const WIDGET_CLIENT = String.raw`
'use strict';
var root = document.getElementById('root');
var app = new McpApps.App({ name: 'ai0-preview', version: '1' }, {}, { autoResize: true });

// ── small DOM helpers ──────────────────────────────────────────────────────
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = String(text);
  return e;
}
function str(v) { return typeof v === 'string' ? v : ''; }
function list(v) { return Array.isArray(v) ? v : []; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }

function safeUrl(u) {
  if (typeof u !== 'string' || !u || u.length > 2000) return null;
  try {
    var x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch (e) { return null; }
}
function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }
function openUrl(u) {
  var url = safeUrl(u);
  if (!url) return;
  try { app.openLink({ url: url }).catch(function () {}); } catch (e) { /* host without openLink */ }
}
function linkify(e, url) {
  var u = safeUrl(url);
  if (!u) return e;
  e.classList.add('lnk');
  e.title = u;
  e.tabIndex = 0;
  e.setAttribute('role', 'link');
  e.addEventListener('click', function (ev) { ev.preventDefault(); openUrl(u); });
  e.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); openUrl(u); } });
  return e;
}
function button(text, url, cls) {
  var b = el('button', cls || 'btn', text);
  b.type = 'button';
  var u = safeUrl(url);
  if (u) { b.title = u; b.addEventListener('click', function () { openUrl(u); }); } else b.disabled = true;
  return b;
}
function chip(text, tone) { return el('span', 'chip' + (tone ? ' ' + tone : ''), text); }
function richChip() { var c = chip('rich message'); c.title = 'Sent as a rich message; shown here as its plain fallback.'; return c; }

var GOOD = { published: 1, approved: 1, passes_checks: 1, done: 1, applied: 1, ok: 1, pass: 1, pass_with_edits: 1 };
var BAD = { failed: 1, fails_checks: 1, skipped: 1, cancelled: 1, rejected: 1, reject: 1, error: 1, expired: 1 };
var WAIT = { awaiting_approval: 1, pending: 1, running: 1, planned: 1, scheduled: 1, draft: 1, revise: 1 };
function statusChip(s) {
  s = str(s);
  if (!s) return null;
  return chip(s.replace(/_/g, ' '), GOOD[s] ? 'good' : BAD[s] ? 'bad' : WAIT[s] ? 'wait' : '');
}

// ── Telegram text: allowlisted nodes from the server, plus hashtags, mentions and bare links ──
var AUTO = /(https?:\/\/[^\s<>"]+|#[\p{L}\p{N}_]+|@[A-Za-z0-9_]{4,32})/u;
function textInto(parent, v) {
  var parts = v.split(AUTO);
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) continue;
    if (i % 2 === 0) { parent.appendChild(document.createTextNode(p)); continue; }
    var s = el('span', 'ent', p);
    if (p.charAt(0) === 'h') linkify(s, p.replace(/[).,;:!?]+$/, ''));
    parent.appendChild(s);
  }
}
var INLINE = { b: 'b', i: 'i', u: 'u', s: 's', code: 'code', quote: 'blockquote' };
function rich(parent, nodes, depth) {
  if (depth > 12) return;
  list(nodes).forEach(function (n) {
    if (!n || typeof n !== 'object') return;
    if (n.t === 'text') { textInto(parent, str(n.v)); return; }
    var e;
    if (INLINE[n.t]) e = el(INLINE[n.t], n.t === 'code' ? 'icode' : n.t === 'quote' ? 'quote' : '');
    else if (n.t === 'pre') { parent.appendChild(preBlock(n, depth)); return; }
    else if (n.t === 'spoiler') {
      e = el('span', 'spoiler');
      e.title = 'Spoiler: click to show';
      e.addEventListener('click', function () { e.classList.add('shown'); });
    } else if (n.t === 'a') {
      e = el('span', '');
      linkify(e, n.href);
    } else return;
    rich(e, n.c, depth + 1);
    parent.appendChild(e);
  });
}
function preBlock(n, depth) {
  var box = el('div', 'pre');
  var head = el('div', 'prehead');
  add(head, el('span', 'lang', str(n.lang) || 'code'));
  var copy = el('button', 'copy', 'Copy');
  copy.type = 'button';
  var code = el('pre');
  rich(code, n.c, depth + 1);
  copy.addEventListener('click', function () {
    var t = code.textContent || '';
    var done = function (ok) { copy.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(function () { copy.textContent = 'Copy'; }, 1600); };
    try { navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(false); }); } catch (e) { done(false); }
  });
  add(head, copy);
  return add(box, head, code);
}
function caption(nodes) {
  if (!list(nodes).length) return null;
  var c = el('div', 'txt');
  rich(c, nodes, 0);
  return c;
}

// ── media ──────────────────────────────────────────────────────────────────
function placeholder(label, url) {
  var ph = el('div', 'ph');
  add(ph, el('div', 'phl', label), url ? el('div', 'phh', hostOf(url)) : null, url ? button('Open', url, 'btn small') : null);
  return ph;
}
function image(url, cls) {
  var box = el('div', cls || 'media');
  var u = safeUrl(url);
  if (!u || u.indexOf('https:') !== 0) { box.appendChild(placeholder(u ? 'Image (not https)' : 'No image', u)); return box; }
  var img = el('img');
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', function () {
    clear(box);
    box.appendChild(placeholder('Image not shown here', u));
  });
  img.src = u;
  box.appendChild(img);
  return box;
}
function video(url) {
  var u = safeUrl(url);
  var box = el('div', 'media');
  box.appendChild(placeholder('Video', u));
  return box;
}

// ── one Telegram message ───────────────────────────────────────────────────
function buttonsRows(rows) {
  rows = list(rows);
  if (!rows.length) return null;
  var box = el('div', 'kb');
  rows.forEach(function (row) {
    var r = el('div', 'kbrow');
    list(row).forEach(function (b) { if (b) r.appendChild(button(str(b.text) || 'Open', b.url, 'kbbtn')); });
    if (r.firstChild) box.appendChild(r);
  });
  return box.firstChild ? box : null;
}
function linkPreview(link) {
  if (!link || !safeUrl(link.url)) return null;
  var lp = el('div', 'lp');
  add(lp, el('div', 'lph', hostOf(link.url)), el('div', 'lpu', link.url));
  return linkify(lp, link.url);
}
function bubble(m, time) {
  var wrap = el('div', 'msg');
  var b = el('div', 'bubble');
  if (m.type === 'text') {
    var lp = linkPreview(m.link);
    if (lp && m.link.above) b.appendChild(lp);
    add(b, caption(m.text));
    if (lp && !m.link.above) b.appendChild(lp);
  } else if (m.type === 'photo' || m.type === 'video') {
    var md = m.type === 'photo' ? image(m.media) : video(m.media);
    var cap = caption(m.caption);
    if (m.caption_above) add(b, cap, md); else add(b, md, cap);
    if (!cap) b.classList.add('bare');
  } else if (m.type === 'album') {
    var photos = list(m.photos);
    var grid = el('div', 'album n' + Math.min(photos.length, 4));
    photos.forEach(function (u) { grid.appendChild(image(u, 'cell')); });
    if (!photos.length) grid.appendChild(placeholder('No images', null));
    add(b, grid, caption(m.caption));
  } else if (m.type === 'poll') {
    add(b, el('div', 'pollq', str(m.question)));
    add(b, el('div', 'pollk', (m.anonymous ? 'Anonymous ' : '') + (m.quiz ? 'quiz' : 'poll')));
    list(m.options).forEach(function (o, i) {
      var row = el('div', 'opt' + (m.quiz && m.correct === i ? ' right' : ''));
      add(row, el('span', 'dot'), el('span', '', str(o)));
      b.appendChild(row);
    });
    if (m.explanation) add(b, el('div', 'pollx', 'Explanation: ' + m.explanation));
  } else return null;
  if (time) b.appendChild(el('span', 'time', time));
  add(wrap, b, buttonsRows(m.buttons));
  return wrap;
}

// ── views ──────────────────────────────────────────────────────────────────
function whenText(w) {
  if (!w || typeof w !== 'object') return '';
  return str(w.local) + (w.tz ? ' (' + w.tz + ')' : '');
}
function hhmm(w) { var l = w && typeof w === 'object' ? str(w.local) : ''; return l.length >= 16 ? l.slice(11, 16) : ''; }
function avatar(name) {
  var a = el('div', 'ava');
  var t = str(name).replace(/^@/, '');
  a.textContent = (t.charAt(0) || '?').toUpperCase();
  return a;
}
var SOURCE = { post: 'Post', draft: 'Draft', check: 'Check' };

function postView(v, compact) {
  var card = el('section', 'card post' + (compact ? ' compact' : ''));
  var head = el('header', 'head');
  var who = el('div', 'who');
  add(who, el('div', 'name', str(v.channel_title) || str(v.channel)), el('div', 'sub', [str(v.channel), whenText(v.when)].filter(Boolean).join(' · ')));
  add(head, avatar(v.channel_title || v.channel), who, statusChip(v.status));
  card.appendChild(head);

  var meta = el('div', 'chips');
  add(meta, chip(SOURCE[v.source] || 'Post', 'src'), v.format ? chip(v.format) : null, v.origin ? chip(v.origin.replace(/_/g, ' ')) : null,
    v.locked ? chip('locked', 'wait') : null, v.rich ? richChip() : null);
  card.appendChild(meta);
  if (v.title) card.appendChild(el('div', 'title', v.title));
  if (v.note) card.appendChild(el('div', 'note', v.note));

  if (v.brief) {
    var br = el('div', 'brief');
    add(br, el('div', 'k', 'Topic'), el('div', 'v', str(v.brief.topic)));
    if (v.brief.angle) add(br, el('div', 'k', 'Angle'), el('div', 'v', v.brief.angle));
    card.appendChild(br);
  }

  var msgs = list(v.messages);
  if (msgs.length) {
    var tg = el('div', 'tg');
    msgs.forEach(function (m) { add(tg, bubble(m || {}, hhmm(v.when))); });
    card.appendChild(tg);
  } else if (!v.brief) {
    card.appendChild(el('div', 'note', 'No preview: this post has no rendered text yet.'));
  }

  issues(card, 'Errors', v.errors, 'bad');
  issues(card, 'Warnings', v.warnings, 'warn');
  if (v.critic) {
    var cr = el('div', 'box');
    add(cr, el('div', 'boxh', 'Critic'), statusChip(v.critic.verdict), v.critic.notes ? el('div', 'boxt', v.critic.notes) : null);
    card.appendChild(cr);
  }
  if (v.reason) {
    var rs = el('div', 'box bad');
    add(rs, el('div', 'boxh', 'Why'), el('div', 'boxt', str(v.reason.label)), v.reason.fix ? el('div', 'boxt dim', 'Fix: ' + v.reason.fix) : null);
    card.appendChild(rs);
  }
  if (v.link) {
    var act = el('div', 'actions');
    act.appendChild(button('Open in Telegram', v.link, 'btn'));
    card.appendChild(act);
  }
  return card;
}
function issues(card, label, items, tone) {
  items = list(items).filter(function (x) { return typeof x === 'string' && x; });
  if (!items.length) return;
  var box = el('div', 'box ' + tone);
  box.appendChild(el('div', 'boxh', label + ' (' + items.length + ')'));
  var ul = el('ul', 'issues');
  items.forEach(function (t) { ul.appendChild(el('li', '', t)); });
  card.appendChild(add(box, ul));
}

function rows(items, showChannel) {
  var box = el('div', 'rows');
  var day = '';
  list(items).forEach(function (it) {
    if (!it) return;
    var local = it.when ? str(it.when.local) : '';
    var d = local.slice(0, 10);
    if (d && d !== day) { day = d; box.appendChild(el('div', 'day', d)); }
    var r = el('div', 'row');
    var main = el('div', 'rmain');
    add(main, el('div', 'rtitle', str(it.title) || '(untitled)'),
      el('div', 'rsub', [showChannel ? str(it.channel) : '', it.format || '', it.origin ? it.origin.replace(/_/g, ' ') : '', str(it.post_id).slice(0, 8)].filter(Boolean).join(' · ')));
    var side = el('div', 'rside');
    add(side, statusChip(it.status), it.locked ? chip('locked', 'wait') : null, it.needs_approval ? chip('needs approval', 'wait') : null);
    add(r, el('div', 'rtime', local.slice(11, 16)), main, side);
    box.appendChild(r);
  });
  if (!box.firstChild) box.appendChild(el('div', 'note', 'Nothing scheduled.'));
  return box;
}
function scheduleView(v) {
  var card = el('section', 'card');
  var head = el('header', 'head');
  var who = el('div', 'who');
  add(who, el('div', 'name', 'Schedule'), el('div', 'sub', str(v.title)));
  add(head, avatar('S'), who, chip(list(v.items).length + ' posts'));
  add(card, head, rows(v.items, !/^@/.test(str(v.title))));
  if (v.truncated) card.appendChild(el('div', 'note', 'More posts than shown: ask for a shorter window or one channel.'));
  return card;
}
function channelView(v) {
  var card = el('section', 'card');
  var head = el('header', 'head');
  var who = el('div', 'who');
  add(who, el('div', 'name', str(v.title) || str(v.channel)), el('div', 'sub', [str(v.channel), str(v.tz), v.agent ? 'agent ' + v.agent : ''].filter(Boolean).join(' · ')));
  add(head, avatar(v.title || v.channel), who, v.mode ? chip(v.mode, v.mode === 'live' ? 'good' : 'wait') : null);
  card.appendChild(head);
  var stats = el('div', 'stats');
  if (v.today) {
    var pub = num(v.today.published), tgt = num(v.today.target);
    add(stats, stat('Today', (pub === null ? '–' : pub) + (tgt === null ? '' : ' / ' + tgt)), v.today.state ? stat('State', v.today.state) : null);
  }
  add(stats, stat('Open problems', String(num(v.problems) || 0)));
  card.appendChild(stats);
  card.appendChild(el('div', 'sect', 'Next posts'));
  card.appendChild(rows(v.items, false));
  return card;
}
function stat(k, val) { var s = el('div', 'stat'); add(s, el('div', 'k', k), el('div', 'v', val)); return s; }

function chatView(v) {
  var card = el('section', 'card');
  var head = el('header', 'head');
  var who = el('div', 'who');
  add(who, el('div', 'name', 'Chat with ' + (str(v.agent) || 'agent')), el('div', 'sub', 'chat ' + str(v.chat_id).slice(0, 8)));
  add(head, avatar(v.agent || 'A'), who, v.running ? chip('answering…', 'wait') : null);
  card.appendChild(head);
  var msgs = list(v.messages);
  if (!msgs.length) card.appendChild(el('div', 'note', v.running ? 'The agent is still answering.' : 'No messages from the agent yet.'));
  msgs.forEach(function (m) {
    if (!m) return;
    var box = el('div', 'amsg');
    add(box, el('div', 'amh', [str(m.agent), str(m.at).replace('T', ' ').slice(0, 16)].filter(Boolean).join(' · ')));
    if (m.text) box.appendChild(el('div', 'amt', m.text));
    list(m.cards).forEach(function (c) {
      if (!c) return;
      var cb = el('div', 'acard');
      add(cb, el('div', 'acardh', str(c.kind).replace(/_/g, ' ')), statusChip(c.status));
      if (c.summary) cb.appendChild(el('div', 'boxt', c.summary));
      box.appendChild(cb);
    });
    list(m.drafts).forEach(function (d) { if (d) box.appendChild(postView(d, true)); });
    card.appendChild(box);
  });
  var foot = [];
  if (num(v.cards_waiting)) foot.push(v.cards_waiting + ' card(s) wait for a decision (apply or discard them in the chat).');
  if (num(v.more_drafts)) foot.push(v.more_drafts + ' more draft(s) not drawn here: get_draft shows one.');
  foot.forEach(function (t) { card.appendChild(el('div', 'note', t)); });
  return card;
}

// ── result → screen ────────────────────────────────────────────────────────
function show(node) {
  clear(root);
  root.appendChild(node);
  root.appendChild(el('div', 'foot', 'ai0 · preview only: nothing here publishes or changes anything'));
}
function message(text, detail) {
  var box = el('div', 'empty');
  add(box, el('div', '', text), detail ? el('div', 'dim', detail) : null);
  show(box);
}
function firstText(r) {
  var c = list(r && r.content).filter(function (x) { return x && x.type === 'text'; })[0];
  var t = c ? str(c.text) : '';
  return t.length > 600 ? t.slice(0, 599) + '…' : t;
}
var VIEWS = { post: function (v) { return postView(v, false); }, schedule: scheduleView, channel: channelView, chat: chatView };
function render(r) {
  if (!r || typeof r !== 'object') { message('No result.'); return; }
  if (r.isError) { message('The call returned an error.', firstText(r)); return; }
  // MCP Apps hosts get the view as structuredContent; for other clients the server puts it in result _meta.
  var sc = r.structuredContent && r.structuredContent.ai0_view === 1 ? r.structuredContent : null;
  var mc = r._meta && r._meta['ai0/view'] && r._meta['ai0/view'].ai0_view === 1 ? r._meta['ai0/view'] : null;
  var v = (sc || mc) ? (sc || mc).view : null;
  var draw = v && typeof v === 'object' ? VIEWS[v.kind] : null;
  if (!draw) { message('No preview for this result.', 'The text result has everything.'); return; }
  try { show(draw(v)); } catch (e) { message('This preview could not be drawn.', 'The text result has everything.'); }
}

app.ontoolinput = function () { if (!root.querySelector('.card')) message('Loading…'); };
app.ontoolresult = function (r) { render(r); };
app.ontoolcancelled = function () { message('The call was cancelled.'); };
app.connect().catch(function () { message('Could not connect to the host.'); });
`;
