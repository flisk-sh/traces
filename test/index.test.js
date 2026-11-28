import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { makeSession } from '../src/session.js';
import worker, { scrub, appForKey, validate, overLimit, resetLimits, record, cleanup, KEEP_DAYS } from '../src/index.js';

// A D1-shaped wrapper over a real SQLite database that runs the real schema.sql.
function d1() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare: (sql) => ({
      bind: (...a) => ({
        run: async () => db.prepare(sql).run(...a),
        first: async () => db.prepare(sql).get(...a) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...a) }),
      }),
    }),
  };
}
const env = () => ({ DB: d1(), TRACE_KEYS: 'chat:ck, inference:ik', ADMIN_KEY: 'adm' });
const post = (e, key, body) => worker.fetch(new Request('https://t/v1/trace', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) }), e);
const ev = { route: '/api/ask', kind: 'rerouted', why: 'Wolf 429, OpenRouter answered', expected: 'wolf', actual: 'wolf:429>openrouter:ok' };
beforeEach(resetLimits);

test('the events query rejects an unrecognized kind with the supported kinds', async () => {
  const request = new Request('https://t/api/events?kind=bogus', {
    headers: { authorization: 'Bearer adm' },
  });
  const response = await worker.fetch(request, env());
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'kind must be one of error, rerouted, slow, unexpected, capped',
  });
});

test('a key belongs to one app, a wrong key to none', () => {
  const e = env();
  expect(appForKey(e, 'ck')).toBe('chat');
  expect(appForKey(e, 'ik')).toBe('inference');
  expect(appForKey(e, 'nope')).toBe(null);
  expect(appForKey(e, '')).toBe(null);
});

test('a TRACE_KEY_<APP> secret adds an app without touching TRACE_KEYS', () => {
  const e = { ...env(), TRACE_KEY_BRAIN: 'bk' };
  expect(appForKey(e, 'bk')).toBe('brain');
  expect(appForKey(e, 'ck')).toBe('chat');
  expect(appForKey({ TRACE_KEY_BRAIN: '' }, '')).toBe(null);
});

test('prompts, answers, keys and logins are refused, not stored', () => {
  for (const f of ['prompt', 'answer', 'messages', 'content', 'key', 'login', 'email']) {
    expect(validate({ ...ev, [f]: 'x' }).error).toContain('never stored');
  }
  expect(validate({ ...ev, surprise: 1 }).error).toContain('unknown field');
  expect(validate({ ...ev, kind: 'fine' }).error).toContain('kind must be');
  expect(validate({ kind: 'error' }).error).toContain('required');
});

test('long text is cut', () => {
  const { event } = validate({ ...ev, why: 'w'.repeat(900), detail: 'd'.repeat(900) });
  expect(event.why.length).toBe(200);
  expect(event.detail.length).toBe(200);
});

test('ingest needs a valid key', async () => {
  expect((await post(env(), 'bad', ev)).status).toBe(401);
  expect((await post(env(), 'ck', { ...ev, prompt: 'hi' })).status).toBe(400);
});

test('an event is stored under the app of its key', async () => {
  const e = env();
  expect((await post(e, 'ik', ev)).status).toBe(200);
  const row = e.DB.raw.prepare('SELECT * FROM traces').get();
  expect(row.app).toBe('inference');
  expect(row.kind).toBe('rerouted');
  expect(row.actual).toBe('wolf:429>openrouter:ok');
  expect(row.n).toBe(1);
});

test('the same event inside a minute is one row with a count', async () => {
  const e = env();
  await post(e, 'ck', ev);
  await post(e, 'ck', ev);
  await post(e, 'ck', ev);
  const rows = e.DB.raw.prepare('SELECT n FROM traces').all();
  expect(rows).toEqual([{ n: 3 }]);
});

test('a different reason, kind or app is its own row', async () => {
  const e = env();
  await post(e, 'ck', ev);
  await post(e, 'ck', { ...ev, why: 'another reason' });
  await post(e, 'ck', { ...ev, kind: 'error' });
  await post(e, 'ik', ev);
  expect(e.DB.raw.prepare('SELECT COUNT(*) c FROM traces').get().c).toBe(4);
});

test('the same event a minute later starts a new row', async () => {
  const e = env();
  await record(e, 'chat', validate(ev).event, new Date('2026-11-17T10:00:00Z'));
  await record(e, 'chat', validate(ev).event, new Date('2026-11-17T10:02:00Z'));
  expect(e.DB.raw.prepare('SELECT COUNT(*) c FROM traces').get().c).toBe(2);
});

test('an app over its limit gets 429 and the rest of the world is unaffected', () => {
  const t = 1_000_000;
  for (let i = 0; i < 100; i++) expect(overLimit('chat', t)).toBe(false);
  expect(overLimit('chat', t)).toBe(true);
  expect(overLimit('inference', t)).toBe(false);
  expect(overLimit('chat', t + 60_000)).toBe(false);
});

test('rows older than the keep time are deleted', async () => {
  const e = env();
  const now = new Date('2026-11-30T00:00:00Z');
  await record(e, 'chat', validate(ev).event, new Date(now.getTime() - (KEEP_DAYS + 1) * 86400000));
  await record(e, 'chat', validate({ ...ev, why: 'recent' }).event, new Date(now.getTime() - 86400000));
  await cleanup(e, now);
  const rows = e.DB.raw.prepare('SELECT why FROM traces').all();
  expect(rows).toEqual([{ why: 'recent' }]);
});

test('the read API needs the admin key and filters', async () => {
  const e = env();
  await post(e, 'ck', ev);
  await post(e, 'ck', { ...ev, kind: 'error', why: 'Wolf 502' });
  const get = (path, key) => worker.fetch(new Request(`https://t${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }), e);
  expect((await get('/api/events')).status).toBe(404);
  expect((await get('/api/events', 'wrong')).status).toBe(404);
  const all = await (await get('/api/events', 'adm')).json();
  expect(all.events.length).toBe(2);
  const errs = await (await get('/api/events?kind=error', 'adm')).json();
  expect(errs.events.map((x) => x.why)).toEqual(['Wolf 502']);
  expect(all.totals.find((t) => t.kind === 'error').events).toBe(1);
});

test('the page loads and never stores the key in the page itself', async () => {
  const r = await worker.fetch(new Request('https://t/'), env());
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain('Flisk Traces');
  expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(html).not.toContain('adm');
});

// Sign-in through login.flisk.si: a real Ed25519 token, like the login Worker makes.
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function loginToken(login, aud, expSeconds = Math.floor(Date.now() / 1000) + 60) {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ login, id: 7, aud, iat: 0, exp: expSeconds })));
  const sig = b64u(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(payload)));
  return { token: `${payload}.${sig}`, pub: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}
const authEnv = (pub) => ({ ...env(), LOGIN_PUBLIC_KEY: pub, SESSION_SECRET: 'sess', ADMIN_LOGINS: 'Odykyi, someone' });
async function signIn(e, token) {
  const start = await worker.fetch(new Request('https://t/auth/start'), e);
  expect(start.status).toBe(302);
  expect(start.headers.get('location')).toStartWith('https://login.flisk.si/start?return=');
  const state = /traces_state=([^;]+)/.exec(start.headers.get('set-cookie'))[1];
  return worker.fetch(new Request(`https://t/auth/done?s=${state}&flisk_token=${token}`, { headers: { cookie: `traces_state=${state}` } }), e);
}

test('a listed GitHub login signs in and reads, then the cookie is enough', async () => {
  const { token, pub } = await loginToken('odykyi', 'https://t');
  const e = authEnv(pub);
  await post(e, 'ck', ev);
  const done = await signIn(e, token);
  expect(done.status).toBe(303);
  const cookie = /traces_session=[^;]+/.exec(done.headers.getSetCookie().join('\n'))[0];
  const r = await worker.fetch(new Request('https://t/api/events', { headers: { cookie } }), e);
  expect(r.status).toBe(200);
  expect((await r.json()).events.length).toBe(1);
});

test('another login, an expired or foreign token, and a forged cookie read nothing', async () => {
  const e0 = authEnv((await loginToken('x', 'https://t')).pub);
  const a = await loginToken('stranger', 'https://t');
  expect((await signIn(authEnv(a.pub), a.token)).status).toBe(403);
  const old = await loginToken('odykyi', 'https://t', Math.floor(Date.now() / 1000) - 5);
  expect((await signIn(authEnv(old.pub), old.token)).status).toBe(400);
  const other = await loginToken('odykyi', 'https://chat.flisk.si');
  expect((await signIn(authEnv(other.pub), other.token)).status).toBe(400);
  const forged = 'traces_session=odykyi.9999999999.AAAA';
  expect((await worker.fetch(new Request('https://t/api/events', { headers: { cookie: forged } }), e0)).status).toBe(404);
});

test('sign-in without a matching state cookie is refused', async () => {
  const { token, pub } = await loginToken('odykyi', 'https://t');
  const r = await worker.fetch(new Request(`https://t/auth/done?s=abc&flisk_token=${token}`), authEnv(pub));
  expect(r.status).toBe(400);
});

test('ingest removes rows older than 14 days, without a cron', async () => {
  const e = env();
  e.DB.raw.prepare("INSERT INTO traces (created, app, route, kind, why, last) VALUES ('2020-01-01T00:00:00.000Z','chat','/x','error','old','2020-01-01T00:00:00.000Z')").run();
  const r = await post(e, 'ck', ev);
  expect(r.status).toBe(200);
  await new Promise((ok) => setTimeout(ok, 20));
  expect(e.DB.raw.prepare("SELECT COUNT(*) AS c FROM traces WHERE why='old'").get().c).toBe(0);
});

test('a key echoed in an error text is hidden', () => {
  expect(scrub('Incorrect API key provided: key_gl8C********hRTv. You can')).toBe('Incorrect API key provided: [key hidden]. You can');
  expect(scrub('bad sk-abc123DEF456 and Bearer abc.def')).toBe('bad [key hidden] and [key hidden]');
  expect(scrub('a model call took 27 s')).toBe('a model call took 27 s');
});

// ---- Graph tab ----
import { buildGraph, reasonOf, destOf, modelOf, langOf } from '../src/graph.js';
import { PAGE } from '../src/page.js';

test('graph helpers classify reroute rows', () => {
  expect(reasonOf('Wolf 429, OpenRouter answered')).toBe('rate limit');
  expect(reasonOf('wolf resting')).toBe('wolf resting');
  expect(reasonOf('Wolf 503')).toBe('server error');
  expect(destOf('workers-ai (@cf/meta/llama-3.1-8b-instruct-fast)')).toBe('workers-ai');
  expect(modelOf('workers-ai (@cf/meta/llama)', '')).toBe('@cf/meta/llama');
  expect(modelOf('openrouter', 'answered by openrouter after 1 failed')).toBe('openrouter');
  expect(langOf('answered by x after 1 failed · lang uk')).toBe('uk');
  expect(langOf('')).toBe('unknown');
});

test('buildGraph counts by day, reason, model, language and builds the flow', () => {
  const rows = [
    { created: '2026-11-16 10:00:00', kind: 'rerouted', why: 'Wolf 429', actual: 'openrouter (m1)', detail: 'lang en', n: 3 },
    { created: '2026-11-16 11:00:00', kind: 'rerouted', why: 'Wolf 429', actual: 'workers-ai (m2)', detail: 'lang uk', n: 1 },
    { created: '2026-11-17 09:00:00', kind: 'error', why: 'all failed', actual: '', detail: 'lang uk', n: 2 },
  ];
  const g = buildGraph(rows);
  expect(g.total).toBe(6);
  expect(g.failed).toBe(2);
  expect(g.daily['2026-11-16']).toEqual({ openrouter: 3, 'workers-ai': 1 });
  expect(g.reasons).toEqual({ 'rate limit': 4, 'every model failed': 2 });
  expect(g.langs).toEqual({ en: 3, uk: 3 });
  expect(g.flow[0]).toEqual({ lang: 'en', reason: 'rate limit', dest: 'openrouter', model: 'm1', n: 3 });
});

test('/api/graph needs admin and counts stored reroutes', async () => {
  const e = env();
  await post(e, 'ck', { ...ev, actual: 'openrouter (m1)', detail: 'lang en' });
  const get = (key) => worker.fetch(new Request('https://t/api/graph?days=7', { headers: key ? { authorization: `Bearer ${key}` } : {} }), e);
  expect((await get()).status).toBe(404);
  expect((await get('wrong')).status).toBe(404);
  const g = await (await get('adm')).json();
  expect(g.total).toBe(1);
  expect(g.dests).toEqual({ openrouter: 1 });
  expect(g.days).toBe(7);
});

test('page has Graph tab and its script parses', () => {
  expect(PAGE).toContain('id="tabgraph"');
  expect(PAGE).toContain('/api/graph');
  const code = PAGE.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  expect(() => new Function(code)).not.toThrow();
});

test('lang is stored as a two-letter code and drives the graph language', async () => {
  expect(validate({ route: '/r', kind: 'rerouted', why: 'w', lang: 'UK' }).event.lang).toBe('uk');
  expect(validate({ route: '/r', kind: 'rerouted', why: 'w', lang: 'Ukrainian text here' }).event.lang).toBeNull();
  const e = env();
  await post(e, 'ck', { ...ev, actual: 'openrouter (m1)', lang: 'uk' });
  const g = await (await worker.fetch(new Request('https://t/api/graph', { headers: { authorization: 'Bearer adm' } }), e)).json();
  expect(g.langs).toEqual({ uk: 1 });
  expect(buildGraph([{ created: '2026-11-17 1', kind: 'rerouted', why: 'x', actual: 'a', detail: 'lang en', lang: 'de', n: 1 }]).langs).toEqual({ de: 1 });
});

test('the graph keeps reroutes with different destinations or languages separate', async () => {
  const e = env();
  const primary = { ...ev, why: 'wolf: HTTP 429', actual: 'openrouter (m1)', lang: 'en' };
  const now = new Date();
  for (const input of [
    primary,
    primary,
    { ...primary, actual: 'workers-ai (m2)' },
    { ...primary, lang: 'uk' },
  ]) {
    await record(e, 'chat', validate(input).event, now);
  }
  const request = new Request('https://t/api/graph', { headers: { authorization: 'Bearer adm' } });
  const response = await worker.fetch(request, e);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    total: 4,
    dests: { openrouter: 3, 'workers-ai': 1 },
    models: { m1: 3, m2: 1 },
    langs: { en: 3, uk: 1 },
  });
  expect(e.DB.raw.prepare('SELECT n FROM traces ORDER BY id').all()).toEqual([{ n: 2 }, { n: 1 }, { n: 1 }]);
});

// The org bar (flisk.si/assets/bar.js) reads the signed-in login from [data-flisk-login]; its whole text must be the login.
const hookOf = (html) => [...html.matchAll(/<span data-flisk-login hidden>([^<]*)<\/span>/g)].map((m) => m[1]);
const getPage = async (e, cookie) => worker.fetch(new Request('https://t/', { headers: cookie ? { cookie } : {} }), e);

test('GET / carries the login in a hidden hook for an allowed signed-in person only', async () => {
  const { token, pub } = await loginToken('odykyi', 'https://t');
  const e = authEnv(pub);
  const cookie = /traces_session=[^;]+/.exec((await signIn(e, token)).headers.getSetCookie().join('\n'))[0];
  const r = await getPage(e, cookie);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const html = await r.text();
  expect(hookOf(html)).toEqual(['odykyi']);
  expect(html).not.toContain('<!--LOGIN-->');
  expect(html).toContain('id="signin"');
});

test('GET / has no hook when signed out, forged, or not on the allowlist', async () => {
  const { pub } = await loginToken('x', 'https://t');
  const e = authEnv(pub);
  for (const cookie of [undefined, 'traces_session=odykyi.9999999999.AAAA']) {
    const html = await (await getPage(e, cookie)).text();
    expect(html).not.toContain('data-flisk-login');
    expect(html).not.toContain('<!--LOGIN-->');
  }
  // a validly signed cookie for a login that left the allowlist
  const { token, pub: pub2 } = await loginToken('odykyi', 'https://t');
  const e2 = authEnv(pub2);
  const cookie = /traces_session=[^;]+/.exec((await signIn(e2, token)).headers.getSetCookie().join('\n'))[0];
  expect((await (await getPage({ ...e2, ADMIN_LOGINS: 'someone' }, cookie)).text())).not.toContain('data-flisk-login');
});

test('GET / escapes the login', async () => {
  const e = authEnv('unused');
  e.ADMIN_LOGINS = '<b>x';
  const set = await makeSession(e, '<b>x');
  expect(hookOf(await (await getPage(e, set.split(';')[0])).text())).toEqual(['&lt;b&gt;x']);
});
