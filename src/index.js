import { PAGE } from './page.js';
import { buildGraph } from './graph.js';

import { verifyLoginToken, makeSession, readSession, mayRead } from './session.js';
export const KINDS = ['error', 'rerouted', 'slow', 'unexpected', 'capped'];
export const KEEP_DAYS = 14;
export const PER_MINUTE = 100; // rows a minute per app: a storm of errors cannot fill D1
const FIELDS = ['route', 'kind', 'why', 'expected', 'actual', 'model', 'effort', 'ms', 'status', 'detail', 'lang'];
// Anything that could carry a person's words or secrets is refused, not stored.
const FORBIDDEN = /^(prompt|prompts|answer|messages?|content|text|key|token|secret|password|login|email|body)$/i;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
// Provider errors echo part of the key ("key_gl8C********hRTv"); never keep any piece of one.
const SECRET = /\b(?:sk|pk|key|ghp|gho|xox[abp])[-_][A-Za-z0-9*_-]{4,}|\b[A-Za-z0-9]{4,}\*{3,}[A-Za-z0-9]*|Bearer\s+\S+/g;
export const scrub = (s) => String(s).replace(SECRET, '[key hidden]');
const cut = (v, n) => (v == null ? null : scrub(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);

// "chat:abc,inference:def" -> the app a key belongs to, or null.
export function appForKey(env, given) {
  if (!given) return null;
  for (const pair of String(env.TRACE_KEYS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(i + 1) === given) return pair.slice(0, i).trim();
  }
  // One secret per app: TRACE_KEY_BRAIN=<key> belongs to "brain". Adds an app without rewriting TRACE_KEYS.
  for (const [name, value] of Object.entries(env)) {
    const m = /^TRACE_KEY_([A-Z0-9_]+)$/.exec(name);
    if (m && typeof value === 'string' && value && value === given) return m[1].toLowerCase();
  }
  return null;
}

// Checks one event. Returns { event } or { error }.
export function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'send a JSON object' };
  for (const k of Object.keys(body)) {
    if (FORBIDDEN.test(k)) return { error: `field "${k}" is never stored` };
    if (!FIELDS.includes(k)) return { error: `unknown field "${k}"` };
  }
  if (!KINDS.includes(body.kind)) return { error: `kind must be one of ${KINDS.join(', ')}` };
  if (!body.route || !body.why) return { error: 'route and why are required' };
  return {
    event: {
      route: cut(body.route, 120),
      kind: body.kind,
      why: cut(body.why, 200),
      expected: cut(body.expected, 120),
      actual: cut(body.actual, 200),
      model: cut(body.model, 80),
      effort: cut(body.effort, 20),
      ms: num(body.ms),
      status: num(body.status),
      detail: cut(body.detail, 200),
      lang: /^[a-z]{2}$/i.test(String(body.lang || '')) ? String(body.lang).toLowerCase() : null,
    },
  };
}

const hits = new Map(); // per isolate: app -> { minute, n }
export function overLimit(app, now = Date.now(), limit = PER_MINUTE) {
  const minute = Math.floor(now / 60000);
  const h = hits.get(app);
  if (!h || h.minute !== minute) { hits.set(app, { minute, n: 1 }); return false; }
  h.n++;
  return h.n > limit;
}
export const resetLimits = () => { hits.clear(); lastCleanup = 0; };

// Keep distinct reroute destinations and languages intact for the graph.
export async function record(env, app, e, now = new Date()) {
  const at = now.toISOString();
  const since = new Date(now.getTime() - 60000).toISOString();
  const same = await env.DB.prepare(`SELECT id FROM traces
    WHERE app = ? AND route = ? AND kind = ? AND why = ? AND last >= ?
      AND (kind <> 'rerouted' OR (actual IS ? AND lang IS ?))
    ORDER BY id DESC LIMIT 1`)
    .bind(app, e.route, e.kind, e.why, since, e.actual ?? null, e.lang ?? null)
    .first();
  if (same) {
    await env.DB.prepare('UPDATE traces SET n = n + 1, last = ? WHERE id = ?').bind(at, same.id).run();
    return { merged: true };
  }
  await env.DB.prepare('INSERT INTO traces (created, app, route, kind, why, expected, actual, model, effort, ms, status, detail, lang, n, last) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .bind(at, app, e.route, e.kind, e.why, e.expected, e.actual, e.model, e.effort, e.ms, e.status, e.detail, e.lang ?? null, at)
    .run();
  return { merged: false };
}

export async function cleanup(env, now = new Date()) {
  const before = new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString();
  await env.DB.prepare('DELETE FROM traces WHERE created < ?').bind(before).run();
}

// GET /api/events?days=7&app=chat&kind=rerouted: a signed-in login from ADMIN_LOGINS (the page), or Authorization: Bearer <ADMIN_KEY> (scripts)
export async function events(request, env) {
  const key = env.ADMIN_KEY || '';
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!(key && given === key) && !(await readSession(env, request))) return json(404, { error: 'not found' });
  const q = new URL(request.url).searchParams;
  const kind = q.get('kind');
  if (kind !== null && !KINDS.includes(kind)) return json(400, { error: `kind must be one of ${KINDS.join(', ')}` });
  const days = Math.min(KEEP_DAYS, Math.max(1, Number(q.get('days')) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const where = ['created >= ?'];
  const args = [since];
  if (q.get('app')) { where.push('app = ?'); args.push(q.get('app')); }
  if (kind !== null) { where.push('kind = ?'); args.push(kind); }
  const rows = await env.DB.prepare(`SELECT id, created, last, app, route, kind, why, expected, actual, model, effort, ms, status, detail, lang, n FROM traces WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100`).bind(...args).all();
  const totals = await env.DB.prepare('SELECT app, kind, SUM(n) AS events FROM traces WHERE created >= ? GROUP BY app, kind ORDER BY events DESC').bind(since).all();
  return json(200, { days, totals: totals.results, events: rows.results });
}

// GET /api/graph?days=7&app=chat: counts of every reroute by day, reason, model, destination and language, for the Graph tab. Same access as /api/events.
export async function graph(request, env) {
  const key = env.ADMIN_KEY || '';
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!(key && given === key) && !(await readSession(env, request))) return json(404, { error: 'not found' });
  const q = new URL(request.url).searchParams;
  const days = Math.min(KEEP_DAYS, Math.max(1, Number(q.get('days')) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const where = ["created >= ?", "(kind = 'rerouted' OR (kind = 'error' AND expected = 'wolf'))"];
  const args = [since];
  if (q.get('app')) { where.push('app = ?'); args.push(q.get('app')); }
  const rows = await env.DB.prepare(`SELECT created, kind, why, actual, detail, lang, n FROM traces WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 5000`).bind(...args).all();
  return json(200, { days, ...buildGraph(rows.results) });
}

// Sign-in through login.flisk.si. /auth/start sends the person there; /auth/done checks the token and sets our cookie.
export async function auth(request, env) {
  const url = new URL(request.url);
  const page = (msg, status) => new Response(`<!doctype html><meta charset="utf-8"><title>Traces sign-in</title><p>${msg} <a href="/">Back</a></p>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  if (url.pathname === '/auth/start') {
    if (!env.LOGIN_PUBLIC_KEY || !env.SESSION_SECRET) return page('Sign-in is not set up yet.', 503);
    const state = crypto.randomUUID();
    const back = new URL('/auth/done', url.origin);
    back.searchParams.set('s', state);
    const headers = new Headers({ location: `${env.LOGIN_ORIGIN || 'https://login.flisk.si'}/start?return=${encodeURIComponent(back.href)}`, 'cache-control': 'no-store' });
    headers.append('set-cookie', `traces_state=${state}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    return new Response(null, { status: 302, headers });
  }
  if (url.pathname === '/auth/done') {
    const cookie = /(?:^|;\s*)traces_state=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1] || '';
    const st = url.searchParams.get('s') || '';
    const who = env.LOGIN_PUBLIC_KEY && env.SESSION_SECRET && st && st === cookie ? await verifyLoginToken(url.searchParams.get('flisk_token'), env.LOGIN_PUBLIC_KEY, url.origin) : null;
    if (!who) return page('The sign-in link expired. Start again.', 400);
    if (!mayRead(env, who.login)) return page('This GitHub account may not read traces.', 403);
    const headers = new Headers({ location: '/', 'cache-control': 'no-store' });
    headers.append('set-cookie', await makeSession(env, who.login));
    headers.append('set-cookie', 'traces_state=; Path=/auth; Max-Age=0');
    return new Response(null, { status: 303, headers });
  }
  // /auth/signout
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'traces_session=; Path=/; Max-Age=0' } });
}

let lastCleanup = 0;
export async function ingest(request, env, ctx) {
  const app = appForKey(env, (request.headers.get('authorization') || '').replace(/^Bearer /, ''));
  if (!app) return json(401, { error: 'bad key' });
  if (overLimit(app)) return json(429, { error: 'too many traces this minute' });
  let body = null;
  try { body = JSON.parse((await request.text()) || '{}'); } catch { /* falls to validate */ }
  const v = validate(body);
  if (v.error) return json(400, { error: v.error });
  const out = await record(env, app, v.event);
  const t = Date.now();
  if (t - lastCleanup > 3600000) { lastCleanup = t; const job = cleanup(env).catch(() => {}); if (ctx?.waitUntil) ctx.waitUntil(job); else await job; }
  return json(200, { ok: true, ...out });
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The org bar reads the signed-in login from [data-flisk-login]. Only an allowed, signed-in person gets it; the page is no-store already.
async function pageFor(request, env) {
  const login = await readSession(env, request);
  return PAGE.replace('<!--LOGIN-->', login ? `<span data-flisk-login hidden>${escHtml(login)}</span>` : '');
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/trace' && request.method === 'POST') return ingest(request, env, ctx);
    if (pathname.startsWith('/auth/') && request.method === 'GET') return auth(request, env);
    if (pathname === '/api/graph' && request.method === 'GET') return graph(request, env);
    if (pathname === '/api/events' && request.method === 'GET') return events(request, env);
    if (pathname === '/' && request.method === 'GET') return new Response(await pageFor(request, env), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline' https://flisk.sh https://flisk.si; style-src 'unsafe-inline' https://flisk.si; img-src https://flisk.si data:; font-src https://flisk.si data:; connect-src 'self' https://analytics.flisk.si https://flisk.si" } });
    return json(404, { error: 'not found' });
  },
  async scheduled(_event, env) {
    await cleanup(env);
  },
};
