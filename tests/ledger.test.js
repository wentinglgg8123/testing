import test from 'node:test';
import assert from 'node:assert/strict';
import { amountToCents, validateRecord, parseBackup, summarize, filterRecords, toCSV, localDate } from '../ledger.js';

const record = (overrides = {}) => ({ id: 'first', type: 'expense', category: '餐飲', amount: 12550, date: '2026-10-17', note: '午餐', ...overrides });

test('金額以整數分運算，保留小數精度', () => {
  assert.equal(amountToCents('0.10') + amountToCents('0.20'), 30);
  assert.equal(amountToCents('125.5'), 12550);
  assert.equal(amountToCents('999999999.99'), 99999999999);
  for (const value of ['0', '-1', '1.234', 'abc', '', 'Infinity', '1e3', '1000000000']) assert.throws(() => amountToCents(value));
});

test('收支資料驗證類型、分類、金額與備註', () => {
  assert.deepEqual(validateRecord(record()), record());
  for (const fields of [{ type: 'other' }, { type: '__proto__' }, { category: '薪資' }, { amount: 0 }, { amount: 1.2 }, { amount: Infinity }, { id: '' }, { note: 'a'.repeat(121) }]) assert.throws(() => validateRecord(record(fields)));
});

test('拒絕不存在的日期，同時接受閏年日期與日期邊界', () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', 'not-a-date', '1899-12-31', '2026-1-1']) assert.throws(() => validateRecord(record({ date })));
  for (const date of ['2024-02-29', '1900-01-01', '9999-12-31']) assert.equal(validateRecord(record({ date })).date, date);
});

test('月份統計只計算指定月份，類別依支出排序，餘額可為負', () => {
  const records = [record(), record({ id: 'second', type: 'income', category: '薪資', amount: 10000 }), record({ id: 'third', category: '交通', amount: 3000 }), record({ id: 'other-month', amount: 99000, date: '2026-09-30' })];
  const totals = summarize(filterRecords(records, { month: '2026-10' }));
  assert.equal(totals.income, 10000);
  assert.equal(totals.expense, 15550);
  assert.equal(totals.balance, -5550);
  assert.deepEqual(totals.categories.map(c => [c.name, c.amount]), [['餐飲', 12550], ['交通', 3000]]);
});

test('沒有紀錄時統計回傳零與空分類', () => {
  assert.deepEqual(summarize([]), { income: 0, expense: 0, balance: 0, categories: [] });
});

test('搜尋、類型、月份與分類可同時篩選，依日期降冪排序', () => {
  const records = [record({ id: '1' }), record({ id: '2', note: '早餐', date: '2026-10-18' }), record({ id: '3', type: 'income', category: '薪資', note: '午餐津貼' })];
  assert.deepEqual(filterRecords(records).map(r => r.id), ['2', '3', '1']);
  assert.deepEqual(filterRecords(records, { month: '2026-10', type: 'expense', category: '餐飲', query: ' 午餐 ' }).map(r => r.id), ['1']);
  assert.equal(filterRecords(records, { month: '2026-09' }).length, 0);
});

test('備份可完整還原中文資料、拒絕損壞與重複紀錄', () => {
  assert.deepEqual(parseBackup(JSON.stringify({ version: 1, records: [record()] })), [record()]);
  for (const value of ['{}', 'null', '[]', 'not json', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [record(), record()] }), JSON.stringify({ version: 1, records: [record({ amount: -1 })] })]) assert.throws(() => parseBackup(value));
});

test('CSV 使用中文標題、正確跳脫引號換行並避免試算表公式注入', () => {
  const csv = toCSV([record({ note: '=HYPERLINK("example")\n下一行' })]);
  assert.ok(csv.startsWith('\uFEFF"日期"'));
  assert.ok(csv.includes('"125.50"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""example"")\n下一行"'));
});

test('日期使用執行環境的當地年月日', () => {
  assert.equal(localDate(new Date(2026, 0, 2, 1, 0)), '2026-01-02');
});
