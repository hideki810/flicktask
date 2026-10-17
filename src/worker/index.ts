import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { organize } from './ai';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AI?: Ai;
  AI_MODEL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** ローカル検証専用。"1" のときだけ /auth/dev-login が有効になる。本番では設定しない */
  DEV_LOGIN?: string;
}

type User = { id: string; email: string; name: string; picture: string };
type Vars = { user: User };

const SESSION_COOKIE = '__Host-sid';
const SESSION_TTL = 60 * 60 * 24 * 60; // 60日
const STATUSES = new Set(['todo', 'doing', 'done']);

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- 共通ユーティリティ ----------

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function sha256(text: string) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

const cookieOpts = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' as const };

async function createSession(c: any, userId: string) {
  const token = randomToken();
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, expires)
    .run();
  setCookie(c, SESSION_COOKIE, token, { ...cookieOpts, maxAge: SESSION_TTL });
}

async function upsertUser(env: Env, p: { sub: string; email: string; name: string; picture: string }) {
  const id = crypto.randomUUID();
  return (await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture
     RETURNING id`
  )
    .bind(id, p.sub, p.email, p.name, p.picture, Date.now())
    .first<{ id: string }>())!.id;
}

async function currentUser(c: any): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const db: D1Database = c.env.DB;
  return await db.prepare(
    `SELECT u.id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(await sha256(token), Math.floor(Date.now() / 1000))
    .first<User>();
}

// ---------- Google 認証（OAuth 2.0 認可コード + PKCE） ----------

app.get('/auth/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text('Google 認証が未設定です', 503);
  const state = randomToken(16);
  const verifier = randomToken(48);
  const challenge = await sha256(verifier);
  const tmp = { ...cookieOpts, maxAge: 600 };
  setCookie(c, '__Host-oauth_state', state, tmp);
  setCookie(c, '__Host-oauth_verifier', verifier, tmp);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: new URL('/auth/google/callback', c.req.url).toString(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return c.redirect(url.toString());
});

app.get('/auth/google/callback', async (c) => {
  const { code, state } = c.req.query();
  const savedState = getCookie(c, '__Host-oauth_state');
  const verifier = getCookie(c, '__Host-oauth_verifier');
  deleteCookie(c, '__Host-oauth_state', cookieOpts);
  deleteCookie(c, '__Host-oauth_verifier', cookieOpts);
  if (!code || !state || state !== savedState || !verifier) return c.redirect('/?login=failed');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: new URL('/auth/google/callback', c.req.url).toString(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!res.ok) return c.redirect('/?login=failed');
  const { id_token } = await res.json<{ id_token: string }>();
  // トークンエンドポイントから TLS で直接受け取った ID トークンなので署名検証は省略できる（OIDC Core 3.1.3.7）。
  // ただし発行者・宛先・期限・メール確認済みは必ず確かめる
  const claims = JSON.parse(atob(id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const validIss = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!validIss || claims.aud !== c.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now() || !claims.email_verified) {
    return c.redirect('/?login=failed');
  }
  const userId = await upsertUser(c.env, {
    sub: claims.sub,
    email: claims.email,
    name: claims.name ?? '',
    picture: claims.picture ?? '',
  });
  await createSession(c, userId);
  return c.redirect('/');
});

// ローカル検証用の擬似ログイン。DEV_LOGIN=1 のときだけ存在する
app.get('/auth/dev-login', async (c) => {
  if (c.env.DEV_LOGIN !== '1') return c.notFound();
  const sub = c.req.query('sub') || 'dev-user';
  const userId = await upsertUser(c.env, { sub, email: `${sub}@example.com`, name: 'テストユーザー', picture: '' });
  await createSession(c, userId);
  return c.redirect('/');
});

app.post('/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, cookieOpts);
  return c.json({ ok: true });
});

// ---------- API ----------

app.use('/api/*', async (c, next) => {
  c.header('cache-control', 'no-store');
  // CSRF 対策：変更系はカスタムヘッダー必須（フォーム送信や単純リクエストでは付けられない）
  if (c.req.method !== 'GET' && c.req.header('x-ft') !== '1') return c.json({ error: 'bad_request' }, 400);
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', user);
  await next();
});

app.get('/api/me', (c) => c.json(c.get('user')));

type IncomingTask = {
  id: string;
  title: string;
  status: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
};

/**
 * 同期：端末の変更（changes）を受け取り、since 以降にサーバーで変わったものを返す。
 * 衝突は updatedAt が新しい方を採用（後勝ち）。
 */
app.post('/api/sync', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ since?: number; changes?: IncomingTask[] }>();
  const since = Number(body.since) || 0;
  const changes = (body.changes ?? []).slice(0, 500);
  const now = Date.now();

  const stmts = changes
    .filter(
      (t) =>
        typeof t.id === 'string' && t.id.length <= 64 && typeof t.title === 'string' && STATUSES.has(t.status)
    )
    .map((t) =>
      c.env.DB.prepare(
        `INSERT INTO tasks (id, user_id, title, status, position, created_at, updated_at, server_updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           title = excluded.title, status = excluded.status, position = excluded.position,
           updated_at = excluded.updated_at, server_updated_at = excluded.server_updated_at, deleted = excluded.deleted
         WHERE excluded.updated_at >= tasks.updated_at`
      ).bind(
        t.id,
        user.id,
        t.title.slice(0, 2000),
        t.status,
        Number(t.position) || 0,
        Number(t.createdAt) || now,
        Number(t.updatedAt) || now,
        now,
        t.deleted ? 1 : 0
      )
    );
  if (stmts.length) await c.env.DB.batch(stmts);

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, status, position, created_at AS createdAt, updated_at AS updatedAt, deleted
     FROM tasks WHERE user_id = ? AND server_updated_at > ? ORDER BY server_updated_at`
  )
    .bind(user.id, since)
    .all<Omit<IncomingTask, 'deleted'> & { deleted: number }>();

  return c.json({
    now,
    tasks: results.map((r) => ({ ...r, deleted: !!r.deleted })),
  });
});

// メモを AI でタスクに分ける
app.post('/api/ai/organize', async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  const input = (text ?? '').trim().slice(0, 4000);
  if (!input) return c.json({ source: 'fallback', titles: [] });
  return c.json(await organize(c.env, input));
});

app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

export default app;
