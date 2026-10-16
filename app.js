import { STORAGE_KEY, CATEGORIES, localDate, amountToCents, validateRecord, parseBackup, summarize, filterRecords, toCSV } from './ledger.js';
import { accountRequest, validateSnapshot } from './account.js';

const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  chart: '<path d="M12 3v9h9A9 9 0 1 1 12 3Z"/><path d="M16 3.9A9 9 0 0 1 20.1 8H16Z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M7 3v4M17 3v4M7 14h3M14 14h3M7 17h3"/>',
  wallet: '<path d="M20 8H5a2 2 0 0 1 0-4h13v4M4 8v11a1 1 0 0 0 1 1h15V8Z"/><path d="M20 12h-5v4h5M16.5 14h.1"/>',
  up: '<path d="M7 17 17 7M7 7h10v10"/>',
  down: '<path d="M17 7 7 17M17 17H7V7"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  book: '<path d="M5 3h13v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 14h13M8 7h6M8 10h4"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  food: '<path d="M5 3v7m3-7v7M2 3v7a3 3 0 0 0 6 0M5 13v8M18 3c-4 4-4 9 0 9h2V3Zm2 9v9"/>',
  bus: '<rect x="4" y="3" width="16" height="16" rx="3"/><path d="M4 11h16M8 15h.1M16 15h.1M7 19v2M17 19v2M8 6h8"/>',
  bag: '<path d="M5 8h14l2 13H3ZM8 8V6a4 4 0 0 1 8 0v2"/>',
  home: '<path d="m3 10 9-8 9 8M5 9v12h14V9M9 21v-8h6v8"/>',
  fun: '<path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z"/>',
  health: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z"/>',
};
const categoryIcons = { '餐飲': 'food', '交通': 'bus', '購物': 'bag', '居家': 'home', '娛樂': 'fun', '醫療': 'health', '學習': 'book' };
const $ = selector => document.querySelector(selector);
function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.wallet}</svg>`;
  return span;
}
document.querySelectorAll('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon)));
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const formatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const money = cents => formatter.format(cents / 100);
const monthInput = $('#month');
monthInput.value = localDate().slice(0, 7);
$('#today-label').textContent = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());

let records = [];
let storageBlocked = false;
let editingId = null;
let formRecordId = null;
let currentType = 'expense';
let pendingConfirm = null;
let toastTimer;
const dialog = $('#record-dialog');
const confirmDialog = $('#confirm-dialog');
const authDialog = $('#auth-dialog');
let localRecords = [];
let localBlocked = false;
let cloudUser = null;
let cloudRevision = 0;
let cloudAvailable = null;
let cloudBusy = false;
let cloudNeedsSync = false;
let cloudAuthExpired = false;
let checkingSession = true;
let authMode = 'login';
let syncMessage = '';
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) records = parseBackup(raw);
} catch {
  storageBlocked = true;
  $('#storage-warning').hidden = false;
  $('#storage-warning').textContent = '無法讀取既有資料。為保護原始內容，目前暫停寫入。請先檢查瀏覽器儲存權限或還原有效備份；請勿直接清除瀏覽器資料。';
}
localRecords = records;
localBlocked = storageBlocked;

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

async function persist(next, recovering = false) {
  if (checkingSession) throw new Error('正在確認登入狀態，請稍候。');
  if (next.length > 20000) throw new Error('帳本上限為 20,000 筆，請先匯出備份。');
  if (cloudUser) {
    if (cloudBusy) throw new Error('帳本正在同步，請稍候。');
    if (cloudAuthExpired) throw new Error('登入已過期或帳號已切換，請重新登入。');
    if (cloudNeedsSync) throw new Error('請先按「重新同步」確認最新帳本，再繼續儲存。');
    cloudBusy = true; syncMessage = '正在同步…'; renderAccount();
    try {
      const data = validateSnapshot(await accountRequest('ledger', 'PUT', { revision: cloudRevision, records: next }, cloudUser.id));
      applyCloud(data);
    } catch (error) {
      cloudNeedsSync = true;
      cloudBusy = false;
      if (error.code === 'REVISION_CONFLICT') {
        await refreshCloud(false, true);
        throw new Error('另一個裝置已更新帳本，已嘗試重新同步。請檢查最新紀錄後再次儲存，你的輸入仍保留在表單中。');
      }
      handleCloudError(error);
      throw error;
    } finally { cloudBusy = false; renderAccount(); }
    return;
  }
  if (storageBlocked && !recovering) throw new Error('目前無法寫入。請檢查儲存權限，或使用有效備份還原帳本。');
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, records: next }));
  } catch {
    throw new Error('儲存失敗：瀏覽器空間不足或不允許儲存。請先下載備份並檢查設定。');
  }
  records = next;
  localRecords = next;
  localBlocked = false;
  storageBlocked = false;
  $('#storage-warning').hidden = true;
  render();
}

function populateCategories() {
  $('#category').replaceChildren(...CATEGORIES[currentType].map(name => new Option(name, name)));
  document.querySelectorAll('[data-type]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.type === currentType)));
}
function openRecord(record = null) {
  $('#record-form').reset();
  editingId = record?.id ?? null;
  formRecordId = record?.id ?? crypto.randomUUID();
  currentType = record?.type ?? 'expense';
  populateCategories();
  $('#dialog-title').textContent = record ? '編輯這筆日常' : '記錄一筆日常';
  $('#amount').value = record ? String(record.amount / 100) : '';
  $('#date').value = record?.date ?? localDate();
  if (record) $('#category').value = record.category;
  $('#note').value = record?.note ?? '';
  $('#form-error').hidden = true;
  dialog.showModal();
  $('#amount').focus();
}
$('#add-button').addEventListener('click', () => openRecord());
$('#empty-add').addEventListener('click', () => openRecord());
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => dialog.close()));
document.querySelectorAll('[data-type]').forEach(button => button.addEventListener('click', () => { currentType = button.dataset.type; populateCategories(); }));

$('#record-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#save-record').disabled) return;
  $('#save-record').disabled = true;
  try {
    const record = validateRecord({
      id: formRecordId,
      type: currentType,
      category: $('#category').value,
      amount: amountToCents($('#amount').value),
      date: $('#date').value,
      note: $('#note').value.trim(),
    });
    if (editingId && !records.some(r => r.id === editingId)) throw new Error('這筆紀錄已在其他分頁刪除，請關閉後重新操作。');
    if (!editingId && records.some(r => r.id === formRecordId)) throw new Error('這筆紀錄已同步成功，請關閉表單並確認帳本，避免重複新增。');
    const next = editingId ? records.map(r => r.id === editingId ? record : r) : [...records, record];
    monthInput.value = record.date.slice(0, 7);
    $('#type-filter').value = '';
    $('#category-filter').value = '';
    $('#search').value = '';
    await persist(next);
    dialog.close();
    toast(editingId ? '已更新這筆紀錄' : '已記下這筆日常');
  } catch (error) {
    $('#form-error').textContent = error.message;
    $('#form-error').hidden = false;
  } finally { $('#save-record').disabled = false; }
});

function askConfirmation(title, description, buttonText, action) {
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-proceed').textContent = buttonText;
  pendingConfirm = action;
  confirmDialog.showModal();
  $('#confirm-cancel').focus();
}
$('#confirm-cancel').addEventListener('click', () => confirmDialog.close());
$('#confirm-close').addEventListener('click', () => confirmDialog.close());
confirmDialog.addEventListener('close', () => { pendingConfirm = null; });
$('#confirm-proceed').addEventListener('click', async () => {
  const action = pendingConfirm;
  $('#confirm-proceed').disabled = true;
  try { await action?.(); confirmDialog.close(); } catch (error) { toast(error.message); }
  finally { $('#confirm-proceed').disabled = false; }
});

function render() {
  const monthRecords = filterRecords(records, { month: monthInput.value });
  const stats = summarize(monthRecords);
  $('#balance').textContent = `${stats.balance < 0 ? '−' : ''}NT$ ${money(Math.abs(stats.balance))}`;
  $('#income').textContent = `NT$ ${money(stats.income)}`;
  $('#expense').textContent = `NT$ ${money(stats.expense)}`;
  $('#balance-hint').textContent = stats.balance < 0 ? '本月支出超過收入，留意花費節奏' : '收入減去支出，生活心裡有數';
  $('#income-count').textContent = `${monthRecords.filter(r => r.type === 'income').length} 筆進帳`;
  $('#expense-count').textContent = `${monthRecords.filter(r => r.type === 'expense').length} 筆花費`;
  $('#record-count').textContent = monthRecords.length;
  const shown = filterRecords(monthRecords, { type: $('#type-filter').value, category: $('#category-filter').value, query: $('#search').value });
  const fragment = document.createDocumentFragment();
  for (const record of shown) {
    const row = document.createElement('tr');
    const itemCell = document.createElement('td');
    const item = el('div', 'transaction-item');
    const symbol = el('span', 'category-icon');
    if (record.type === 'income') { symbol.style.background = '#edf5ef'; symbol.style.color = '#38896d'; }
    symbol.append(icon(categoryIcons[record.category] || 'wallet'));
    const description = el('div', 'transaction-text');
    const title = el('div', 'transaction-title', record.note || record.category);
    title.title = record.note || record.category;
    description.append(title, el('div', 'transaction-category', `${record.category} · ${record.type === 'income' ? '收入' : '支出'}`));
    item.append(symbol, description);
    itemCell.append(item);
    const date = el('td', 'date-cell', record.date.replaceAll('-', '/'));
    const amount = el('td', `amount-cell ${record.type}`, `${record.type === 'income' ? '+' : '−'} ${money(record.amount)}`);
    const actionsCell = document.createElement('td');
    const actions = el('div', 'row-actions');
    const edit = el('button', 'icon-button');
    edit.setAttribute('aria-label', `編輯 ${record.note || record.category}`);
    edit.append(icon('edit'));
    edit.addEventListener('click', () => openRecord(record));
    const remove = el('button', 'icon-button delete-button');
    remove.setAttribute('aria-label', `刪除 ${record.note || record.category}`);
    remove.append(icon('trash'));
    remove.addEventListener('click', () => askConfirmation('刪除這筆紀錄？', `${record.date} · ${record.note || record.category} · NT$ ${money(record.amount)}\n刪除後無法復原。`, '確認刪除', async () => { await persist(records.filter(r => r.id !== record.id)); toast('已刪除紀錄'); }));
    actions.append(edit, remove);
    actionsCell.append(actions);
    row.append(itemCell, date, amount, actionsCell);
    fragment.append(row);
  }
  $('#record-list').replaceChildren(fragment);
  $('#empty-state').hidden = shown.length > 0;
  const hasFilters = Boolean($('#search').value.trim() || $('#type-filter').value || $('#category-filter').value);
  $('#empty-title').textContent = hasFilters ? '沒有符合的紀錄' : '讓第一筆，成為好習慣的開始';
  $('#empty-description').textContent = hasFilters ? '試試其他關鍵字或篩選條件。' : '早餐、車票，或今天的小確幸，從這裡記下來。';
  $('#empty-add').hidden = hasFilters;
  $('#list-summary').textContent = hasFilters ? `顯示 ${shown.length} / ${monthRecords.length} 筆紀錄` : `共 ${shown.length} 筆紀錄`;
  $('#donut-total').textContent = `$${money(stats.expense)}`;
  $('#donut').setAttribute('aria-label', stats.expense ? `本月總支出 ${money(stats.expense)} 元。${stats.categories.map(c => `${c.name} ${money(c.amount)} 元`).join('，')}` : '本月尚無支出');
  let angle = 0;
  const segments = stats.categories.map(category => {
    const from = angle;
    angle += category.amount / stats.expense * 360;
    return `${category.color} ${from}deg ${angle}deg`;
  });
  $('#donut').style.background = segments.length ? `conic-gradient(${segments.join(',')})` : '#f0f3ec';
  $('#category-list').replaceChildren(...stats.categories.map(category => {
    const share = category.amount / stats.expense * 100;
    const wrapper = el('div', 'category-row');
    const info = el('div', 'category-info');
    const dot = el('span', 'category-dot'); dot.style.background = category.color;
    info.append(dot, el('span', '', category.name), el('span', 'category-amount', `$${money(category.amount)}`), el('span', 'category-percent', `${share.toFixed(0)}%`));
    const track = el('div', 'category-track');
    const fill = el('div', 'category-fill'); fill.style.width = `${share}%`; fill.style.background = category.color;
    track.append(fill); wrapper.append(info, track);
    return wrapper;
  }));
  $('#analysis-note').textContent = stats.categories.length ? `「${stats.categories[0].name}」是本月最大支出，占 ${Math.round(stats.categories[0].amount / stats.expense * 100)}%。` : '記下第一筆支出，讓生活的輪廓更清楚。';
  $('#previous-month').disabled = monthInput.value === '1900-01';
  $('#next-month').disabled = monthInput.value === '9999-12';
}

Object.values(CATEGORIES).flat().forEach(name => $('#category-filter').append(new Option(name, name)));
for (const id of ['search', 'type-filter', 'category-filter']) $(`#${id}`).addEventListener('input', render);
monthInput.addEventListener('change', () => {
  if (!monthInput.value || !monthInput.validity.valid) monthInput.value = localDate().slice(0, 7);
  render();
});
function moveMonth(delta) {
  const [year, month] = monthInput.value.split('-').map(Number);
  const moved = new Date(year, month - 1 + delta, 1);
  monthInput.value = localDate(moved).slice(0, 7);
  render();
}
$('#previous-month').addEventListener('click', () => moveMonth(-1));
$('#next-month').addEventListener('click', () => moveMonth(1));

function download(contents, filename, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#backup-button').addEventListener('click', () => {
  if (storageBlocked) { toast('無法讀取原始帳本，請先修復儲存權限；不會下載空白備份。'); return; }
  download(JSON.stringify({ version: 1, records }, null, 2), `小日子記帳-${localDate()}.json`, 'application/json;charset=utf-8');
  toast('已下載完整帳本備份，請妥善保存');
});
$('#csv-button').addEventListener('click', () => {
  if (storageBlocked) { toast('無法讀取原始帳本，請先修復儲存權限。'); return; }
  const shown = filterRecords(records, { month: monthInput.value, type: $('#type-filter').value, category: $('#category-filter').value, query: $('#search').value });
  if (!shown.length) { toast('目前沒有可匯出的紀錄'); return; }
  download(toCSV(shown), `收支明細-${monthInput.value}.csv`, 'text/csv;charset=utf-8');
  toast(`已匯出目前篩選的 ${shown.length} 筆紀錄`);
});
$('#import-button').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('備份檔案不得超過 5 MB。');
    const incoming = parseBackup(await file.text());
    askConfirmation('還原備份帳本？', `備份內有 ${incoming.length} 筆紀錄，將取代${cloudUser ? '目前帳號所有裝置的帳本' : '目前所有資料'}。\n建議先下載目前的備份，再進行還原。`, '確認還原', async () => {
      await persist(incoming, true);
      if (incoming.length) monthInput.value = filterRecords(incoming)[0].date.slice(0, 7);
      $('#search').value = ''; $('#type-filter').value = ''; $('#category-filter').value = '';
      render();
      toast(`已還原 ${incoming.length} 筆紀錄`);
    });
  } catch (error) { toast(error instanceof SyntaxError ? '檔案不是有效的 JSON 備份。' : error.message); }
});
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    localRecords = raw === null ? [] : parseBackup(raw);
    localBlocked = false;
    if (cloudUser) { renderAccount(); return; }
    records = localRecords;
    storageBlocked = false; $('#storage-warning').hidden = true;
    render(); toast('已同步其他分頁的更新');
  } catch {
    localBlocked = true;
    if (cloudUser) { renderAccount(); return; }
    storageBlocked = true;
    $('#storage-warning').hidden = false;
    $('#storage-warning').textContent = '其他分頁的資料更新無法讀取，已暫停寫入以保護資料。請檢查儲存權限或還原備份。';
  }
});

function renderAccount() {
  $('#account-label').textContent = cloudUser ? `${cloudUser.username} 的帳本` : '本機帳本';
  $('#sync-status').textContent = checkingSession ? '正在確認登入狀態…' : cloudUser ? syncMessage : '僅儲存在此瀏覽器';
  $('#account-dot').classList.toggle('online', Boolean(cloudUser && !cloudNeedsSync));
  $('#account-button').textContent = cloudUser ? cloudAuthExpired ? '重新登入' : cloudUser.username : '登入 / 註冊';
  $('#account-button').disabled = checkingSession || cloudBusy || Boolean(cloudUser && !cloudAuthExpired);
  $('#logout-button').hidden = !cloudUser;
  $('#logout-button').disabled = checkingSession || cloudBusy;
  $('#refresh-button').hidden = !cloudUser;
  $('#refresh-button').disabled = cloudBusy;
  const knownIds = new Set(records.map(record => record.id));
  const count = localRecords.filter(record => !knownIds.has(record.id)).length;
  $('#migrate-button').hidden = !cloudUser || localBlocked || count === 0;
  $('#migrate-button').disabled = cloudBusy;
  $('#migrate-button').textContent = `加入本機紀錄（${count}）`;
  $('#add-button').disabled = checkingSession || cloudBusy;
  $('#empty-add').disabled = checkingSession || cloudBusy;
  $('#import-button').disabled = checkingSession || cloudBusy;
  document.querySelectorAll('.close-dialog').forEach(button => { button.disabled = cloudBusy; });
  for (const id of ['confirm-cancel', 'confirm-close', 'auth-close', 'auth-cancel']) $(`#${id}`).disabled = cloudBusy;
  $('#storage-description').replaceChildren(document.createTextNode(cloudUser ? '帳本保存在帳號中' : '資料保存在此瀏覽器'), document.createElement('br'), el('small', '', cloudUser ? '登入同一帳號即可同步' : '登入帳號可跨裝置同步'));
  $('#backup-description').textContent = cloudUser ? '帳本已連接帳號。其他裝置登入同一帳號即可同步，仍建議定期下載備份。' : '本機帳本只存於此瀏覽器。登入帳號可同步，仍建議定期下載備份。';
}

function applyCloud(data) {
  cloudUser = data.user;
  cloudRevision = data.revision;
  records = data.records;
  storageBlocked = false;
  cloudNeedsSync = false;
  cloudAuthExpired = false;
  syncMessage = `已同步 ${new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())}`;
  $('#storage-warning').hidden = true;
  $('#cloud-warning').hidden = true;
  render(); renderAccount();
}

function handleCloudError(error) {
  cloudNeedsSync = true;
  if (['AUTH_REQUIRED', 'ACCOUNT_CHANGED'].includes(error.code)) cloudAuthExpired = true;
  syncMessage = cloudAuthExpired ? '需要重新登入' : '尚未確認同步，請重試';
  $('#cloud-warning').textContent = error.message;
  $('#cloud-warning').hidden = false;
  renderAccount();
}

async function refreshCloud(notify = false, duringEdit = false) {
  if (!cloudUser || cloudBusy || (!duringEdit && (dialog.open || confirmDialog.open || authDialog.open))) return false;
  cloudBusy = true; syncMessage = '正在同步…'; renderAccount();
  try {
    const data = validateSnapshot(await accountRequest('ledger', 'GET', undefined, cloudUser.id));
    applyCloud(data);
    if (notify) toast('已取得最新帳本');
    return true;
  } catch (error) { handleCloudError(error); if (notify) toast(error.message); return false; }
  finally { cloudBusy = false; renderAccount(); }
}

function setAuthMode(mode) {
  authMode = mode;
  $('#auth-title').textContent = mode === 'register' ? '建立你的帳本帳號' : '登入你的帳本';
  $('#auth-submit').textContent = mode === 'register' ? '建立帳號' : '登入帳號';
  $('#password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#confirm-password-field').hidden = mode !== 'register';
  $('#confirm-password').required = mode === 'register';
  $('#confirm-password').disabled = mode !== 'register';
  document.querySelectorAll('[data-auth]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.auth === mode)));
  $('#auth-error').hidden = true;
}
$('#account-button').addEventListener('click', () => {
  setAuthMode('login');
  if (cloudAvailable === false) {
    $('#auth-error').textContent = '此網址沒有啟用帳號服務。GitHub Pages 僅支援本機記帳；請開啟已部署 Node.js 後端的網站使用登入與同步。';
    $('#auth-error').hidden = false;
  }
  authDialog.showModal(); $('#username').focus();
});
document.querySelectorAll('[data-auth]').forEach(button => button.addEventListener('click', () => setAuthMode(button.dataset.auth)));
$('#auth-close').addEventListener('click', () => authDialog.close());
$('#auth-cancel').addEventListener('click', () => authDialog.close());
authDialog.addEventListener('close', () => { $('#auth-form').reset(); $('#auth-error').hidden = true; });
for (const modal of [authDialog, dialog, confirmDialog]) modal.addEventListener('cancel', event => { if (cloudBusy) event.preventDefault(); });
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (cloudBusy) return;
  if (authMode === 'register' && $('#password').value !== $('#confirm-password').value) {
    $('#auth-error').textContent = '兩次輸入的密碼不一致。'; $('#auth-error').hidden = false; return;
  }
  cloudBusy = true; renderAccount();
  $('#auth-submit').disabled = true;
  document.querySelectorAll('[data-auth]').forEach(button => { button.disabled = true; });
  try {
    const data = validateSnapshot(await accountRequest(authMode, 'POST', { username: $('#username').value.trim(), password: $('#password').value }));
    cloudAvailable = true;
    applyCloud(data);
    if (data.records.length && !filterRecords(records, { month: monthInput.value }).length) monthInput.value = filterRecords(records)[0].date.slice(0, 7);
    $('#search').value = ''; $('#type-filter').value = ''; $('#category-filter').value = '';
    render(); authDialog.close();
    toast(localRecords.length ? '已登入；可按「加入本機紀錄」移轉原有帳本' : '已登入，可以在其他裝置使用同一帳號');
  } catch (error) {
    $('#auth-error').textContent = error.message; $('#auth-error').hidden = false;
  } finally {
    cloudBusy = false; renderAccount(); $('#auth-submit').disabled = false;
    document.querySelectorAll('[data-auth]').forEach(button => { button.disabled = false; });
  }
});
$('#logout-button').addEventListener('click', async () => {
  if (cloudBusy) return;
  cloudBusy = true; renderAccount();
  try {
    await accountRequest('logout', 'POST', {});
    cloudUser = null; cloudRevision = 0; cloudNeedsSync = false; cloudAuthExpired = false;
    $('#cloud-warning').hidden = true;
    try { const raw = localStorage.getItem(STORAGE_KEY); localRecords = raw === null ? [] : parseBackup(raw); localBlocked = false; }
    catch { localRecords = []; localBlocked = true; }
    records = localRecords; storageBlocked = localBlocked;
    $('#storage-warning').hidden = !localBlocked;
    if (localBlocked) $('#storage-warning').textContent = '無法讀取本機帳本，已暫停寫入。請檢查瀏覽器儲存權限或還原有效備份。';
    render(); toast('已登出，目前顯示此瀏覽器的本機帳本');
  } catch (error) { toast('無法確認登出，請檢查網路後再試。'); }
  finally { cloudBusy = false; renderAccount(); }
});
$('#refresh-button').addEventListener('click', () => refreshCloud(true));
$('#migrate-button').addEventListener('click', () => {
  askConfirmation('將本機紀錄加入帳號？', '本機帳本會加入目前帳號，之後能在其他裝置查看。\n相同識別碼保留帳號中的紀錄，不會覆蓋或重複加入。本機原始資料仍會保留。', '確認加入', async () => {
    const ids = new Set(records.map(record => record.id));
    const additions = localRecords.filter(record => !ids.has(record.id));
    await persist([...records, ...additions]);
    renderAccount(); toast(`已將 ${additions.length} 筆本機紀錄加入帳號`);
  });
});

async function checkSession() {
  try {
    const data = await accountRequest('session');
    cloudAvailable = true;
    if (data.user) applyCloud(validateSnapshot(data));
  } catch (error) {
    cloudAvailable = error.code === 'BACKEND_UNAVAILABLE' ? false : null;
    if (cloudAvailable !== false) {
      $('#cloud-warning').textContent = '暫時無法確認登入狀態，目前顯示本機帳本。請檢查網路，再使用「登入 / 註冊」重新連線。';
      $('#cloud-warning').hidden = false;
    }
  } finally { checkingSession = false; renderAccount(); }
}
window.addEventListener('focus', () => { if (!cloudAuthExpired) refreshCloud(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !cloudAuthExpired) refreshCloud(); });
setInterval(() => { if (document.visibilityState === 'visible' && !cloudAuthExpired) refreshCloud(); }, 30000);
render(); renderAccount();
checkSession();
