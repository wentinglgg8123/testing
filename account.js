import { parseBackup } from './ledger.js';

export class AccountError extends Error {
  constructor(message, status = 0, code = 'NETWORK_ERROR') { super(message); this.status = status; this.code = code; }
}

export async function accountRequest(path, method = 'GET', body, userId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Ledger-Request': '1', ...(userId ? { 'X-Ledger-User': userId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new AccountError('這個網址尚未啟用帳號服務。請使用已部署後端的網站；GitHub Pages 僅支援本機帳本。', response.status, 'BACKEND_UNAVAILABLE');
    const data = await response.json();
    if (!response.ok) throw new AccountError(data.error || '操作失敗，請稍後再試。', response.status, data.code);
    return data;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError('無法連線或請求逾時。尚未確認同步結果，請檢查網路後按「重新同步」確認帳本，再繼續操作。');
  } finally { clearTimeout(timeout); }
}

export function validateSnapshot(data) {
  if (!data?.user || typeof data.user.id !== 'string' || typeof data.user.username !== 'string' || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new AccountError('伺服器傳回的帳本格式不正確。', 0, 'INVALID_SNAPSHOT');
  return { user: { id: data.user.id, username: data.user.username }, revision: data.revision, records: parseBackup(JSON.stringify({ version: 1, records: data.records })) };
}
