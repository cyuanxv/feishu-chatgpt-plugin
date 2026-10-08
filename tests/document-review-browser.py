"""Synthetic browser checks against the production review HTML/JS + HTTP handlers.
The test-only bridge does not validate production HTTPS or __Host cookie delivery.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
output = root / 'browser-evidence'
output.mkdir(exist_ok=True)
# No operator environment or credentials are inherited by the fixture.
env = {'PATH': os.environ.get('PATH', ''), 'FEISHU_SYNTHETIC_REVIEW_BROWSER': '1'}
server = subprocess.Popen(['node', '--import', 'tsx', 'tests/helpers/document-review-browser-fixture.ts'], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
base = 'http://127.0.0.1:4179'

def evidence():
    with urllib.request.urlopen(base + '/fixture/evidence', timeout=3) as response:
        return json.load(response)

try:
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError(server.stdout.read().decode())
        try:
            evidence()
            break
        except OSError:
            time.sleep(0.1)
    else:
        raise RuntimeError('Synthetic fixture did not start')
    with sync_playwright() as p:
        # Mandatory: do not change this to --no-sandbox when an environment cannot launch.
        browser = p.chromium.launch(headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 960})
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base + '/') else route.abort())
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base + '/fixture')
        confirm = page.get_by_role('button', name='确认创建文档', exact=True)
        cancel = page.get_by_role('button', name='取消并关闭预览', exact=True)
        expect(confirm).to_be_enabled()
        expect(page.locator('#document-title')).to_have_text('团队周计划 · 创建前预览')
        expect(page.locator('#document-body')).to_contain_text('整理测试结果')
        expect(page.get_by_text('ou_synthetic', exact=True)).to_be_visible()
        expect(page.get_by_text('fld_fixture', exact=True)).to_be_visible()
        assert evidence()['synthetic_provider_calls'] == 0
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(output / 'document-review-desktop.png'), full_page=True)
        # Repeated clicks are intentionally sent to the DOM; the real client listener must fence them.
        confirm.evaluate('(button) => { button.click(); button.click(); }')
        expect(page.locator('#status')).to_contain_text('成功回执')
        expect(confirm).to_be_disabled()
        expect(page.locator('#document-link')).to_be_visible()
        assert evidence()['synthetic_provider_calls'] == 1
        page.goto(base + '/document-review')
        page.reload()
        expect(page.get_by_role('heading', name='预览尚未就绪')).to_be_visible()
        assert page.get_by_role('button', name='确认创建文档', exact=True).count() == 0
        assert evidence()['synthetic_provider_calls'] == 1
        page.goto(base + '/fixture')
        expect(confirm).to_be_enabled()
        cancel.click()
        expect(page.locator('#status')).to_contain_text('已取消')
        expect(confirm).to_be_disabled()
        assert evidence()['synthetic_provider_calls'] == 1
        page.goto(base + '/fixture')
        expect(confirm).to_be_enabled()
        page.goto(base + '/document-review')
        page.go_back()
        # GET restores only the unavailable page; BFCache restore must perform fresh status validation.
        # The synthetic /fixture URL can regenerate a new preview on a history reload, so use the
        # production reload assertion above and deterministic BFCache regression in the JS suite.
        assert evidence()['synthetic_provider_calls'] == 1
        page.set_viewport_size({'width': 390, 'height': 844})
        page.goto(base + '/fixture')
        expect(confirm).to_be_enabled()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert page.locator('#document-body').inner_text().endswith('此测试只返回模拟回执。')
        page.screenshot(path=str(output / 'document-review-mobile.png'), full_page=True)
        cancel.click()
        expect(page.locator('#status')).to_contain_text('已取消')
        assert evidence()['synthetic_provider_calls'] == 1
        assert errors == [], errors
        print(json.dumps({'browser': browser.version, 'chromium_sandbox': True, 'synthetic_provider_calls': 1, 'real_provider_calls': 0, 'checks': ['full preview', 'verified account/folder', 'single create on repeated click', 'receipt', 'reload inert', 'cancel', 'navigation without create', 'mobile no overflow', 'no page errors']}, ensure_ascii=False))
        browser.close()
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
