import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseBackup } from './ledger.js';

const deriveKey = promisify(scrypt);
const ROOT = dirname(fileURLToPath(import.meta.url));
const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'ledger_session';
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['app.js', 'ledger.js', 'account.js'].map(name => [`/${name}`, [name, 'text/javascript; charset=utf-8']]),
]);

class ApiError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; }
}
function json(response, status, data, extra = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  response.end(JSON.stringify(data));
}
function readJSON(request, limit = 4096) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new ApiError(415, '請使用 JSON 格式傳送資料。');
  if (Number(request.headers['content-length']) > limit) { request.resume(); throw new ApiError(413, '傳送的資料太大。'); }
  return new Promise((accept, reject) => {
    let size = 0, exceeded = false;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        if (!exceeded) { exceeded = true; chunks.length = 0; reject(new ApiError(413, '傳送的資料太大。')); }
      } else if (!exceeded) chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        accept(value);
      } catch { reject(new ApiError(400, '資料格式不正確。')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new ApiError(400, '資料傳送中斷。')));
  });
}
function credentials(input) {
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  const password = input.password;
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new ApiError(400, '帳號須為 3–32 個英文字母、數字或底線。');
  if (typeof password !== 'string' || [...password].length < 10 || [...password].length > 128) throw new ApiError(400, '密碼須為 10–128 個字元。');
  return { username, password };
}
const sessionHash = token => createHash('sha256').update(token).digest('hex');

export function createLedgerServer({ dataDirectory = resolve(ROOT, '.ledger-data'), origin = '', production = false, clock = Date.now } = {}) {
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('LEDGER_ORIGIN 必須是完整網站來源，不含結尾斜線或路徑。');
  }
  if (production && !origin.startsWith('https://')) throw new Error('正式環境須設定 HTTPS 的 LEDGER_ORIGIN。');
  const secure = production || origin.startsWith('https://');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const dbFile = resolve(dataDirectory, 'ledger.sqlite');
  const db = new DatabaseSync(dbFile);
  chmodSync(dbFile, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      records TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_expiration ON sessions(expires_at);
  `);
  const byName = db.prepare('SELECT * FROM users WHERE username = ?');
  const sessionUser = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?');
  const insertSession = db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)');
  const insertUser = db.prepare('INSERT INTO users(id, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
  const updateLedger = db.prepare('UPDATE users SET records = ?, revision = revision + 1 WHERE id = ? AND revision = ?');
  const buckets = new Map();
  let hashing = 0;
  let nextCleanup = 0;

  async function hashPassword(password, salt) {
    if (hashing >= 4) throw new ApiError(503, '目前登入人數較多，請稍後再試。');
    hashing++;
    try { return await deriveKey(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
    finally { hashing--; }
  }
  function rateLimit(key, max, duration) {
    const now = clock();
    if (now >= nextCleanup) {
      for (const [name, bucket] of buckets) if (bucket.until <= now) buckets.delete(name);
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      nextCleanup = now + 60000;
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 10000) throw new ApiError(503, '服務忙碌，請稍後再試。');
      bucket = { count: 0, until: now + duration }; buckets.set(key, bucket);
    }
    if (++bucket.count > max) throw new ApiError(429, '嘗試次數過多，請於 15 分鐘後再試。', 'RATE_LIMITED');
  }
  function getToken(request) {
    const tokens = (request.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (tokens.length !== 1) return '';
    const token = tokens[0].slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : '';
  }
  function userFor(request) { const token = getToken(request); return token ? sessionUser.get(sessionHash(token), clock()) : null; }
  function cookie(token, maxAge = SESSION_LIFETIME / 1000) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  function issueSession(user, request) {
    const old = getToken(request);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash(old));
    const token = randomBytes(32).toString('hex');
    insertSession.run(sessionHash(token), user.id, clock() + SESSION_LIFETIME);
    return cookie(token);
  }
  const snapshot = user => ({ user: { id: user.id, username: user.username }, revision: user.revision, records: JSON.parse(user.records) });

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const path = new URL(request.url, 'http://ledger.invalid').pathname;
      const method = request.method;
      if (path === '/health' && method === 'GET') { json(response, 200, { status: 'ok' }); return; }
      if (!path.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(method) || !ASSETS.has(path)) throw new ApiError(404, '找不到此頁面。');
        const [file, contentType] = ASSETS.get(path);
        const body = readFileSync(resolve(ROOT, file));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        response.end(method === 'HEAD' ? undefined : body); return;
      }
      if (method !== 'GET') {
        const expectedOrigin = origin || `http://${request.headers.host}`;
        if (request.headers.origin !== expectedOrigin || request.headers['x-ledger-request'] !== '1') throw new ApiError(403, '請從記帳網站內操作。', 'INVALID_ORIGIN');
      }
      if (['/api/register', '/api/login'].includes(path) && method === 'POST') {
        rateLimit(`auth:${request.socket.remoteAddress}`, 60, 15 * 60 * 1000);
        const input = credentials(await readJSON(request));
        const existing = byName.get(input.username);
        if (path === '/api/register') {
          rateLimit(`register:${request.socket.remoteAddress}`, 10, 15 * 60 * 1000);
          if (existing) throw new ApiError(409, '此帳號已被使用，請換一個帳號。', 'USERNAME_TAKEN');
          const salt = randomBytes(32).toString('hex');
          const hash = await hashPassword(input.password, salt);
          // The username may have been registered while scrypt was running.
          if (byName.get(input.username)) throw new ApiError(409, '此帳號已被使用，請換一個帳號。', 'USERNAME_TAKEN');
          insertUser.run(randomUUID(), input.username, salt, hash.toString('hex'), clock());
          const user = byName.get(input.username);
          json(response, 201, snapshot(user), { 'Set-Cookie': issueSession(user, request) }); return;
        }
        const hash = await hashPassword(input.password, existing?.password_salt || '0'.repeat(64));
        const valid = timingSafeEqual(hash, Buffer.from(existing?.password_hash || '0'.repeat(128), 'hex'));
        if (!existing || !valid) throw new ApiError(401, '帳號或密碼不正確。', 'INVALID_CREDENTIALS');
        // Read the latest ledger after password verification finishes.
        const user = byName.get(input.username);
        json(response, 200, snapshot(user), { 'Set-Cookie': issueSession(user, request) }); return;
      }
      if (path === '/api/logout' && method === 'POST') {
        const token = getToken(request);
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash(token));
        json(response, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return;
      }
      const user = userFor(request);
      if (path === '/api/session' && method === 'GET') { json(response, 200, user ? snapshot(user) : { user: null }); return; }
      if (!user) throw new ApiError(401, '登入已過期，請重新登入。', 'AUTH_REQUIRED');
      if (path === '/api/ledger' && request.headers['x-ledger-user'] !== user.id) throw new ApiError(409, '登入帳號已在其他分頁變更，請重新登入。', 'ACCOUNT_CHANGED');
      if (path === '/api/ledger' && method === 'GET') { json(response, 200, snapshot(user)); return; }
      if (path === '/api/ledger' && method === 'PUT') {
        rateLimit(`writes:${user.id}`, 300, 60 * 1000);
        const data = await readJSON(request, 12 * 1024 * 1024);
        if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new ApiError(400, '缺少有效的帳本版本。');
        let records;
        try { records = parseBackup(JSON.stringify({ version: 1, records: data.records })); }
        catch { throw new ApiError(400, '帳本內容不正確，請確認金額、日期、分類與筆數。'); }
        if (!updateLedger.run(JSON.stringify(records), user.id, data.revision).changes) throw new ApiError(409, '另一個裝置已更新帳本，請重新同步後再操作。', 'REVISION_CONFLICT');
        json(response, 200, snapshot(byName.get(user.username))); return;
      }
      throw new ApiError(404, '找不到此功能。');
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500) console.error('Ledger request failed:', error.name);
      json(response, status, { error: status === 500 ? '服務暫時無法處理，請稍後再試。' : error.message, code: error.code || 'SERVER_ERROR' }, status === 429 ? { 'Retry-After': '900' } : {});
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.on('close', () => db.close());
  return server;
}
