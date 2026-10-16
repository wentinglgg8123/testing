import { STORAGE_KEY, CATEGORIES, localDate, amountToCents, validateRecord, parseBackup, summarize, filterRecords, toCSV } from './ledger.js';

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
let currentType = 'expense';
let pendingConfirm = null;
let toastTimer;
const dialog = $('#record-dialog');
const confirmDialog = $('#confirm-dialog');
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) records = parseBackup(raw);
} catch {
  storageBlocked = true;
  $('#storage-warning').hidden = false;
  $('#storage-warning').textContent = '無法讀取既有資料。為保護原始內容，目前暫停寫入。請先檢查瀏覽器儲存權限或還原有效備份；請勿直接清除瀏覽器資料。';
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function persist(next, recovering = false) {
  if (storageBlocked && !recovering) throw new Error('目前無法寫入。請檢查儲存權限，或使用有效備份還原帳本。');
  if (next.length > 20000) throw new Error('帳本上限為 20,000 筆，請先匯出備份。');
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, records: next }));
  } catch {
    throw new Error('儲存失敗：瀏覽器空間不足或不允許儲存。請先下載備份並檢查設定。');
  }
  records = next;
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

$('#record-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const record = validateRecord({
      id: editingId ?? crypto.randomUUID(),
      type: currentType,
      category: $('#category').value,
      amount: amountToCents($('#amount').value),
      date: $('#date').value,
      note: $('#note').value.trim(),
    });
    if (editingId && !records.some(r => r.id === editingId)) throw new Error('這筆紀錄已在其他分頁刪除，請關閉後重新操作。');
    const next = editingId ? records.map(r => r.id === editingId ? record : r) : [...records, record];
    monthInput.value = record.date.slice(0, 7);
    $('#type-filter').value = '';
    $('#category-filter').value = '';
    $('#search').value = '';
    persist(next);
    dialog.close();
    toast(editingId ? '已更新這筆紀錄' : '已記下這筆日常');
  } catch (error) {
    $('#form-error').textContent = error.message;
    $('#form-error').hidden = false;
  }
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
$('#confirm-proceed').addEventListener('click', () => {
  const action = pendingConfirm;
  try { action?.(); confirmDialog.close(); } catch (error) { toast(error.message); }
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
    remove.addEventListener('click', () => askConfirmation('刪除這筆紀錄？', `${record.date} · ${record.note || record.category} · NT$ ${money(record.amount)}\n刪除後無法復原。`, '確認刪除', () => { persist(records.filter(r => r.id !== record.id)); toast('已刪除紀錄'); }));
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
    askConfirmation('還原備份帳本？', `備份內有 ${incoming.length} 筆紀錄，將取代目前所有資料。\n建議先下載目前的備份，再進行還原。`, '確認還原', () => {
      persist(incoming, true);
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
    records = raw === null ? [] : parseBackup(raw);
    storageBlocked = false; $('#storage-warning').hidden = true;
    render(); toast('已同步其他分頁的更新');
  } catch {
    storageBlocked = true;
    $('#storage-warning').hidden = false;
    $('#storage-warning').textContent = '其他分頁的資料更新無法讀取，已暫停寫入以保護資料。請檢查儲存權限或還原備份。';
  }
});
render();
