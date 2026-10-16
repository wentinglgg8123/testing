"""Run real account/sync workflows against a disposable backend and database."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = 'browser-test-correct-password'
KEY = 'little-ledger.v1'


def fill_record(page, amount, note, category='餐飲'):
    page.locator('#add-button').click()
    page.locator('#amount').fill(amount)
    page.locator('#note').fill(note)
    page.locator('#date').fill('2026-10-17')
    page.locator('#category').select_option(category)


def add_record(page, amount, note, category='餐飲'):
    fill_record(page, amount, note, category)
    page.locator('#save-record').click()
    expect(page.locator('#record-dialog')).not_to_be_visible()


def auth(page, username, register=False, password=PASSWORD):
    page.locator('#account-button').click()
    if register:
        page.locator('[data-auth="register"]').click()
    page.locator('#username').fill(username)
    page.locator('#password').fill(password)
    if register:
        page.locator('#confirm-password').fill(password)
    page.locator('#auth-submit').click()
    expect(page.locator('#auth-dialog')).not_to_be_visible()
    expect(page.locator('#account-label')).to_have_text(f'{username} 的帳本')


def refresh(page):
    page.locator('#refresh-button').click()
    expect(page.locator('#refresh-button')).to_be_enabled()
    expect(page.locator('#sync-status')).to_contain_text('已同步')


with tempfile.TemporaryDirectory(prefix='ledger-browser-') as directory:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    environment = {**os.environ, 'PORT': str(port), 'LEDGER_DATA_DIR': directory, 'LEDGER_ORIGIN': base, 'NODE_ENV': 'test'}
    process = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=environment, stdout=subprocess.DEVNULL)
    try:
        for attempt in range(100):
            try:
                with urlopen(f'{base}/health', timeout=1) as response:
                    assert response.status == 200
                    break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError('Backend exited before readiness')
                time.sleep(.1)
        else:
            raise RuntimeError('Backend did not start')
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('LEDGER_CHROMIUM', '/usr/bin/chromium'), headless=True)
            desktop = browser.new_context(viewport={'width': 1440, 'height': 1050}, timezone_id='Asia/Taipei')
            phone = browser.new_context(viewport={'width': 390, 'height': 844}, timezone_id='Asia/Taipei')
            stranger = browser.new_context(viewport={'width': 1280, 'height': 900})
            a, b, c = desktop.new_page(), phone.new_page(), stranger.new_page()
            errors = []
            for page in [a, b, c]:
                page.on('pageerror', lambda error: errors.append(str(error)))
                assert page.goto(base).status == 200
            suffix = uuid4().hex[:8]
            alice, bob = f'alice_{suffix}', f'bob_{suffix}'

            # Existing guest data is never uploaded until explicitly confirmed.
            add_record(a, '120.50', '本機午餐')
            original_local = a.evaluate('(key) => localStorage.getItem(key)', KEY)
            auth(a, alice, register=True)
            expect(a.locator('#record-list tr')).to_have_count(0)
            expect(a.locator('#migrate-button')).to_be_visible()
            a.locator('#migrate-button').click()
            a.locator('#confirm-proceed').click()
            expect(a.locator('#record-list tr')).to_have_count(1)
            expect(a.locator('#migrate-button')).not_to_be_visible()
            assert a.evaluate('(key) => localStorage.getItem(key)', KEY) == original_local
            assert PASSWORD not in a.evaluate('JSON.stringify(localStorage)')
            assert 'ledger_session' not in a.evaluate('document.cookie')

            # A separate browser context acts as a second device with no local data.
            auth(b, alice)
            expect(b.locator('#record-list tr')).to_have_count(1)
            add_record(b, '250', '手機交通', '交通')
            refresh(a)
            expect(a.locator('#expense')).to_have_text('NT$ 370.5')
            a.get_by_role('button', name='編輯 本機午餐', exact=True).click()
            a.locator('#amount').fill('200')
            a.locator('#save-record').click()
            expect(a.locator('#record-dialog')).not_to_be_visible()
            refresh(b)
            expect(b.locator('#expense')).to_have_text('NT$ 450')

            # A stale editor is rejected; new remote data and local form input survive.
            fill_record(b, '65', '手機咖啡')
            add_record(a, '80', '電腦早餐')
            b.locator('#save-record').click()
            expect(b.locator('#form-error')).to_contain_text('另一個裝置已更新')
            expect(b.locator('#note')).to_have_value('手機咖啡')
            b.locator('#save-record').click()
            expect(b.locator('#record-dialog')).not_to_be_visible()
            refresh(a)
            expect(a.locator('#record-list tr')).to_have_count(4)
            expect(a.locator('#expense')).to_have_text('NT$ 595')

            # Delete on the phone, then observe deletion and persistence on the desktop.
            b.get_by_role('button', name='刪除 手機交通', exact=True).click()
            b.locator('#confirm-proceed').click()
            expect(b.locator('#confirm-dialog')).not_to_be_visible()
            refresh(a)
            expect(a.locator('#record-list tr')).to_have_count(3)
            a.reload()
            expect(a.locator('#account-label')).to_have_text(f'{alice} 的帳本')
            a.locator('#month').fill('2026-10')
            a.locator('#month').dispatch_event('change')
            expect(a.locator('#expense')).to_have_text('NT$ 345')

            # Network failures leave the form open and do not claim a successful save.
            b.route('**/api/ledger', lambda route: route.abort())
            fill_record(b, '999', '不應寫入')
            b.locator('#save-record').click()
            expect(b.locator('#form-error')).to_contain_text('無法連線')
            expect(b.locator('#cloud-warning')).to_be_visible()
            b.locator('.close-dialog').first.click()
            b.unroute('**/api/ledger')
            refresh(b)
            expect(b.locator('#record-list tr')).to_have_count(3)

            # Another person's account starts empty and remains separate.
            auth(c, bob, register=True)
            expect(c.locator('#record-list tr')).to_have_count(0)
            add_record(c, '888', '另一個人的帳本')
            refresh(a)
            expect(a.locator('#record-list')).not_to_contain_text('另一個人的帳本')

            # Logout restores the untouched guest ledger. A wrong password fails.
            a.locator('#logout-button').click()
            expect(a.locator('#account-label')).to_have_text('本機帳本')
            expect(a.locator('#expense')).to_have_text('NT$ 120.5')
            a.locator('#account-button').click()
            a.locator('#username').fill(alice)
            a.locator('#password').fill('wrong-password')
            a.locator('#auth-submit').click()
            expect(a.locator('#auth-error')).to_contain_text('帳號或密碼不正確')
            a.locator('#password').fill(PASSWORD)
            a.locator('#auth-submit').click()
            expect(a.locator('#auth-dialog')).not_to_be_visible()
            expect(a.locator('#expense')).to_have_text('NT$ 345')

            # A same-browser tab switching accounts cannot make an old form write to it.
            fill_record(a, '111', '舊分頁不可跨帳號寫入')
            other_tab = desktop.new_page()
            other_tab.goto(base)
            expect(other_tab.locator('#logout-button')).to_be_visible()
            other_tab.locator('#logout-button').click()
            expect(other_tab.locator('#account-label')).to_have_text('本機帳本')
            auth(other_tab, bob)
            a.locator('#save-record').click()
            expect(a.locator('#form-error')).to_contain_text('帳號已在其他分頁變更')
            expect(a.locator('#sync-status')).to_have_text('需要重新登入')
            refresh(c)
            expect(c.locator('#record-list tr')).to_have_count(1)
            expect(c.locator('#expense')).to_have_text('NT$ 888')
            a.locator('.close-dialog').first.click()
            auth(a, alice)
            expect(a.locator('#expense')).to_have_text('NT$ 345')
            other_tab.close()

            # Expired sessions are read-only until the user signs back in.
            phone.clear_cookies()
            b.locator('#refresh-button').click()
            expect(b.locator('#sync-status')).to_have_text('需要重新登入')
            fill_record(b, '22', '登入過期不可寫入')
            b.locator('#save-record').click()
            expect(b.locator('#form-error')).to_contain_text('重新登入')
            b.locator('.close-dialog').first.click()
            auth(b, alice)

            # Cloud JSON backup restore synchronizes destructive changes to other devices.
            backup = {'version': 1, 'records': [{'id': 'restored', 'type': 'income', 'category': '薪資', 'amount': 6000000, 'date': '2026-10-17', 'note': '還原收入'}]}
            b.locator('#import-file').set_input_files({'name': 'restore.json', 'mimeType': 'application/json', 'buffer': json.dumps(backup).encode()})
            expect(b.locator('#confirm-description')).to_contain_text('目前帳號所有裝置')
            b.locator('#confirm-proceed').click()
            expect(b.locator('#confirm-dialog')).not_to_be_visible()
            refresh(a)
            expect(a.locator('#record-list tr')).to_have_count(1)
            expect(a.locator('#income')).to_have_text('NT$ 60,000')
            refresh(c)
            expect(c.locator('#expense')).to_have_text('NT$ 888')
            for page in [a, b]:
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            a.screenshot(path='/tmp/little-ledger-account-desktop.png', full_page=True)
            b.screenshot(path='/tmp/little-ledger-account-mobile.png', full_page=True)
            assert not errors, errors
            browser.close()
            print('PASS: registration/login, explicit guest migration, cross-device CRUD, revision conflicts, reload persistence, account isolation, logout, network failure, shared-cookie account changes, expired sessions, cloud backup restore, mobile layout.')
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
