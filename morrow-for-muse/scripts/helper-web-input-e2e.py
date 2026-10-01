"""Rendered shipped helper against a disposable ordered-input protocol fixture."""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import struct
import sys
import tempfile
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TREE = Path(__file__).resolve().parents[1]
OUT, BINARY = Path(sys.argv[1]), sys.argv[2]
report = {'test': 'morrow.helper-web-input.rendered.v1', 'scope': 'disposable protocol fixture only', 'checks': {}}
state = {'epoch': 'a' * 32, 'fault': '', 'calls': [], 'effects': [], 'streams': {}, 'delay': 0}
lock = threading.Lock()

def check(name, value):
    report['checks'][name] = bool(value)
    assert value, name

def png():
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    pixels = b''.join(b'\0' + b'\xf4\xf6\xff' * 1200 for _ in range(800))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 1200, 800, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')
IMAGE = png()

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def answer(self, code, body, content='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', content)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path in ('/screenshot', '/page/layout') and self.headers.get('X-Helper-Token') != 'fixture-only-token':
            self.answer(403, {'error': 'forbidden'})
            return
        if self.path == '/':
            self.answer(200, (TREE / 'helper/index.html').read_bytes().replace(b'__HELPER_TOKEN__', b'fixture-only-token'), 'text/html')
        elif self.path == '/logo.png':
            self.answer(200, (TREE / 'helper/logo.png').read_bytes(), 'image/png')
        elif self.path == '/status':
            self.answer(200, {'ok': True, 'input_epoch': state['epoch'], 'logged_in': False, 'chromium_alive': True, 'url': 'https://fixture.example/login'})
        elif self.path == '/screenshot':
            self.answer(200, IMAGE, 'image/png')
        elif self.path == '/page/layout':
            self.answer(200, {'ok': True, 'input_epoch': state['epoch'], 'viewport': {'width': 1200, 'height': 800}, 'fields': [{'x': 760, 'y': 260, 'width': 260, 'height': 42}], 'actions': [{'x': 760, 'y': 330, 'width': 140, 'height': 42}], 'frames': []})
        else:
            self.answer(404, {})
    def do_POST(self):
        if self.headers.get('X-Helper-Token') != 'fixture-only-token':
            self.answer(403, {'error': 'forbidden'})
            return
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        with lock:
            state['calls'].append((self.path, payload))
        if self.path == '/input/batch':
            if state['delay']:
                time.sleep(state['delay'])
            fault = state['fault']
            if fault in ('conflict', 'capacity', 'rate_limit', 'unsupported'):
                self.answer({'conflict': 409, 'capacity': 429, 'rate_limit': 429, 'unsupported': 404}[fault], {'error': 'input session capacity reached; restart helper' if fault == 'capacity' else 'rate limit exceeded' if fault == 'rate_limit' else fault})
                return
            stream = payload.get('stream_id')
            previous = state['streams'].get(stream)
            digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            if previous == (payload.get('sequence'), digest):
                replayed = True
            else:
                if payload.get('epoch') != state['epoch'] or payload.get('sequence') != (previous[0] + 1 if previous else 1):
                    self.answer(409, {'error': 'order'})
                    return
                state['effects'].extend(payload['operations'])
                state['streams'][stream] = (payload['sequence'], digest)
                replayed = False
            if fault == 'lost_reply':
                state['fault'] = ''
                self.close_connection = True
                return
            self.answer(200, {'ok': True, 'sequence': payload['sequence'], 'replayed': replayed})
        else:
            state['effects'].append({'type': self.path})
            self.answer(200, {'ok': True})

launcher = fixture = None
try:
    with tempfile.TemporaryDirectory(prefix='morrow-web-input-e2e-') as scratch:
        os.environ.update(MORROW_HOME=scratch + '/state', MORROW_HELPER_ENV_FILE=scratch + '/empty-env', LOGIN_HELPER_OWN_BROWSER='1')
        Path(scratch + '/empty-env').write_text('# disposable\n')
        sys.path.insert(0, str(TREE))
        from transport.local_chromium import ChromiumLauncher
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        launcher = ChromiumLauncher(BINARY, scratch + '/profile', cdp_port=port, forwarder_port=22670, extra_args=['--disable-features=LocalNetworkAccessChecks', '--ignore-certificate-errors'])
        launcher.start()
        cdp = launcher.cdp
        fixture = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        cert, keyfile = scratch + '/cert.pem', scratch + '/key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyfile, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, keyfile)
        fixture.socket = tls.wrap_socket(fixture.socket, server_side=True)
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
        tab = cdp.new_tab('about:blank')
        cdp.navigate(tab, 'https://127.0.0.1:%d/' % fixture.server_port)
        def evaluate(expression):
            return cdp.evaluate(tab, expression)
        def wait_for(expression, seconds=8):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if evaluate(expression):
                    return True
                time.sleep(.05)
            return False
        check('first_frame_rendered', wait_for('document.getElementById("screen").naturalWidth === 1200'))
        check('ordered_input_controls_present', evaluate('!!document.getElementById("resume") && !!document.getElementById("fit") && !!document.getElementById("zoom-in")'))
        def focus():
            evaluate('document.getElementById("capture").click()')
        def text(value):
            cdp.call(tab, 'Input.insertText', {'text': value})
        def key(name, code, number, modifiers=0):
            cdp.call(tab, 'Input.dispatchKeyEvent', {'type': 'keyDown', 'key': name, 'code': code, 'windowsVirtualKeyCode': number, 'modifiers': modifiers})
            cdp.call(tab, 'Input.dispatchKeyEvent', {'type': 'keyUp', 'key': name, 'code': code, 'windowsVirtualKeyCode': number, 'modifiers': modifiers})
        def idle():
            check('queue_drained_' + str(len(report['checks'])), wait_for('document.getElementById("input-status").dataset.state === "ready"'))
        focus()
        text('dummy café 🧪')
        key('Tab', 'Tab', 9)
        text('second')
        idle()
        operations = list(state['effects'])
        check('unicode_and_control_order', ''.join(op.get('text', '') for op in operations[:1]) == 'dummy café 🧪' and operations[1].get('key') == 'Tab' and operations[2].get('text') == 'second')
        check('no_legacy_key_endpoint', all(path != '/input/key' for path, _ in state['calls']))
        before = len(state['effects'])
        evaluate('(() => { const el=document.getElementById("keyboard"); el.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})); el.value="試験"; el.dispatchEvent(new InputEvent("input",{bubbles:true,isComposing:true})); })()')
        time.sleep(.15)
        check('composition_not_sent_before_commit', len(state['effects']) == before)
        evaluate('document.getElementById("keyboard").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"試験"}))')
        idle()
        check('composition_sent_once', state['effects'][-1].get('text') == '試験' and len(state['effects']) == before + 1)
        evaluate('(() => { const data=new DataTransfer(); data.setData("text/plain","paste fixture"); document.getElementById("keyboard").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data})); })()')
        idle()
        check('paste_sent_once', state['effects'][-1].get('text') == 'paste fixture')
        state['delay'] = .2
        text('a')
        text('b')
        text('c')
        key('Enter', 'Enter', 13)
        text('d')
        idle()
        state['delay'] = 0
        last = state['effects'][-4:]
        check('rapid_text_coalesces_before_barrier', last[0].get('text') == 'a' and last[1].get('text') == 'bc' and last[2].get('key') == 'Enter' and last[3].get('text') == 'd')
        evaluate('document.getElementById("fit").click()')
        scale_full = evaluate('parseInt(document.getElementById("zoom-level").textContent,10)')
        evaluate('document.getElementById("fit-fields").click()')
        check('different_field_position_fits', evaluate('parseInt(document.getElementById("zoom-level").textContent,10)') > scale_full)
        evaluate('document.getElementById("zoom-in").click()')
        zoomed = evaluate('document.getElementById("zoom-level").textContent')
        time.sleep(.7)
        check('manual_zoom_survives_frame_refresh', evaluate('document.getElementById("zoom-level").textContent') == zoomed)
        before = len(state['effects'])
        evaluate('(() => { const el=document.getElementById("stage"),r=el.getBoundingClientRect(),o={bubbles:true,pointerType:"touch",pointerId:21,isPrimary:true,clientX:r.left+100,clientY:r.top+100}; el.setPointerCapture=()=>{}; el.dispatchEvent(new PointerEvent("pointerdown",o)); el.dispatchEvent(new PointerEvent("pointermove",{...o,clientY:o.clientY-40})); el.dispatchEvent(new PointerEvent("pointerup",{...o,clientY:o.clientY-40})); })()')
        idle()
        check('touch_drag_scrolls_without_click', len(state['effects']) == before + 1 and state['effects'][-1]['type'] == '/input/wheel')
        focus()
        state['fault'] = 'lost_reply'
        before = len(state['effects'])
        text('retry')
        idle()
        check('lost_ack_exactly_once', len(state['effects']) == before + 1)
        batches = [body for path, body in state['calls'] if path == '/input/batch']
        check('lost_ack_retry_body_immutable', batches[-1] == batches[-2])
        state['fault'] = 'conflict'
        text('refused')
        check('conflict_blocks_input', wait_for('!document.getElementById("resume").hidden'))
        before = len(state['calls'])
        text('discarded')
        time.sleep(.3)
        check('blocked_input_not_sent', len(state['calls']) == before)
        state['fault'] = ''
        evaluate('document.getElementById("resume").click()')
        idle()
        focus()
        text('fresh')
        idle()
        check('resume_never_replays', state['effects'][-1].get('text') == 'fresh' and not any(op.get('text') in ('refused', 'discarded') for op in state['effects']))
        state['fault'] = 'rate_limit'
        text('rate limit')
        check('rate_limit_pauses_without_restart', wait_for('!document.getElementById("resume").hidden') and not evaluate('document.getElementById("resume").disabled'))
        state['fault'] = ''
        evaluate('document.getElementById("resume").click()')
        idle()
        focus()
        state['fault'] = 'capacity'
        text('capacity')
        check('capacity_requires_restart', wait_for('document.getElementById("input-status").textContent.includes("restart")'))
        check('capacity_cannot_resume_same_epoch', evaluate('document.getElementById("resume").disabled'))
        state['fault'] = ''
        state['epoch'] = 'b' * 32
        check('new_epoch_requires_explicit_resume', wait_for('!document.getElementById("resume").disabled'))
        evaluate('document.getElementById("resume").click()')
        idle()
        focus()
        state['fault'] = 'unsupported'
        text('unsupported')
        check('unsupported_backend_has_no_fallback', wait_for('document.getElementById("input-status").textContent.includes("update")') and all(path != '/input/key' for path, _ in state['calls']))
        for width in (1280, 390):
            cdp.call(tab, 'Emulation.setDeviceMetricsOverride', {'width': width, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False})
            time.sleep(.2)
            check('no_horizontal_overflow_' + str(width), evaluate('document.documentElement.scrollWidth <= innerWidth'))
            frame = cdp.call(tab, 'Page.captureScreenshot', {'format': 'png'})
            OUT.with_name(OUT.stem + '-' + str(width) + '.png').write_bytes(base64.b64decode(frame['data']))
        report['source_sha256'] = hashlib.sha256((TREE / 'helper/index.html').read_bytes()).hexdigest()
        report['passed'] = True
finally:
    if fixture:
        fixture.shutdown()
        fixture.server_close()
    if launcher:
        launcher.stop()
    report.setdefault('passed', False)
    OUT.write_text(json.dumps(report, indent=2) + '\n')
