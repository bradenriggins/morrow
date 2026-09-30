"""Real HTTP -> packaged helper -> private CDP -> disposable Chromium E2E.

Usage: python3 scripts/helper-input-e2e.py TREE RECEIPT.json
Use the installed VM Chromium, or set CHROMIUM_BIN to Chrome for Testing.
This source-only driver needs no live tenant or credentials.
All text is generated dummy data. Real sign-in profile and ports are untouched.
"""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

TREE = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
scratch = tempfile.TemporaryDirectory(prefix='morrow-input-e2e-')
root = Path(scratch.name)
empty = root / 'empty-env'
empty.write_text('# isolated QA\n')
with socket.socket() as socket_probe:
    socket_probe.bind(('127.0.0.1', 0))
    port = socket_probe.getsockname()[1]
for name in ('MORROW_HOME', 'MORROW_TREE_STATE_DIR', 'MORROW_USER_ID',
             'MORROW_CONVERSATION_ID', 'LOGIN_HELPER_PRODUCTION'):
    os.environ.pop(name, None)
os.environ.update(HOME=str(root), MORROW_HOME=str(root / 'state'),
    MORROW_HELPER_ENV_FILE=str(empty), LOGIN_HELPER_PROFILE_DIR=str(root / 'profile'),
    LOGIN_HELPER_PORT=str(port), LOGIN_HELPER_CDP_PORT='19226',
    HELPER_AUTH_TOKEN='a'*64, CANVAS_BASE='https://chcp.instructure.com')
for path in (TREE, TREE / 'helper', TREE / 'transport'):
    sys.path.insert(0, str(path))
spec = importlib.util.spec_from_file_location('input_e2e_server', TREE / 'helper/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
browser = None
http = None
report = {'test': 'isolated-real-Chromium-input-batch', 'checks': {}, 'timings_ms': []}

def check(name, condition):
    report['checks'][name] = bool(condition)
    if not condition:
        raise AssertionError(name)

try:
    browser = server.HelperBrowser()
    browser.launcher.start()
    browser.cdp = browser.launcher.cdp
    html = '''<!doctype html><meta charset="utf-8"><style>body{font:20px sans-serif}input{font:inherit}</style><input id="one"><input id="two"><script>window.events=0;window.shiftHeld=false;document.addEventListener('keydown',e=>{if(e.key==='Shift')window.shiftHeld=true});document.addEventListener('keyup',e=>{if(e.key==='Shift')window.shiftHeld=false});document.addEventListener('input',()=>window.events++);document.querySelector('#one').focus();</script>'''
    browser.tab = browser.cdp.new_tab('about:blank')
    frame = browser.cdp.call(browser.tab, 'Page.getFrameTree', {}, timeout=10)['frameTree']['frame']['id']
    browser.cdp.call(browser.tab, 'Page.setDocumentContent', {'frameId': frame, 'html': html}, timeout=10)
    browser.base_url = 'https://chcp.instructure.com/'
    browser._cookie_expiry_read_ok = True
    server.BROWSER = browser
    http = server.BoundedThreadingHTTPServer(('127.0.0.1', port), server.Handler)
    threading.Thread(target=http.serve_forever, daemon=True).start()
    epoch = server.INPUT_BATCHES.epoch
    stream = '1' * 32
    def request(body, token=True):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Helper-Token'] = 'a' * 64
        req = urllib.request.Request(f'http://127.0.0.1:{port}/input/batch',
               data=json.dumps(body).encode(), headers=headers, method='POST')
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                data = json.loads(response.read())
                code = response.status
        except urllib.error.HTTPError as error:
            code, data = error.code, json.loads(error.read())
        report['timings_ms'].append(round((time.monotonic()-started)*1000, 2))
        return code, data
    def payload(sequence, operations):
        return {'epoch': epoch, 'stream_id': stream, 'sequence': sequence, 'operations': operations}
    def state():
        raw = browser.cdp.evaluate(browser.tab, "JSON.stringify({one:document.querySelector('#one').value,two:document.querySelector('#two').value,events:window.events,active:document.activeElement.id})")
        return json.loads(raw)
    text = 'dummy-é漢字-🙂'
    first = payload(1, [{'type':'text','text':text}])
    check('unauthenticated-input-refused', request(first, False)[0] == 403)
    check('unauthenticated-input-no-effect', state()['one'] == '')
    check('unicode-paste-single-ack', request(first)[0] == 200)
    check('unicode-paste-saved-in-browser', state()['one'] == text)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        answers = list(pool.map(lambda _:request(first), range(4)))
    check('concurrent-identical-retry-ack-only', all(code == 200 and body.get('replayed') for code, body in answers))
    check('retry-does-not-type-twice', state()['one'] == text and state()['events'] == 1)
    second = payload(2, [{'type':'key','key':'Tab','code':'Tab','keyCode':9,'modifiers':0}, {'type':'text','text':'second-dummy'}, {'type':'key','key':'Backspace','code':'Backspace','keyCode':8,'modifiers':0}])
    check('control-key-batch-ack', request(second)[0] == 200)
    check('tab-focus-and-backspace-order', state()['one'] == text and state()['two'] == 'second-dumm')
    before = state()
    invalid = payload(3, [{'type':'text','text':'must-not-land'}, {'type':'evaluate','expression':'bad'}])
    check('invalid-later-operation-refused-before-any-input', request(invalid)[0] == 400 and state() == before)
    changed = payload(2, [{'type':'text','text':'must-not-land'}])
    check('sequence-conflict-no-effect', request(changed)[0] == 409 and state() == before)
    stale = payload(3, [{'type':'text','text':'must-not-land'}]); stale['epoch']='0'*32
    check('restart-epoch-no-effect', request(stale)[0] == 409 and state() == before)
    third = payload(3, [{'type':'key','key':'a','code':'KeyA','keyCode':65,'modifiers':2}, {'type':'text','text':'replacement'}])
    check('selection-and-replacement', request(third)[0] == 200 and state()['two'] == 'replacement')
    original_call = browser.cdp.call
    injected = [False]
    def fail_after_real_keydown(tab, method, params, timeout=10):
        result = original_call(tab, method, params, timeout=timeout)
        if (method == 'Input.dispatchKeyEvent' and params.get('key') == 'Shift'
                and params.get('type') == 'keyDown' and not injected[0]):
            injected[0] = True
            raise TimeoutError('injected lost acknowledgement after real dummy keydown')
        return result
    browser.cdp.call = fail_after_real_keydown
    partial = payload(4, [{'type':'key','key':'Shift','code':'ShiftLeft','keyCode':16,'modifiers':8}])
    check('partial-key-ack-fault-refuses', request(partial)[0] == 409 and injected[0])
    check('partial-key-fault-releases-modifier', browser.cdp.evaluate(browser.tab, 'window.shiftHeld') is False)
    browser.cdp.call = original_call
    check('partial-stream-blocked-on-retry', request(partial)[0] == 409)
    def layout(auth=True, query=''):
        headers = {'X-Helper-Token':'a'*64} if auth else {}
        req = urllib.request.Request(f'http://127.0.0.1:{port}/page/layout{query}', headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())
    check('layout-auth-required', layout(False)[0] == 403)
    check('layout-query-refused', layout(query='?target=other')[0] == 400)
    for name, x, y in [('left',80,200), ('right',1080,200), ('top',500,40), ('bottom',500,650)]:
        fixture = f"""<style>input,button{{position:absolute;width:300px;height:36px;box-sizing:border-box}}</style><input style="left:{x}px;top:{y}px" value="dummy-private-not-returned"><input type="password" style="left:{x}px;top:{y+70}px"><button style="left:{x}px;top:{y+140}px">dummy-label-not-returned</button><input style="display:none"><input disabled>"""
        browser.cdp.call(browser.tab, 'Page.setDocumentContent', {'frameId':frame,'html':fixture})
        code, data = layout()
        check('layout-'+name+'-fields', code == 200 and len(data.get('fields',[])) == 2 and len(data.get('actions',[])) == 1)
        check('layout-'+name+'-geometry', abs(data['fields'][0]['x']-x)<1 and abs(data['fields'][0]['y']-y)<1)
        check('layout-'+name+'-no-content', 'dummy-private' not in json.dumps(data) and 'dummy-label' not in json.dumps(data) and all(set(r)=={'x','y','width','height'} for r in data['fields']))
    for opaque in (False, True):
        fixture = '<iframe '+('sandbox ' if opaque else '')+'style="position:absolute;left:180px;top:160px;width:400px;height:300px" srcdoc=\'<input style="position:absolute;left:20px;top:30px">\'></iframe>'
        browser.cdp.call(browser.tab, 'Page.setDocumentContent', {'frameId':frame,'html':fixture})
        time.sleep(0.2)
        code, data = layout()
        check('layout-opaque-frame' if opaque else 'layout-same-origin-frame', code == 200 and len(data['frames'])==1 and len(data['fields'])==(0 if opaque else 1))
        if not opaque:
            check('layout-frame-offset', abs(data['fields'][0]['x']-202)<2 and abs(data['fields'][0]['y']-192)<2)
    browser.cdp.call(browser.tab, 'Page.setDocumentContent', {'frameId':frame,'html':'<style>input{width:5px;height:5px}</style>'+'<input>'*100})
    code, data = layout()
    check('layout-bounded-results', code == 200 and len(data['fields']) == 32 and len(data['actions']) <= 32 and len(data['frames']) <= 16 and data['input_epoch'] == epoch)
    check('primary-profile-is-disposable', str(root / 'profile') == str(server.PROFILE_DIR) and str(TREE / 'helper/profile') != str(server.PROFILE_DIR))
    png = browser.screenshot()
    check('real-current-frame-png', png.startswith(b'\x89PNG\r\n\x1a\n'))
    OUT.with_suffix('.png').write_bytes(png)
    report['passed'] = True
finally:
    if http:
        http.shutdown(); http.server_close()
    if browser:
        browser.stop()
    OUT.write_text(json.dumps(report, indent=2) + '\n')
    scratch.cleanup()
print(json.dumps(report, indent=2))
