"""
tests/browser-check.py: drives the real page in Chromium (Playwright) and checks that it computes on input.
Run:  python3 tests/browser-check.py
It serves this folder on a free local port, opens index.html, edits the docket and Claude's output, switches
reader, date and record, refuses bad input, downloads the report, and fails on any console or page error.
Screenshots go to tests/screenshots/.
"""
import asyncio, functools, http.server, io, pathlib, socketserver, threading, zipfile
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'tests' / 'screenshots'
SHOTS.mkdir(exist_ok=True)
passed = failed = 0


def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS', name)
    else:
        failed += 1
        print('  FAIL', name, detail)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


async def until(pg, js, timeout=6000):
    """Polls a JS expression (the page's CSP-free, but this keeps waits explicit and cheap)."""
    for _ in range(timeout // 100):
        if await pg.evaluate(js):
            return True
        await pg.wait_for_timeout(100)
    return False

async def main():
    srv, port = serve()
    base = f'http://127.0.0.1:{port}/index.html'
    errors = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        ctx = await br.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        k = lambda key: pg.locator(f'.kpi[data-k={key}] b').inner_text()
        row = lambda eid: pg.locator(f'#dk .dkr[data-id="{eid}"]')

        async def edit(eid, field, value):
            inp = row(eid).locator(f'[data-f={field}]')
            await inp.fill(value)
            await inp.dispatch_event('change')

        async def json_edit(fn):
            await pg.click('.tabsx [data-v=json]')
            txt = await pg.input_value('#jsonTa')
            await pg.fill('#jsonTa', fn(txt))

        print('\n1. The studio loads on the small claims record')
        await pg.goto(base)
        await pg.wait_for_selector('#report .rep')
        ok('stage Mediation, next date November 20 in 24 days', await k('stage') == 'Mediation' and await k('next') == 'Nov 20 · 24d', await k('next'))
        ok('31 of 31 figures traced, reading grade 6.5, 8 of 8 checks', await k('traced') == '31/31' and await k('grade') == '6.5' and await k('checks') == '8/8')
        ok('Claude cost per report about 3 cents', (await k('cost')) in ('$0.032', '$0.033', '$0.034'), await k('cost'))
        ok('the user sees what happens next with countdowns', 'in 24 days' in await pg.inner_text('#report') and 'in 42 days' in await pg.inner_text('#report'))
        ok('and a glossary of the legal words used', await pg.locator('#report .gl').count() == 9)

        print('\n2. Changing the internal data changes the report')
        await edit('D9', 'text', 'NOTICE OF TRIAL SET 12/15/2026 13:30 CTRM 3B')
        ok('moving the trial to December 15 updates the report and its countdown (49 days)', 'December 15, 2026' in await pg.inner_text('#report') and 'in 49 days' in await pg.inner_text('#report'))
        ok('and it still passes every check', await k('checks') == '8/8')
        await edit('D8', 'date', '2026-10-32')
        ok('an impossible date is flagged on the row and listed, not silently used', 'bad' in (await row('D8').get_attribute('class')) and 'impossible date' in await pg.inner_text('#probs'))
        ok('the mediation deadline it carried drops out, so the trial is next', (await k('next')).startswith('Dec 15'))
        await edit('D8', 'date', '2026-10-21')
        await edit('D9', 'text', 'NOTICE OF TRIAL SET 12/08/2026 13:30 CTRM 3B')
        ok('putting both back restores November 20', await k('next') == 'Nov 20 · 24d')

        print('\n3. Adding a docket entry')
        await pg.click('#nAdd')
        ok('an entry with no text is refused with a reason', 'Type the entry text' in await pg.inner_text('#addErr'))
        await pg.fill('#nDate', '2026-11-03')
        await pg.fill('#nText', 'ORDER CONTINUING TRIAL')
        await pg.click('#nAdd')
        ok('an entry dated after the report date is refused', 'after the report date' in await pg.inner_text('#addErr'))
        await pg.fill('#nDate', '2026-10-26')
        await pg.select_option('#nCode', 'ORD CONT')
        await pg.fill('#nText', 'Order continuing trial set 01/12/2027 13:30 ctrm 3B')
        await pg.click('#nAdd')
        nexts = await pg.inner_text('#report .nexts')
        ok('a continuance order puts the trial on January 12, 2027', 'January 12, 2027' in nexts and await pg.locator('#dk .dkr').count() == 10)
        ok('and the old December 8 date is no longer shown as upcoming', 'December 8, 2026' not in nexts)
        await row('D10').locator('[data-del]').click()
        ok('removing the entry takes it back out', 'January 12, 2027' not in await pg.inner_text('#report') and await pg.locator('#dk .dkr').count() == 9)

        print("\n4. Editing Claude's output: the checks catch it")
        await json_edit(lambda t: t.replace('$4,850', '$5,000', 1))
        await pg.click('.tabsx [data-v=report]')
        ok('the user sees the blocked notice instead of the report', await pg.locator('#blockedBox').count() == 1 and '$5,000' in await pg.inner_text('#blockedBox'))
        ok('the checks drop to 7 of 8', await k('checks') == '7/8')
        await pg.click('.tabsx [data-v=json]')
        await pg.click('#resetJson')
        ok("'Back to the model's output' restores 8 of 8", await k('checks') == '8/8')
        await json_edit(lambda t: t.replace('Put November 20, 2026 on your calendar', 'You will win if you put November 20, 2026 on your calendar', 1))
        ok('"you will win" is blocked as legal advice', await pg.locator('#badges [data-check=advice].bad').count() == 1)
        await json_edit(lambda t: t.replace('"Courtroom 3B"', '"Courtroom 3B" "x"', 1))
        ok('broken JSON is refused with the parser error', 'Not valid JSON' in await pg.inner_text('#jsonErr'))
        await pg.click('#resetJson')

        print('\n5. Reader, report date and the probate record')
        await pg.select_option('#aud', 'staff')
        await pg.click('.tabsx [data-v=report]')
        ok('the staff version shows docket codes and drops the glossary', '[NTC TRL]' in await pg.inner_text('#report') and await pg.locator('#report .gl').count() == 0 and await k('checks') == '8/8')
        await pg.select_option('#aud', 'public')
        await pg.fill('#asOf', '2026-11-21')
        await pg.dispatch_event('#asOf', 'change')
        ok('on November 21 the deadline has passed: trial next in 17 days', await k('next') == 'Dec 8 · 17d')
        await pg.fill('#asOf', '2026-10-27')
        await pg.dispatch_event('#asOf', 'change')
        await pg.click('#recList [data-rec="1"]')
        ok('the probate record: stage Claims, no dates ahead, two problems listed', await k('stage') == 'Claims' and await k('next') == 'none' and await pg.locator('#probs div').count() == 2)
        await edit('P8', 'date', '2026-09-30')
        ok('fixing September 31 brings back the hearing on November 5 at 10:00 AM', await k('next') == 'Nov 5 · 9d' and 'Hearing on objection to claim' in await pg.inner_text('#report') and await pg.locator('#probs div').count() == 1)

        print('\n6. The request, downloads, reset')
        await pg.click('.tabsx [data-v=request]')
        code = await pg.inner_text('#code')
        ok('the request shown uses claude-opus-5-5, server-side fallback and a JSON schema', 'claude-opus-5-5' in code and 'server-side-fallback-2026-07-01' in code and 'json_schema' in code and 'temperature' not in code)
        ok('it carries the docket ids Claude must cite', '"id": "P8"' in code)
        async with pg.expect_download() as dl:
            await pg.click('#dlHtml')
        d = await dl.value
        html = pathlib.Path(await d.path()).read_text()
        ok('the report downloads as a standalone page', d.suggested_filename == 'report-2026-CP-001208.html' and 'Hearing on objection to claim' in html and '<style>' in html)
        await json_edit(lambda t: t.replace('$3,912.40', '$9,912.40', 1))
        await pg.click('#dlHtml')
        ok('a report that fails a check is not exported', 'Not exported' in await pg.inner_text('#toast'))
        await pg.click('#resetBtn')
        await pg.click('.tabsx [data-v=report]')
        ok('reset brings back the starting records', await k('stage') == 'Mediation' and await k('checks') == '8/8')
        await pg.locator('#tool').scroll_into_view_if_needed()
        await pg.screenshot(path=str(SHOTS / 'desktop-report.png'))
        await pg.click('.tabsx [data-v=request]')
        await pg.screenshot(path=str(SHOTS / 'desktop-request.png'))
        await pg.locator('#pricing').scroll_into_view_if_needed()
        await pg.screenshot(path=str(SHOTS / 'desktop-pricing.png'))

        print('\n7. Phone layout')
        mob = await br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pm = await mob.new_page()
        pm.on('pageerror', lambda e: errors.append(str(e)))
        await pm.goto(base)
        await pm.wait_for_selector('#report .rep')
        ok('no sideways scrolling at 390px wide', await pm.evaluate('document.documentElement.scrollWidth') <= 390, await pm.evaluate('document.documentElement.scrollWidth'))
        await pm.locator('#report').scroll_into_view_if_needed()
        await pm.screenshot(path=str(SHOTS / 'mobile.png'))

        ok('zero console or page errors', not errors, errors)
        await br.close()
    srv.shutdown()
    print(f'\n{passed + failed} browser checks: {passed} passed, {failed} failed')
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    asyncio.run(main())
