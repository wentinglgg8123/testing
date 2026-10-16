import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createLedgerServer } from '../backend.js';

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-api-'));
  const server = createLedgerServer({ dataDirectory: directory, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const api = async (path, { method = 'GET', body, cookie = '', userId = '', origin = base, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Ledger-Request': '1', Origin: origin, Cookie: cookie, 'X-Ledger-User': userId, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  };
  const register = username => api('/api/register', { method: 'POST', body: { username, password: 'correct horse battery' } });
  return { api, register, directory, server };
}
const entry = overrides => ({ id: 'entry-one', type: 'expense', category: '餐飲', amount: 12050, date: '2026-10-17', note: '午餐', ...overrides });

test('註冊、工作階段與登出：密碼雜湊及登入憑證不以明文保存', async t => {
  const { api, register, directory } = await fixture(t);
  const created = await register('Alice');
  assert.equal(created.status, 201);
  assert.equal(created.data.user.username, 'alice');
  assert.deepEqual(created.data.records, []);
  assert.match(created.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=604800/);
  assert.equal(JSON.stringify(created.data).includes('password'), false);
  const read = new DatabaseSync(join(directory, 'ledger.sqlite'), { readOnly: true });
  const user = read.prepare('SELECT * FROM users').get();
  const session = read.prepare('SELECT * FROM sessions').get();
  assert.notEqual(user.password_hash, 'correct horse battery');
  assert.equal(user.password_hash.length, 128);
  assert.equal(user.password_salt.length, 64);
  assert.equal(created.cookie.includes(session.token_hash), false);
  read.close();
  assert.equal((await api('/api/session', { cookie: created.cookie })).data.user.id, user.id);
  const logout = await api('/api/logout', { method: 'POST', cookie: created.cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await api('/api/session', { cookie: created.cookie })).data.user, null);
});

test('拒絕重複帳號、弱密碼、非法帳號及錯誤登入，大小寫不產生重複帳號', async t => {
  const { api, register } = await fixture(t);
  assert.equal((await register('alice')).status, 201);
  assert.equal((await register('ALICE')).status, 409);
  for (const body of [{ username: 'ab', password: 'correct horse battery' }, { username: 'user', password: 'short' }, { username: 'invalid user', password: 'correct horse battery' }]) assert.equal((await api('/api/register', { method: 'POST', body })).status, 400);
  for (const username of ['alice', 'unknown_user']) {
    const result = await api('/api/login', { method: 'POST', body: { username, password: 'incorrect password' } });
    assert.equal(result.status, 401);
    assert.equal(result.data.error, '帳號或密碼不正確。');
  }
});

test('兩個裝置登入同一帳號可同步，其他帳號與匿名訪客無法讀寫', async t => {
  const { api, register } = await fixture(t);
  const alice = await register('alice');
  const bob = await register('bob');
  const aliceAuth = { cookie: alice.cookie, userId: alice.data.user.id };
  const bobAuth = { cookie: bob.cookie, userId: bob.data.user.id };
  assert.equal((await api('/api/ledger')).status, 401);
  assert.equal((await api('/api/ledger', { method: 'PUT', body: { revision: 0, records: [] } })).status, 401);
  const written = await api('/api/ledger', { ...aliceAuth, method: 'PUT', body: { revision: 0, records: [entry()] } });
  assert.equal(written.status, 200);
  assert.equal(written.data.revision, 1);
  assert.deepEqual((await api('/api/ledger', bobAuth)).data.records, []);
  const phone = await api('/api/login', { method: 'POST', body: { username: 'alice', password: 'correct horse battery' } });
  const fromPhone = await api('/api/ledger', { cookie: phone.cookie, userId: phone.data.user.id });
  assert.deepEqual(fromPhone.data.records, [entry()]);
  assert.equal((await api('/api/ledger', { ...bobAuth, method: 'PUT', body: { revision: 0, records: [entry({ id: 'bobs-entry' })], user_id: alice.data.user.id } })).status, 200);
  assert.deepEqual((await api('/api/ledger', aliceAuth)).data.records, [entry()]);
});

test('版本衝突及同瀏覽器切換帳號，不會覆蓋其他裝置或帳號', async t => {
  const { api, register } = await fixture(t);
  const alice = await register('alice');
  const bob = await register('bob');
  const auth = { cookie: alice.cookie, userId: alice.data.user.id };
  const results = await Promise.all([1, 2].map(i => api('/api/ledger', { ...auth, method: 'PUT', body: { revision: 0, records: [entry({ note: `裝置 ${i}` })] } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await api('/api/ledger', auth)).data.revision, 1);
  const wrongAccount = await api('/api/ledger', { cookie: bob.cookie, userId: alice.data.user.id, method: 'PUT', body: { revision: 0, records: [entry()] } });
  assert.equal(wrongAccount.data.code, 'ACCOUNT_CHANGED');
  assert.deepEqual((await api('/api/ledger', { cookie: bob.cookie, userId: bob.data.user.id })).data.records, []);
});

test('伺服器驗證帳本，無效資料不會更改原始版本', async t => {
  const { api, register } = await fixture(t);
  const alice = await register('alice');
  const auth = { cookie: alice.cookie, userId: alice.data.user.id, method: 'PUT' };
  for (const record of [entry({ amount: -1 }), entry({ date: '2026-02-29' }), entry({ category: '薪資' })]) assert.equal((await api('/api/ledger', { ...auth, body: { revision: 0, records: [record] } })).status, 400);
  assert.equal((await api('/api/ledger', { ...auth, body: { revision: 0, records: [entry(), entry()] } })).status, 400);
  assert.equal((await api('/api/ledger', { cookie: alice.cookie, userId: alice.data.user.id })).data.revision, 0);
});

test('跨來源請求及未帶驗證標頭的請求會被拒絕，私有檔案無法存取', async t => {
  const { api } = await fixture(t);
  const body = { username: 'alice', password: 'correct horse battery' };
  assert.equal((await api('/api/register', { method: 'POST', body, origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await api('/api/register', { method: 'POST', body, headers: { 'X-Ledger-Request': '' } })).status, 403);
  for (const path of ['/.ledger-data/ledger.sqlite', '/backend.js', '/.git/config', '/tests/backend.test.js', '/%2e%2e/.env']) assert.equal((await api(path)).status, 404);
  const home = await api('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('過期工作階段不可存取帳本，正式環境使用 Secure Cookie', async t => {
  let now = Date.now();
  const { api, register } = await fixture(t, { clock: () => now, production: true, origin: 'https://ledger.example' });
  const created = await api('/api/register', { method: 'POST', origin: 'https://ledger.example', body: { username: 'alice', password: 'correct horse battery' } });
  assert.match(created.headers.get('set-cookie'), /; Secure/);
  now += 8 * 24 * 60 * 60 * 1000;
  const expired = await api('/api/ledger', { cookie: created.cookie, userId: created.data.user.id });
  assert.equal(expired.status, 401);
  assert.equal(expired.data.code, 'AUTH_REQUIRED');
  assert.throws(() => createLedgerServer({ production: true }), /HTTPS/);
});

test('登入嘗試達上限後會回傳 429 與重試時間', async t => {
  const { api } = await fixture(t);
  let response;
  for (let i = 0; i < 61; i++) response = await api('/api/login', { method: 'POST', body: {} });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '900');
});

test('重新啟動伺服器後，帳號、登入工作階段與帳本仍保留', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = createLedgerServer({ dataDirectory: directory });
  first.listen(0, '127.0.0.1'); await once(first, 'listening');
  const base = `http://127.0.0.1:${first.address().port}`;
  const response = await fetch(`${base}/api/register`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Ledger-Request': '1' }, body: JSON.stringify({ username: 'alice', password: 'correct horse battery' }) });
  const user = (await response.json()).user;
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const saved = await fetch(`${base}/api/ledger`, { method: 'PUT', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Ledger-Request': '1', 'X-Ledger-User': user.id }, body: JSON.stringify({ revision: 0, records: [entry()] }) });
  assert.equal(saved.status, 200); await saved.json();
  first.closeAllConnections(); await new Promise(resolve => first.close(resolve));
  const second = createLedgerServer({ dataDirectory: directory });
  second.listen(0, '127.0.0.1'); await once(second, 'listening');
  try {
    const restored = await fetch(`http://127.0.0.1:${second.address().port}/api/ledger`, { headers: { Cookie: cookie, 'X-Ledger-User': user.id } });
    assert.deepEqual((await restored.json()).records, [entry()]);
  } finally { second.closeAllConnections(); await new Promise(resolve => second.close(resolve)); }
});
