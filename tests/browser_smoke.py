"""Browser integration checks. Start the app first; requires Python Playwright + Chromium."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get('LEDGER_TEST_URL', 'http://127.0.0.1:3000')
STORAGE_KEY = 'little-ledger.v1'


def add_record(page, amount, category, note, kind='expense', date='2026-10-17'):
    page.locator('#add-button').click()
    page.locator(f'[data-type="{kind}"]').click()
    page.locator('#amount').fill(amount)
    page.locator('#category').select_option(category)
    page.locator('#date').fill(date)
    page.locator('#note').fill(note)
    page.locator('#save-record').click()
    expect(page.locator('#record-dialog')).not_to_be_visible()


def select_month(page, month='2026-10'):
    page.locator('#month').fill(month)
    page.locator('#month').dispatch_event('change')


with sync_playwright() as p:
    executable = os.environ.get('LEDGER_CHROMIUM', '/usr/bin/chromium')
    browser = p.chromium.launch(executable_path=executable if Path(executable).exists() else None, headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1050}, locale='zh-TW', timezone_id='Asia/Taipei', accept_downloads=True)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    assert page.goto(BASE_URL).status == 200
    expect(page.locator('#empty-state')).to_be_visible()

    # Create records, verify integer-cent statistics and a category breakdown.
    add_record(page, '120.50', '餐飲', '午餐')
    add_record(page, '80', '交通', '捷運')
    add_record(page, '50000', '薪資', '十月薪水', 'income')
    expect(page.locator('#income')).to_have_text('NT$ 50,000')
    expect(page.locator('#expense')).to_have_text('NT$ 200.5')
    expect(page.locator('#balance')).to_have_text('NT$ 49,799.5')
    expect(page.locator('#category-list .category-row')).to_have_count(2)

    # Edit an existing record; invalid input must not close the form or write data.
    page.get_by_role('button', name='編輯 午餐', exact=True).click()
    page.locator('#amount').fill('-1')
    page.locator('#save-record').click()
    expect(page.locator('#form-error')).to_be_visible()
    page.locator('#amount').fill('130.50')
    page.locator('#save-record').click()
    expect(page.locator('#expense')).to_have_text('NT$ 210.5')
    page.reload()
    select_month(page)
    expect(page.locator('#record-list tr')).to_have_count(3)
    expect(page.locator('#balance')).to_have_text('NT$ 49,789.5')

    # Search/type filters only affect the list, not the full month's statistics.
    page.locator('#search').fill('午餐')
    expect(page.locator('#record-list tr')).to_have_count(1)
    expect(page.locator('#expense')).to_have_text('NT$ 210.5')
    page.locator('#type-filter').select_option('income')
    expect(page.locator('#record-list tr')).to_have_count(0)
    expect(page.locator('#empty-title')).to_have_text('沒有符合的紀錄')
    page.locator('#search').fill('')
    page.locator('#type-filter').select_option('')

    # Real downloads, including every month in JSON and just the current view in CSV.
    with page.expect_download() as result:
        page.locator('#backup-button').click()
    backup = json.loads(Path(result.value.path()).read_text())
    assert len(backup['records']) == 3
    with page.expect_download() as result:
        page.locator('#csv-button').click()
    csv = Path(result.value.path()).read_text(encoding='utf-8-sig')
    assert '午餐' in csv and '50000.00' in csv

    # Deletion requires confirmation and supports cancel; persistence survives reload.
    page.get_by_role('button', name='刪除 捷運', exact=True).click()
    page.locator('#confirm-cancel').click()
    expect(page.locator('#record-list tr')).to_have_count(3)
    page.get_by_role('button', name='刪除 捷運', exact=True).click()
    page.locator('#confirm-proceed').click()
    expect(page.locator('#record-list tr')).to_have_count(2)
    expect(page.locator('#expense')).to_have_text('NT$ 130.5')
    page.reload()
    select_month(page)
    expect(page.locator('#record-list tr')).to_have_count(2)

    # Import validates before confirmation, restores the backup, and does not duplicate.
    page.locator('#import-file').set_input_files({'name': 'backup.json', 'mimeType': 'application/json', 'buffer': json.dumps(backup).encode()})
    expect(page.locator('#confirm-dialog')).to_be_visible()
    page.locator('#confirm-proceed').click()
    expect(page.locator('#record-list tr')).to_have_count(3)
    page.locator('#import-file').set_input_files({'name': 'bad.json', 'mimeType': 'application/json', 'buffer': b'{broken'})
    expect(page.locator('#toast')).to_contain_text('不是有效的 JSON')
    expect(page.locator('#record-list tr')).to_have_count(3)

    # Render untrusted notes as plain text, including after persistence.
    add_record(page, '0.10', '餐飲', '<img src=x onerror=alert(1)>')
    assert page.locator('#record-list img').count() == 0
    expect(page.locator('#expense')).to_have_text('NT$ 210.6')
    page.locator('#month').fill('2026-01')
    page.locator('#month').dispatch_event('change')
    page.locator('#previous-month').click()
    expect(page.locator('#month')).to_have_value('2025-12')
    expect(page.locator('#expense')).to_have_text('NT$ 0')
    page.locator('#next-month').click()
    expect(page.locator('#month')).to_have_value('2026-01')
    page.locator('#month').fill('2026-10')
    page.locator('#month').dispatch_event('change')

    # Another tab updates the account, and existing pages receive the storage event.
    other = context.new_page()
    other.goto(BASE_URL)
    add_record(other, '1500', '居家', '日用品')
    expect(page.locator('#record-list tr')).to_have_count(5)
    other.close()

    # Failed writes do not pretend to succeed or overwrite the original account.
    before = page.evaluate('(key) => localStorage.getItem(key)', STORAGE_KEY)
    page.evaluate('''() => { window.originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function() { throw new DOMException('Full', 'QuotaExceededError'); }; }''')
    page.locator('#add-button').click()
    page.locator('#amount').fill('999')
    page.locator('#save-record').click()
    expect(page.locator('#form-error')).to_contain_text('儲存失敗')
    assert page.evaluate('(key) => localStorage.getItem(key)', STORAGE_KEY) == before
    page.locator('.close-dialog').first.click()
    page.evaluate('() => { Storage.prototype.setItem = window.originalSetItem; }')
    page.locator('#month').fill('2026-10')
    page.locator('#month').dispatch_event('change')
    page.screenshot(path='/tmp/little-ledger-desktop.png', full_page=True)

    # Small screens: document does not overflow and the form remains usable.
    for width in [390, 360]:
        page.set_viewport_size({'width': width, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'Overflow at {width}px'
        page.locator('#add-button').click()
        expect(page.locator('#amount')).to_be_focused()
        assert page.locator('#record-dialog').bounding_box()['width'] <= width
        page.keyboard.press('Escape')
        expect(page.locator('#record-dialog')).not_to_be_visible()
    page.screenshot(path='/tmp/little-ledger-mobile.png', full_page=True)

    # A corrupt existing account is preserved and never silently overwritten.
    isolated = browser.new_context()
    corrupt = isolated.new_page()
    corrupt.goto(BASE_URL)
    corrupt.evaluate('(key) => localStorage.setItem(key, "invalid-json")', STORAGE_KEY)
    corrupt.reload()
    expect(corrupt.locator('#storage-warning')).to_be_visible()
    corrupt.locator('#add-button').click()
    corrupt.locator('#amount').fill('10')
    corrupt.locator('#save-record').click()
    expect(corrupt.locator('#form-error')).to_contain_text('目前無法寫入')
    assert corrupt.evaluate('(key) => localStorage.getItem(key)', STORAGE_KEY) == 'invalid-json'
    isolated.close()
    assert not errors, errors
    print('PASS: CRUD, validation, monthly statistics, filters, reload persistence, JSON/CSV downloads, import, XSS-safe rendering, cross-tab sync, failed storage, responsive layout, keyboard dialog, corrupt-data protection.')
    browser.close()
