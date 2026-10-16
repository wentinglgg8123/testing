export const STORAGE_KEY = 'little-ledger.v1';
export const CATEGORIES = {
  expense: ['餐飲', '交通', '購物', '居家', '娛樂', '醫療', '學習', '其他支出'],
  income: ['薪資', '獎金', '投資', '其他收入'],
};
export const COLORS = ['#278772', '#e0a263', '#7b8dc5', '#cf8580', '#89a99a', '#b79bc3', '#99afc5', '#b6b6ad'];

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function amountToCents(value) {
  const input = String(value).trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(input)) throw new Error('請輸入大於 0 的金額，最多兩位小數、九位整數。');
  const [whole, fraction = ''] = input.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (amount <= 0) throw new Error('金額必須大於 0。');
  return amount;
}

export function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('資料格式不正確。');
  const { id, type, category, amount, date, note } = record;
  if (typeof id !== 'string' || !id || id.length > 100) throw new Error('紀錄識別碼不正確。');
  if (!Object.hasOwn(CATEGORIES, type) || !CATEGORIES[type].includes(category)) throw new Error('收支類型或分類不正確。');
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 99999999999) throw new Error('紀錄金額超出允許範圍。');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不正確。');
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date < '1900-01-01' || date > '9999-12-31') throw new Error('請輸入有效日期（1900–9999 年）。');
  if (typeof note !== 'string' || note.length > 120) throw new Error('備註不得超過 120 字。');
  return { id, type, category, amount, date, note };
}

export function parseBackup(text) {
  const data = JSON.parse(text);
  if (data?.version !== 1 || !Array.isArray(data.records) || data.records.length > 20000) throw new Error('備份格式不正確或超過 20,000 筆。');
  const records = data.records.map(validateRecord);
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('備份中有重複的紀錄識別碼。');
  return records;
}

export function summarize(records) {
  const income = records.filter(r => r.type === 'income').reduce((sum, r) => sum + r.amount, 0);
  const expense = records.filter(r => r.type === 'expense').reduce((sum, r) => sum + r.amount, 0);
  const categories = CATEGORIES.expense.map((name, i) => ({ name, color: COLORS[i], amount: records.filter(r => r.type === 'expense' && r.category === name).reduce((sum, r) => sum + r.amount, 0) })).filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
  return { income, expense, balance: income - expense, categories };
}

export function filterRecords(records, { month = '', type = '', category = '', query = '' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  return records.filter(r => (!month || r.date.startsWith(month)) && (!type || r.type === type) && (!category || r.category === category) && (!search || `${r.note} ${r.category} ${r.date}`.toLocaleLowerCase().includes(search))).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export function toCSV(records) {
  const cell = value => {
    const text = String(value);
    // Prevent spreadsheet formula execution when opening user-authored notes.
    const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [['日期', '類型', '分類', '金額（TWD）', '備註'], ...filterRecords(records).map(r => [r.date, r.type === 'income' ? '收入' : '支出', r.category, (r.amount / 100).toFixed(2), r.note])].map(row => row.map(cell).join(',')).join('\r\n');
}
