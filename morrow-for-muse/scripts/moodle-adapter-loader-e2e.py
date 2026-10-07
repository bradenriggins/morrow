"""Real helper proxy and disposable Chromium; trusted adapter staging only."""
import hashlib
import base64
from datetime import datetime, timezone
import importlib.util
import json
import os
import random
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TREE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TREE))
OUT, BINARY, ASSETS = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]).resolve()
PUBLIC_STAGING = "--public-staging-only" in sys.argv[4:]
GOVERNED = "--governed-execution" in sys.argv[4:]
LEGACY_GOVERNED = "--legacy-governed" in sys.argv[4:]
RESTART_PROOF = "--process-restart-proof" in sys.argv[4:]
PREFLIGHT_PROOF = "--preflight-proof" in sys.argv[4:]
LABEL_PROOF = "--learner-approval-proof" in sys.argv[4:]
CLI_PROOF = "--public-cli-proof" in sys.argv[4:]
FILES_PROOF = "--private-file-proof" in sys.argv[4:]
ACCOUNT_COURSE_PROOF = "--account-course-proof" in sys.argv[4:]
COURSE_DISCOVERY_PRIVACY_PROOF = "--course-discovery-privacy-proof" in sys.argv[4:]
COURSE_NAME_PROOF = "--masked-course-plan-proof" in sys.argv[4:]
SITE_NORMALIZATION_PROOF = "--site-normalization-proof" in sys.argv[4:]
HELPER_PROVIDER_PROOF = "--moodle-helper-provider-proof" in sys.argv[4:] or SITE_NORMALIZATION_PROOF
if CLI_PROOF:
    sys.path.remove(str(TREE))
    TREE = Path(os.environ['MORROW_CLI_TEST_TREE']).resolve()
    sys.path.insert(0, str(TREE))
report = {"scope": "public-page adapter staging only" if PUBLIC_STAGING else "private fixture staging and provider read", "test": "morrow.moodle-adapter-loader.real-helper.v1", "checks": {}, "provider_calls": 0}
fixture_mode = 'modern'
effect_mode = 'normal'
effects = 0
file_drafts = {}
file_created = {}
file_next_draft = 100
file_uploads = 0
file_saves = 0
file_upload_mode = 'normal'
section_name = 'Welcome'
course_name = 'Fixture course'
learner_row = {'id': 17, 'name': 'Aster Sample', 'email': 'aster@example.test'}
provider_state = {'course': {'id': 2, 'fullname': 'Fixture course'},
                  'section': [{'id': 10, 'number': 0, 'visible': True, 'hasrestrictions': False, 'component': None, 'cmlist': [19]}],
                  'cm': [{'id': 19, 'name': 'Essay by Aster Sample', 'module': 'page', 'sectionid': 10,
                          'visible': True, 'accessvisible': True, 'hascmrestrictions': False,
                          'allowstealth': True, 'stealth': False}]}

def check(name, value):
    report["checks"][name] = bool(value)
    assert value, name

def navigate_ready(cdp, tab, url):
    result = cdp.navigate(tab, url, timeout=10)
    deadline = time.monotonic() + 10
    expression = 'location.href === %s && document.readyState === "complete"' % json.dumps(url)
    while time.monotonic() < deadline:
        if cdp.evaluate(tab, expression):
            return result
        time.sleep(.05)
    state = cdp.evaluate(tab, '({origin: location.origin, readyState: document.readyState, title: document.title})')
    raise AssertionError('fixture navigation did not reach the expected complete document: %r' % state)

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        global file_next_draft
        report['fixture_gets'] = report.get('fixture_gets', 0) + 1
        from urllib.parse import urlsplit, parse_qs
        selected_course = int(parse_qs(urlsplit(self.path).query).get('id', ['2'])[0])
        course_page = any(path in self.path for path in ('/course/view.php', '/user/index.php', '/course/editsection.php'))
        cfg = {'wwwroot': base, 'userId': 43 if fixture_mode == 'wrong_account' else 42,
               'sesskey': 'DUMMY_BROWSER_ONLY', 'currentlogin': 123456, 'courseId': selected_course if course_page else 1,
               'courseContextId': selected_course * 100 if course_page else 100}
        if fixture_mode == 'guest':
            cfg['currentlogin'] = None
        if fixture_mode.startswith('legacy41'):
            cfg.pop('userId')
        if '/user/profile.php' in self.path:
            cfg['contextInstanceId'] = 43 if fixture_mode == 'legacy41_wrong_profile' else 42
        if fixture_mode == 'modern_null':
            cfg['userId'] = None
        if course_page and fixture_mode == 'wrong_course':
            cfg['courseId'] = 3
        if course_page and fixture_mode == 'changed_course_account':
            cfg['userId'] = 43
        if course_page and fixture_mode == 'changed_course_key':
            cfg['sesskey'] = 'DUMMY_ROTATED_KEY'
        if course_page and fixture_mode == 'changed_course_login':
            cfg['currentlogin'] = 123457
        if '/user/index.php' in self.path:
            if fixture_mode == 'legacy41_native_wrong_key':
                cfg['sesskey'] = 'DUMMY_CHANGED_NATIVE_KEY'
            if fixture_mode == 'legacy41_native_wrong_account':
                cfg['userId'] = 43
            if fixture_mode == 'legacy41_native_null_account':
                cfg['userId'] = None
        footer = ''
        if fixture_mode.startswith('legacy41'):
            cfg.pop('currentlogin')
            native_login = 123457 if '/user/index.php' in self.path and fixture_mode == 'legacy41_native_wrong_login' else 123456
            footer = "<script>require(['core/storage_validation'], function(amd) {amd.init(%d);});</script>" % native_login
        body_id = 'page-user-profile' if '/user/profile.php' in self.path else 'page-course-view'
        import html
        content = ('<!doctype html><body id="%s" class="course-%s"><h1>%s</h1><script>M.cfg=%s;</script>%s</body>' %
                   (body_id, cfg['courseId'], html.escape(course_name), json.dumps(cfg), footer)).encode()
        if '--web-input-proof' in sys.argv[4:]:
            content = content.replace(b'</body>', b'<label>Disposable name <input id="dummy-first" autocomplete="off"></label><label>Disposable code <input id="dummy-second" autocomplete="off"></label><button>Fixture only</button></body>')
        if '/course/editsection.php' in self.path:
            import html
            form = '<form method="post" action="%s/course/editsection.php?id=10"><input type="hidden" name="id" value="10"><input type="hidden" name="course" value="2"><input type="hidden" name="sesskey" value="DUMMY_BROWSER_ONLY"><input name="name" value="%s"><textarea name="summary_editor[text]">Overview</textarea><input type="hidden" name="summary_editor[format]" value="1"><input type="submit" name="submitbutton" value="Save changes"></form>' % (base, html.escape(section_name, quote=True))
            content = content.replace(b'</body>', form.encode() + b'</body>')
        if FILES_PROOF and '/course/modedit.php' in self.path:
            from urllib.parse import urlsplit, parse_qs
            query = parse_qs(urlsplit(self.path).query)
            creating = query.get('add') == ['resource']
            if creating:
                file_next_draft += 1
                item_id = str(file_next_draft)
                name = ''
                identity = '<input name="course" value="2"><input name="add" value="resource"><input name="section" value="0"><input name="return" value="0">'
                action = base + '/course/modedit.php?add=resource&amp;course=2&amp;sectionid=10&amp;return=0'
            else:
                saved = file_created.get(query.get('update', [''])[0])
                if not saved:
                    self.send_error(404)
                    return
                item_id, name = saved['item_id'], saved['name']
                identity = '<input name="update" value="%s"><input name="course" value="2">' % saved['id']
                action = base + '/course/modedit.php?update=%s&amp;return=0' % saved['id']
            manager = {'target': 'id_files', 'itemid': int(item_id), 'context': {'id': 77}, 'mainfile': True,
                       'maxfiles': -1, 'maxbytes': -1, 'areamaxbytes': -1, 'accepted_types': '*',
                       'filepicker': {'repositories': {'17': {'id': '17', 'type': 'upload'}}}}
            form = '<form method="post" action="%s">%s<input name="modulename" value="resource"><input name="name" value="%s"><input name="visible" value="%s"><input name="revision" value="1"><textarea name="introeditor[text]"></textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="6000"><div data-fieldtype="filemanager"><input type="hidden" id="id_files" name="files" value="%s"></div><input type="submit" name="submitbutton2" value="Save changes and return to course"><input name="sesskey" value="DUMMY_BROWSER_ONLY"></form><script>M.form_filemanager.init(Y, %s);</script>' % (action, identity, html.escape(name, quote=True), '1' if creating else '0', item_id, json.dumps(manager))
            content = content.replace(b'</body>', form.encode() + b'</body>')
        if FILES_PROOF and ('/draftfile.php/' in self.path or '/pluginfile.php/' in self.path):
            parts = self.path.split('?')[0].split('/')
            item_id = parts[6] if '/draftfile.php/' in self.path else next(iter(file_created.values()), {}).get('item_id')
            content = file_drafts.get(item_id, {}).get('bytes', b'')
            self.send_response(200 if content else 404)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'none'")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        global effects, section_name, file_uploads, file_saves, fixture_mode
        report["provider_calls"] += 1
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if FILES_PROOF and '/repository/' in self.path:
            from urllib.parse import parse_qs
            if '/repository_ajax.php' in self.path:
                from email import policy
                from email.parser import BytesParser
                envelope = ('Content-Type: ' + self.headers['Content-Type'] + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + body
                fields = {part.get_param('name', header='content-disposition'): part for part in BytesParser(policy=policy.default).parsebytes(envelope).iter_parts()}
                item_id = fields['itemid'].get_payload(decode=True).decode()
                incoming = fields['repo_upload_file'].get_payload(decode=True)
                filename = fields['title'].get_payload(decode=True).decode()
                file_drafts[item_id] = {'bytes': b'changed' if file_upload_mode == 'mismatch' else incoming, 'filename': filename}
                file_uploads += 1
                if file_upload_mode == 'lost_response':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                data = {'id': int(item_id), 'file': filename, 'url': base + '/draftfile.php/3/user/draft/' + item_id + '/' + filename}
            else:
                item_id = parse_qs(body.decode()).get('itemid', [''])[0]
                draft = file_drafts.get(item_id)
                data = {'filecount': 1 if draft else 0, 'list': [{'filename': draft['filename'], 'filepath': '/', 'type': 'file', 'size': len(draft['bytes']), 'sortorder': 1, 'mimetype': 'text/plain'}] if draft else [], 'tree': {'children': []}}
            payload = json.dumps(data).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if FILES_PROOF and '/course/modedit.php' in self.path:
            from urllib.parse import parse_qs
            values = parse_qs(body.decode(), keep_blank_values=True)
            module_id = str(99 + file_saves)
            saved = {'id': module_id, 'item_id': values['files'][0], 'name': values['name'][0]}
            file_created[module_id] = saved
            provider_state['cm'].append({'id': int(module_id), 'module': 'resource', 'sectionid': 10, 'name': saved['name'], 'visible': False})
            file_saves += 1
            self.send_response(303)
            self.send_header('Location', base + '/course/view.php?id=2')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if '/course/editsection.php' in self.path:
            from urllib.parse import parse_qs
            form = parse_qs(body.decode())
            section_name = form['name'][0]
            effects += 1
            self.send_response(303)
            self.send_header('Location', base + '/course/editsection.php?id=10')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if '/admin/roles/check.php' in self.path:
            caps = ['moodle/site:accessallgroups', 'moodle/course:enrolreview', 'moodle/course:viewsuspendedusers', 'moodle/user:viewdetails']
            from urllib.parse import parse_qs, urlsplit
            checked_context = parse_qs(urlsplit(self.path).query).get('contextid', ['200'])[0]
            if fixture_mode == 'course_privacy_unavailable' and checked_context == '200':
                caps = []
            html = '<form method="post" action="%s/admin/roles/check.php?contextid=%s"><select name="reportuser"><option selected value="42">Educator</option></select></form><table id="explaincaps">%s</table>' % (base, checked_context, ''.join('<tr class="rolecap yes"><td><span class="cap-name">%s</span></td><td>Yes</td></tr>' % cap for cap in caps))
            payload = html.encode()
            content_type = 'text/html'
        else:
            call = json.loads(body)[0]
            method = call['methodname']
            if method == 'core_courseformat_get_state':
                data = json.dumps(provider_state)
            elif method == 'core_course_get_enrolled_courses_by_timeline_classification':
                args = call['args']
                rows = ([{'id': number, 'fullname': 'Course %d' % number} for number in range(1, 258)]
                        if CLI_PROOF else [{'id': 2, 'fullname': 'Fixture course'}])
                if fixture_mode == 'empty_account':
                    rows = []
                elif fixture_mode == 'exact_course_pages':
                    rows = rows[:6]
                if COURSE_DISCOVERY_PRIVACY_PROOF and len(rows) > 1:
                    rows[1]['fullname'] = 'Seminar by Aster Sample'
                data = {'courses': rows[args['offset']:args['offset'] + args['limit']]}
                if fixture_mode == 'switch_after_course_discovery':
                    fixture_mode = 'wrong_account'
            elif method == 'core_courseformat_update_course':
                effects += 1
                if effect_mode != 'mismatch':
                    visible = call['args']['action'] == 'cm_show'
                    provider_state['cm'][0].update(visible=visible, accessvisible=visible, stealth=False)
                if effect_mode == 'lost_response':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                data = json.dumps(provider_state)
            elif method == 'core_table_get_dynamic_table_content':
                table_course = str(call['args'].get('uniqueid', 'user-index-participants-2')).rsplit('-', 1)[-1]
                data = {'html': '<div data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants" data-table-uniqueid="user-index-participants-2" data-table-total-rows="1"><table><tr><td><input class="usercheckbox" name="user%d"></td><td>%s</td><td>%s</td></tr></table></div>' % (learner_row['id'], learner_row['name'], learner_row['email'])}
                data['html'] = data['html'].replace('user-index-participants-2', 'user-index-participants-' + table_course)
            else:
                data = {'courses': [{'id': 2, 'fullname': 'Fixture course'}]}
            payload = json.dumps([{"error": False, "data": data}]).encode()
            content_type = 'application/json'
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

class TLSFixtureServer(ThreadingHTTPServer):
    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(10)
        return self.tls.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), address

helper = ui_helper = browser = provider = scratch = None
try:
    scratch = tempfile.TemporaryDirectory(prefix="morrow-adapter-loader-e2e-")
    tmp = scratch.name
    root = Path(tmp).resolve()
    for name in ("MORROW_USER_ID", "MORROW_CONVERSATION_ID", "LOGIN_HELPER_PRODUCTION", "LOGIN_HELPER_TLS_CERT", "LOGIN_HELPER_TLS_KEY"):
        os.environ.pop(name, None)
    os.environ.update(MORROW_HOME=str(root / 'state'), MORROW_TREE_STATE_DIR=str(root / 'tree'), MORROW_HELPER_ENV_FILE=str(root / 'empty-env'), LOGIN_HELPER_PROFILE_DIR=str(root / 'profile'), HELPER_AUTH_TOKEN='a' * 64, CHROMIUM_BIN=BINARY)
    os.environ['MORROW_SOURCE_VAULT_PATH'] = str(root / 'state' / 'fixture-learner-vault.json')
    os.environ['LOGIN_HELPER_OWN_BROWSER'] = '1'
    for candidate in random.sample(range(12000, 22000), 10000):
        probes = [socket.socket(), socket.socket()]
        try:
            probes[0].bind(('127.0.0.1', candidate))
            probes[1].bind(('127.0.0.1', candidate + 10000))
            os.environ['LOGIN_HELPER_CDP_PORT'] = str(candidate)
            break
        except OSError:
            continue
        finally:
            for probe in probes:
                probe.close()
    else:
        raise RuntimeError('no disposable browser identity port available')
    (root / 'empty-env').write_text('# disposable fixture\n')
    (root / 'tree').mkdir(mode=0o700)
    if CLI_PROOF:
        # The installer mints the identity before the executor binds state.
        from config.paths import mint_tree_uuid, read_tree_uuid
        if not read_tree_uuid(TREE):
            mint_tree_uuid(TREE)
    if GOVERNED:
        from dispatch import executor as fixture_executor
    token = root / 'tree/helper_token'
    token.write_text('a' * 64)
    token.chmod(0o600)
    cert, key = root / 'cert.pem', root / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    provider = TLSFixtureServer(('127.0.0.1', 0), Fixture)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    provider.tls = tls
    fixture_host = 'localhost' if SITE_NORMALIZATION_PROOF else '127.0.0.1'
    base = 'https://%s:%d/lms' % (fixture_host, provider.server_port)
    os.environ['CANVAS_BASE'] = 'https://sandbox.moodledemo.net'
    if HELPER_PROVIDER_PROOF:
        os.environ.pop('CANVAS_BASE', None)
        os.environ['MOODLE_BASE'] = base.replace('localhost', 'LOCALHOST') if SITE_NORMALIZATION_PROOF else base
        os.environ['MORROW_LMS_PROVIDER'] = 'moodle'
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    with urllib.request.urlopen(base + '/', context=ssl._create_unverified_context(), timeout=3) as response:
        check('disposable_https_fixture_serves_html', response.status == 200 and b'Fixture course' in response.read())
    if PUBLIC_STAGING:
        base = 'https://sandbox.moodledemo.net'
    spec = importlib.util.spec_from_file_location('morrow_loader_helper_fixture', TREE / 'helper/server.py')
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    browser = server.HelperBrowser()
    # The private fixture and rendered helper use disposable loopback servers.
    browser.launcher.extra_args.extend(['--ignore-certificate-errors', '--ip-address-space-overrides=127.0.0.1:0=public'])
    if HELPER_PROVIDER_PROOF:
        if not SITE_NORMALIZATION_PROOF:
            check('moodle_helper_configuration_selected', server.DEFAULT_BASE.rstrip('/') == base)
        browser.start(server.DEFAULT_BASE)
        if not SITE_NORMALIZATION_PROOF:
            check('moodle_helper_site_subpath_preserved', browser.base_url.rstrip('/') == base)
    else:
        browser.launcher.start()
        browser.cdp = browser.launcher.cdp
        browser.tab = browser.cdp.new_tab('about:blank')
    browser.cdp.call(browser.tab, 'Network.enable', {})
    try:
        report['fixture_navigation'] = navigate_ready(browser.cdp, browser.tab, base + '/')
    except Exception:
        report['navigation_events'] = [{'method': e.get('method'), 'error': (e.get('params') or {}).get('errorText')} for e in browser.cdp.poll_session_events(browser.cdp.tab_session(browser.tab), timeout=1) if e.get('method') in ('Network.loadingFailed', 'Page.loadEventFired')]
        raise
    if not HELPER_PROVIDER_PROOF:
        browser.base_url = base
    if SITE_NORMALIZATION_PROOF:
        report['site_normalization'] = {'configured': browser.base_url,
            'browser_href': browser.cdp.evaluate(browser.tab, 'location.href')}
        check('browser_canonicalizes_uppercase_host', report['site_normalization']['browser_href'] == base + '/')
        check('helper_uses_same_canonical_site', browser.base_url == base + '/')
        from moodle.contracts import normalize_moodle_base
        from config.tree_config import normalize_tenant_base
        for index, raw in enumerate(('https://SCHOOL.test:443/Moodle',
                                     'https://SCHOOL.test:08443/Moodle',
                                     'https://[2001:0DB8:0:0:0:0:0:1]:443/Moodle',
                                     'https://Straße.test:443/Moodle')):
            expected = browser.cdp.evaluate(browser.tab, 'new URL(%s).href' % json.dumps(raw)).rstrip('/')
            check('moodle_site_browser_equivalence_' + str(index), normalize_moodle_base(raw) == expected)
        for index, raw in enumerate(('https://SCHOOL.instructure.com:443/path',
                                     'https://SCHOOL.instructure.com:08443/path',
                                     'https://SchÖÖl.instructure.com:443/path')):
            expected = browser.cdp.evaluate(browser.tab, 'new URL(%s).origin + "/"' % json.dumps(raw))
            check('canvas_site_browser_equivalence_' + str(index), normalize_tenant_base(raw) == expected)
        confirmed_domain = os.environ.get('CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED')
        try:
            os.environ['CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED'] = 'Straße.school.test'
            raw = 'https://Straße.school.test:443/course'
            expected = browser.cdp.evaluate(browser.tab, 'new URL(%s).origin + "/"' % json.dumps(raw))
            normalized = normalize_tenant_base(raw)
            check('canvas_custom_unicode_browser_equivalence', normalized == expected)
            check('canvas_custom_unicode_normalization_idempotent', normalize_tenant_base(normalized) == normalized)
        finally:
            if confirmed_domain is None:
                os.environ.pop('CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED', None)
            else:
                os.environ['CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED'] = confirmed_domain
        for index, raw in enumerate(('https://127.1/lms', 'https://0x7f000001/lms',
                                     'https://0177.0.0.1/lms', 'https://127.0.0.1./lms')):
            expected_host = browser.cdp.evaluate(browser.tab, 'new URL(%s).hostname' % json.dumps(raw))
            check('browser_numeric_alias_is_loopback_' + str(index), expected_host == '127.0.0.1')
            try:
                normalize_moodle_base(raw)
            except ValueError:
                pass
            else:
                raise AssertionError('moodle_ambiguous_numeric_host_accepted_' + str(index))
            check('moodle_ambiguous_numeric_host_refused_' + str(index), True)
        for index, raw in enumerate(('https://@school.instructure.com',
                                     'https://school.instructure.com:bad',
                                     'https://school.instructure.com:0')):
            try:
                normalize_tenant_base(raw)
            except ValueError:
                pass
            else:
                raise AssertionError('canvas_unsafe_site_accepted_' + str(index))
            check('canvas_unsafe_site_refused_' + str(index), True)
    server.BROWSER = browser
    helper = server.BoundedThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    threading.Thread(target=helper.serve_forever, daemon=True).start()
    from transport.local_chromium import ProxyCDP
    proxy = ProxyCDP(browser.launcher.cdp_port, owner=browser.launcher, server_port=helper.server_port)
    tab = next(t for t in proxy.tabs() if t['id'] == browser.tab['id'])
    check('real_authenticated_helper_proxy', proxy.evaluate(tab, '1 + 1') == 2)
    if HELPER_PROVIDER_PROOF:
        for target in (base.replace('/lms', '/other'), base + '/../outside', base + '/%2e%2e/outside'):
            try:
                browser.navigate(target)
            except ValueError:
                pass
            else:
                raise AssertionError('moodle_helper_navigation_escaped_site')
            check('moodle_helper_refuses_' + target.rsplit('/', 1)[-1] + '_' + str(len(report['checks'])), True)
        check('moodle_helper_proxy_refuses_sibling_site', browser._proxy_tenant_ok(base.replace('/lms', '/other')) is False)
        for _ in range(100):
            status = browser.status()
            if status.get('session_verified') is True:
                break
            time.sleep(.1)
        check('moodle_helper_provider_identity', status.get('lms_provider') == 'moodle')
        check('moodle_helper_site_identity', status.get('lms_base') == base)
        check('moodle_helper_authenticated_fixture_ready', status.get('logged_in') is True)
        check('moodle_helper_session_verified', status.get('session_verified') is True)
        navigate_ready(proxy, tab, base + '/login/index.php')
        check('moodle_helper_subpath_login_not_signed_in', browser.status().get('logged_in') is False)
        navigate_ready(proxy, tab, base + '/')
        for _ in range(100):
            status = browser.status()
            if status.get('session_verified') is True:
                break
            time.sleep(.1)
        check('moodle_helper_returned_site_ready', status.get('logged_in') is True and status.get('session_verified') is True)
        for mode, expected in (('legacy41', 'verified'), ('guest', 'signed_out')):
            fixture_mode = mode
            navigate_ready(proxy, tab, base + '/?probe=' + mode)
            for _ in range(100):
                status = browser.status()
                if status.get('session_state') == expected:
                    break
                time.sleep(.1)
            check('moodle_helper_' + mode + '_session_state', status.get('session_state') == expected)
            check('moodle_helper_' + mode + '_login_state', status.get('logged_in') is (mode == 'legacy41'))
        fixture_mode = 'modern'
        navigate_ready(proxy, tab, base + '/')
        ui_helper = server.BoundedThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        ui_helper.socket = tls.wrap_socket(ui_helper.socket, server_side=True)
        threading.Thread(target=ui_helper.serve_forever, daemon=True).start()
        code_request = urllib.request.Request('https://127.0.0.1:%d/page-code' % ui_helper.server_port,
            data=b'{}', headers={'X-Helper-Token': 'a' * 64, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(code_request, context=ssl._create_unverified_context(), timeout=5) as response:
            page_code = json.loads(response.read())['page_code']
        ui_tab = browser.cdp.new_tab('about:blank')
        try:
            browser.cdp.navigate(ui_tab, 'https://127.0.0.1:%d/?code=%s' % (ui_helper.server_port, page_code))
            for _ in range(100):
                if browser.cdp.evaluate(ui_tab, 'document.title') == 'Morrow · Sign-in helper':
                    break
                time.sleep(.05)
            check('moodle_helper_ui_generic_title', browser.cdp.evaluate(ui_tab, 'document.title') == 'Morrow · Sign-in helper')
            time.sleep(1)
            if '--web-input-proof' in sys.argv[4:]:
                def ui_wait(expression):
                    for _ in range(160):
                        if browser.cdp.evaluate(ui_tab, expression):
                            return True
                        time.sleep(.05)
                    return False
                check('web_helper_batch_ready', ui_wait('document.getElementById("input-status").dataset.state === "ready"'))
                browser.cdp.evaluate(tab, 'document.getElementById("dummy-first").focus()')
                browser.cdp.evaluate(ui_tab, 'document.getElementById("capture").click()')
                browser.cdp.call(ui_tab, 'Input.insertText', {'text': 'dummy café 🧪'})
                for kind in ('keyDown', 'keyUp'):
                    browser.cdp.call(ui_tab, 'Input.dispatchKeyEvent', {'type': kind, 'key': 'Tab', 'code': 'Tab', 'windowsVirtualKeyCode': 9})
                browser.cdp.call(ui_tab, 'Input.insertText', {'text': 'second'})
                check('web_helper_real_batch_drained', ui_wait('document.getElementById("input-status").dataset.state === "ready"'))
                check('web_helper_real_unicode_exactly_once', browser.cdp.evaluate(tab, 'document.getElementById("dummy-first").value') == 'dummy café 🧪')
                check('web_helper_real_tab_preserves_order', browser.cdp.evaluate(tab, 'document.getElementById("dummy-second").value') == 'second')
                check('web_helper_no_plaintext_local_echo', browser.cdp.evaluate(ui_tab, 'document.getElementById("keyboard").value') == '')
                browser.cdp.evaluate(ui_tab, 'document.getElementById("fit").click(); document.getElementById("zoom-in").click(); document.getElementById("expand").click()')
                check('web_helper_view_controls_expand', browser.cdp.evaluate(ui_tab, 'document.getElementById("expand").getAttribute("aria-pressed")') == 'true')
                for width in (1280, 390):
                    browser.cdp.call(ui_tab, 'Emulation.setDeviceMetricsOverride', {'width': width, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False})
                    time.sleep(.3)
                    check('web_helper_real_no_overflow_' + str(width), browser.cdp.evaluate(ui_tab, 'document.documentElement.scrollWidth <= innerWidth'))
                    ui_frame = browser.cdp.call(ui_tab, 'Page.captureScreenshot', {'format': 'png'})
                    OUT.with_name(OUT.stem + '-web-' + str(width) + '.png').write_bytes(base64.b64decode(ui_frame['data']))
            frame = browser.cdp.call(ui_tab, 'Page.captureScreenshot', {'format': 'png'})
            ui_path = OUT.with_name(OUT.stem + '-helper-ui.png')
            ui_path.write_bytes(base64.b64decode(frame['data']))
            report['helper_ui_screenshot'] = str(ui_path)
            check('moodle_helper_ui_header_visible', browser.cdp.evaluate(ui_tab,
                'document.querySelector("header").getBoundingClientRect().top >= 0') is True)
        finally:
            browser.cdp.close_tab(ui_tab)
        if '--helper-setup-only' in sys.argv[4:]:
            report['scope'] = 'private Moodle helper setup only'
            report['passed'] = True
            raise SystemExit(0)
    if CLI_PROOF:
        cli_tree = Path(os.environ['MORROW_CLI_TEST_TREE']).resolve()
        check('cli_package_has_no_legacy_auth_modules', not any((cli_tree / 'moodle' / name).exists()
            for name in ('login.py', 'session.py', 'probe.py', 'keepalive.py', 'reauth.py')))
        check('cli_package_excludes_web_fixture_driver', not (cli_tree / 'scripts/helper-web-input-e2e.py').exists())
        manifest = json.loads((cli_tree / 'pack/carve-manifest.json').read_text())
        report['cli_package_hashes'] = {name: hashlib.sha256((cli_tree / name).read_bytes()).hexdigest()
                                        for name in manifest['files']}
        check('cli_package_manifest_exact', report['cli_package_hashes'] == manifest['files'])
        from config.paths import mint_tree_uuid, read_tree_uuid
        cli_id = read_tree_uuid(cli_tree) or mint_tree_uuid(cli_tree)
        cli_state = root / 'cli-state'
        cli_state.mkdir(mode=0o700)
        (cli_state / '.morrow-tree-binding').write_text(cli_id)
        (cli_state / 'helper_token').write_text('a' * 64)
        (cli_state / 'helper_token').chmod(0o600)
        cli_env = dict(os.environ, LOGIN_HELPER_PORT=str(helper.server_port), MORROW_TREE_STATE_DIR=str(cli_state))
        cli_env.pop('LOGIN_HELPER_OWN_BROWSER', None)
        browser.launcher._verify_helper_holder(helper.server_port)
        check('native_helper_holder_verified', True)
        def cli(*arguments, success=True):
            began = time.monotonic()
            response = subprocess.run([sys.executable, str(cli_tree / 'bin/morrow'), 'moodle', *arguments],
                env=cli_env, capture_output=True, text=True, timeout=120)
            report.setdefault('cli_timings', []).append({'command': arguments[0], 'seconds': round(time.monotonic() - began, 3)})
            if (response.returncode == 0) != success:
                report['cli_failure'] = {'stdout': response.stdout, 'stderr': response.stderr}
            check('cli_' + str(len(report['checks'])) + '_exit', (response.returncode == 0) == success)
            check('cli_' + str(len(report['checks'])) + '_secret_free', 'DUMMY_BROWSER_ONLY' not in response.stdout + response.stderr)
            return json.loads(response.stdout.strip().splitlines()[-1])
        paired = cli('pair', '--site', base)
        check('cli_pair_discovers_educator', paired.get('principal_id') == '42')
        again = cli('pair', '--site', base)
        check('cli_pair_is_one_time', again.get('already_paired') is True)
        if FILES_PROOF:
            local_file = root / 'fixture-file.txt'
            local_file.write_bytes(b'PRIVATE_DISPOSABLE_FILE_BYTES_7c90a40b')
            manifest = {'filename': 'fixture-file.txt', 'size_bytes': local_file.stat().st_size,
                        'sha256': hashlib.sha256(local_file.read_bytes()).hexdigest()}
            staged_file = cli('stage-file', '--course-id', '2', '--path', str(local_file), '--filename', manifest['filename'])
            check('private_file_stage_returns_only_review_manifest', staged_file == {'ok': True, 'manifest': manifest})
            check('private_file_stage_has_no_lms_effect', effects == 0)
            check('private_file_bytes_not_in_cli_result', 'PRIVATE_DISPOSABLE_FILE_BYTES_7c90a40b' not in json.dumps(staged_file))
            repeat_stage = cli('stage-file', '--course-id', '2', '--path', str(local_file))
            check('private_file_repeat_is_exact', repeat_stage == staged_file)
            for name, data in (('empty', b''), ('oversized', b'x' * 1048577)):
                rejected_file = root / (name + '.txt')
                rejected_file.write_bytes(data)
                cli('stage-file', '--course-id', '2', '--path', str(rejected_file), success=False)
                check('private_file_' + name + '_no_effect', effects == 0)
            linked_file = root / 'linked.txt'
            linked_file.symlink_to(local_file)
            cli('stage-file', '--course-id', '2', '--path', str(linked_file), success=False)
            cli('stage-file', '--course-id', '2', '--path', str(root), success=False)
            cli('stage-file', '--course-id', '2', '--path', str(local_file), '--filename', '../unsafe.txt', success=False)
            check('private_file_rejections_no_effect', effects == 0)
            alternate_file = root / 'second-private-file.txt'
            alternate_file.write_bytes(b'PRIVATE_SECOND_FILE_BYTES_b521')
            second_stage = cli('stage-file', '--course-id', '2', '--path', str(alternate_file))
            second_manifest = second_stage['manifest']
            learner_stage = cli('stage-file', '--course-id', '2', '--path', str(local_file), '--filename', 'Aster Sample guide.txt')
            check('private_file_manifest_masks_learner', learner_stage.get('ok') is True and 'Aster Sample' not in json.dumps(learner_stage) and 'Student A' in learner_stage['manifest']['filename'])
            local_file.write_bytes(b'CHANGED_LOCAL_FILE_AFTER_STAGING')
            private_store = cli_state / 'moodle_private_files'
            for record in private_store.glob('*.file'):
                check('private_file_record_encrypted', b'PRIVATE_DISPOSABLE_FILE_BYTES_7c90a40b' not in record.read_bytes())
                check('private_file_record_owner_only', record.stat().st_mode & 0o777 == 0o600)
            file_probe = root / 'private-file-browser-probe.py'
            file_probe.write_text("""
import hashlib, json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from moodle.cli import _account, _launcher, _dispatcher
from moodle.browser_transport import MoodleBrowserTransport
from moodle.private_files import PrivateMoodleFiles
record = _account()
transport = MoodleBrowserTransport(record['site'], _launcher(), principal_id=record['principal_id'])
dispatcher = _dispatcher(transport)
binding = dispatcher._binding(2)
manifest, second_manifest, learner_manifest = json.loads(sys.argv[2])
arguments = {'course_id': 2, **manifest}
files = PrivateMoodleFiles()
checks = {}
for name, alternate, args in (
    ('wrong_course', {**binding, 'courseId': '3'}, arguments),
    ('wrong_principal', {**binding, 'principalId': '43'}, arguments),
    ('wrong_site', {**binding, 'siteUrl': binding['siteUrl'] + '/other'}, arguments),
    ('changed_manifest', binding, {**arguments, 'sha256': '0' * 64}),
    ('duplicate_set', binding, {'files': [manifest, manifest]})):
    try:
        files.attachments(alternate, args, 'multiple' if name == 'duplicate_set' else 'single')
    except Exception:
        checks[name] = True
    else:
        checks[name] = False
routes = {key: value for key, value in dispatcher.loader.operations.items() if value.get('attachmentMode') in ('single', 'multiple')}
checks['nine_routes'] = len(routes) == 9
checks['immutable_after_source_change'] = files.attachments(binding, arguments, 'single')['privateAttachment']['manifest'] == manifest
checks['ordered_multiple'] = [row['manifest'] for row in files.attachments(binding, {'files': [second_manifest, manifest]}, 'multiple')['privateAttachments']] == [second_manifest, manifest]
learner_params = {'course_id': 2, **learner_manifest}
def private_learner_lookup(resolved):
    payload = files.attachments(binding, resolved, 'single')
    return {'ok': payload['privateAttachment']['manifest']['filename'] == 'Aster Sample guide.txt'}
checks['learner_filename_resolves_privately'] = dispatcher._boundary(binding).invoke('moodle_create_resource_file', {**learner_params, '_morrow': {'source_binding_id': binding['sourceBindingId']}}, {}, private_learner_lookup).get('ok') is True
scope = {'site': binding['siteUrl'], 'principal': binding['principalId'], 'course': binding['courseId']}
path = Path(files._path(scope, manifest))
original = path.read_bytes()
path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
try:
    files.attachments(binding, arguments, 'single')
except Exception:
    checks['altered_cipher_refused'] = True
else:
    checks['altered_cipher_refused'] = False
finally:
    path.write_bytes(original)
for key, route in routes.items():
    args = {'course_id': 2, 'files': [second_manifest, manifest]} if route['attachmentMode'] == 'multiple' else arguments
    request = dispatcher._request(key, args, binding)
    tab, context, staged = transport._stage_operation(dispatcher.loader, key, request)
    try:
        expression = '(async()=>{const i=JSON.parse(globalThis[%s].input);const a=i.privateAttachments||[i.privateAttachment];return Promise.all(a.map(async f=>{const raw=Uint8Array.from(atob(f.bytes_base64),c=>c.charCodeAt(0));const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",raw)),v=>v.toString(16).padStart(2,"0")).join("");return {manifest:f.manifest,hash};}));})()' % json.dumps(staged.slot)
        result = transport.cdp.evaluate(tab, expression, context_id=context, await_promise=True)
        checks['browser_' + route['toolName']] = result == [{'manifest': value, 'hash': value['sha256']} for value in ([second_manifest, manifest] if route['attachmentMode'] == 'multiple' else [manifest])]
    finally:
        transport.cdp.close_tab(tab)
print(json.dumps(checks))
""")
            probe = subprocess.run([sys.executable, str(file_probe), str(cli_tree), json.dumps([manifest, second_manifest, learner_stage['manifest']])], env=cli_env,
                                   capture_output=True, text=True, timeout=240)
            report['private_file_probe_exit'] = probe.returncode
            if probe.returncode:
                report['private_file_probe_failure'] = probe.stderr[-2000:]
            check('private_file_real_browser_probe_exit', probe.returncode == 0)
            for name, passed in json.loads(probe.stdout.strip().splitlines()[-1]).items():
                check('private_file_' + name, passed)
            check('private_file_probe_no_effect', effects == 0)
        fixture_mode = 'wrong_account'
        cli('pair', '--site', base, success=False)
        fixture_mode = 'modern'
        check('cli_pair_preserved_after_wrong_account', cli('status').get('principal_id') == '42')
        if ACCOUNT_COURSE_PROOF:
            account_courses = cli('read', '--operation', 'moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1', '--arguments', '{"offset":0,"limit":3}')
            check('account_course_operation_requires_no_course_selection', account_courses.get('ok') is True and len(account_courses.get('data', {}).get('courses', [])) == 3)
        if COURSE_DISCOVERY_PRIVACY_PROOF:
            private_courses = cli('courses', '--limit', '3')
            check('course_discovery_projects_learner_title', 'Aster Sample' not in json.dumps(private_courses) and 'Student A' in json.dumps(private_courses))
        catalog = cli('catalog')
        check('cli_all_public_operations_available', len(catalog['operations']) == 249)
        discovered = []
        offset = 0
        while True:
            page = cli('courses', '--offset', str(offset))
            discovered.extend(page['courses'])
            if page['complete']:
                break
            offset = page['next_offset']
        check('cli_no_course_count_limit', len(discovered) == 257 and len({row['id'] for row in discovered}) == 257)
        read = cli('read', '--operation', 'moodle.ajax.core_courseformat_get_state.v1', '--arguments', '{"course_id":2}')
        check('cli_read_masks_learner', read.get('ok') is True and 'Aster Sample' not in json.dumps(read) and 'Student A' in json.dumps(read))
        hide_key = 'moodle.ajax.core_courseformat_update_course.cm_hide.v1'
        write_args = json.dumps({'course_id': 2, 'module_id': 19, 'expected_digest': read['snapshot_digest']})
        op_id = str(uuid.uuid4())
        prepared = cli('plan', '--operation', hide_key, '--arguments', write_args, '--op-id', op_id)
        check('cli_plan_names_course_and_change', prepared.get('target', {}).get('course_name') == 'Fixture course' and 'Hide a Moodle activity' in prepared['review'])
        check('cli_plan_hides_internal_details', 'function_sha256' not in prepared['review'] and 'registry_sha256' not in prepared['review'])
        pending = cli_state / 'moodle_pending' / (op_id + '.json')
        check('cli_plan_record_private', pending.stat().st_mode & 0o777 == 0o600)
        cli('plan', '--operation', hide_key, '--arguments', write_args, '--op-id', op_id, success=False)
        before_effects = effects
        cli('execute', '--operation', hide_key, '--arguments', write_args, success=False)
        check('cli_unapproved_execute_no_effect', effects == before_effects)
        check('cli_default_mode_plan', cli('mode', 'status')['mode'] == 'plan')
        cli('mode', 'set', 'edit')
        check('cli_mode_edit_persists', cli('mode', 'status')['mode'] == 'edit')
        edited = cli('execute', '--operation', hide_key, '--arguments', write_args)
        check('cli_edit_write_verified', edited.get('ok') is True and edited.get('verification', {}).get('status') == 'verified')
        check('cli_write_returns_recovery_id', str(uuid.UUID(edited['op_id'])) == edited['op_id'])
        check('cli_edit_write_exactly_one_effect', effects == before_effects + 1)
        cli('mode', 'set', 'plan')
        cli('execute', '--operation', hide_key, '--arguments', write_args, success=False)
        check('cli_revoked_edit_no_effect', effects == before_effects + 1)
        cli('read', '--operation', 'moodle.ajax.core_courseformat_update_course.cm_hide.v1', '--arguments', '{"course_id":2}', success=False)
        cli('read', '--operation', 'unknown', '--arguments', '{"course_id":2}', success=False)
        if FILES_PROOF:
            file_catalog = {row['toolName']: row['key'] for row in catalog['operations']}
            definition = next(row for row in catalog['operations'] if row['toolName'] == 'moodle_create_resource_file')
            review_key = file_catalog[definition['reviewTool']]
            file_review = cli('read', '--operation', review_key, '--arguments', '{"course_id":2,"section_id":10}')
            check('private_file_native_creation_form_reviewed', file_review.get('ok') is True)
            parameters = {'course_id': 2, 'section_id': 10, 'name': 'Disposable private file', **manifest,
                          'expected_digest': file_review['snapshot_digest']}
            file_op = str(uuid.uuid4())
            cli('plan', '--operation', definition['key'], '--arguments', json.dumps(parameters), '--op-id', file_op)
            check('private_file_plan_no_upload', file_uploads == 0 and file_saves == 0)
            saved_result = cli('approve', '--op-id', file_op, '--authorization', 'Approve this exact disposable file in this course')
            check('private_file_native_saved_bytes_verified', saved_result.get('ok') is True and saved_result.get('verification', {}).get('status') == 'verified')
            check('private_file_one_upload_one_save', file_uploads == 1 and file_saves == 1)
            cli('approve', '--op-id', file_op, '--authorization', 'Approve this exact disposable file in this course', success=False)
            check('private_file_success_never_replayed', file_uploads == 1 and file_saves == 1)
            check('private_file_plaintext_absent_from_plan_and_result', all('PRIVATE_DISPOSABLE_FILE_BYTES_7c90a40b' not in text for text in (json.dumps(saved_result), (cli_state / 'moodle_pending' / (file_op + '.json')).read_text())))
            missing_args = {**parameters, 'sha256': '0' * 64}
            missing_op = str(uuid.uuid4())
            cli('plan', '--operation', definition['key'], '--arguments', json.dumps(missing_args), '--op-id', missing_op, success=False)
            check('private_file_missing_stage_cannot_create_approval', not (cli_state / 'moodle_pending' / (missing_op + '.json')).exists() and file_uploads == 1)
            restored_op = str(uuid.uuid4())
            cli('plan', '--operation', definition['key'], '--arguments', json.dumps(parameters), '--op-id', restored_op)
            cache_key = hashlib.sha256(json.dumps({'scope': {'site': base, 'principal': '42', 'course': '2'}, 'manifest': manifest}, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
            cache_record = private_store / (cache_key + '.file')
            cached_bytes = cache_record.read_bytes()
            cache_record.write_bytes(cached_bytes[:-1] + bytes([cached_bytes[-1] ^ 1]))
            cli('approve', '--op-id', restored_op, '--authorization', 'Approve this exact disposable file', success=False)
            check('private_file_altered_stage_no_upload', file_uploads == 1 and file_saves == 1)
            cache_record.write_bytes(cached_bytes)
            restored_result = cli('approve', '--op-id', restored_op, '--authorization', 'Approve this exact disposable file')
            check('private_file_refusal_preserves_approval', restored_result.get('ok') is True and file_uploads == 2 and file_saves == 2)
            cli('mode', 'set', 'edit')
            edit_file_result = cli('execute', '--operation', definition['key'], '--arguments', json.dumps(parameters))
            check('private_file_edit_saved_bytes_verified', edit_file_result.get('ok') is True and file_uploads == 3 and file_saves == 3)
            halt = root / 'state' / 'write_halt'
            halt.parent.mkdir(exist_ok=True)
            halt.write_text('fixture operator halt')
            cli('execute', '--operation', definition['key'], '--arguments', json.dumps(parameters), success=False)
            check('private_file_edit_halt_no_upload', file_uploads == 3 and file_saves == 3)
            halt.unlink()
            cli('mode', 'set', 'plan')
            for upload_mode in ('mismatch', 'lost_response'):
                file_upload_mode = upload_mode
                uncertain_op = str(uuid.uuid4())
                cli('plan', '--operation', definition['key'], '--arguments', json.dumps(parameters), '--op-id', uncertain_op)
                uploads_before = file_uploads
                cli('approve', '--op-id', uncertain_op, '--authorization', 'Approve this disposable file', success=False)
                check('private_file_' + upload_mode + '_save_not_sent', file_uploads == uploads_before + 1 and file_saves == 3)
                cli('approve', '--op-id', uncertain_op, '--authorization', 'Approve this disposable file', success=False)
                check('private_file_' + upload_mode + '_new_process_no_replay', file_uploads == uploads_before + 1 and file_saves == 3)
            file_upload_mode = 'normal'
        if ACCOUNT_COURSE_PROOF:
            for values in ({'limit': 0}, {'limit': 101}, {'offset': -1}, {'course_id': 2}, {'limit': True}):
                cli('read', '--operation', 'moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1', '--arguments', json.dumps(values), success=False)
            fixture_mode = 'empty_account'
            empty_courses = cli('courses', '--limit', '3')
            check('account_course_empty_complete', empty_courses['courses'] == [] and empty_courses['complete'] is True and empty_courses['next_offset'] is None)
            fixture_mode = 'exact_course_pages'
            first_page = cli('courses', '--limit', '3')
            second_page = cli('courses', '--limit', '3', '--offset', str(first_page['next_offset']))
            final_page = cli('courses', '--limit', '3', '--offset', str(second_page['next_offset']))
            check('account_course_exact_pages_complete', len(first_page['courses']) == 3 and len(second_page['courses']) == 3 and final_page['courses'] == [] and final_page['complete'] is True and final_page['next_offset'] is None)
            fixture_mode = 'course_privacy_unavailable'
            unavailable_courses = cli('courses', '--limit', '3')
            unavailable = next(row for row in unavailable_courses['courses'] if row['id'] == '2')
            check('account_course_unavailable_roster_hides_title', unavailable == {'id': '2', 'name': 'Course 2', 'name_unavailable': True} and 'Aster Sample' not in json.dumps(unavailable_courses))
            fixture_mode = 'switch_after_course_discovery'
            changed_courses = cli('courses', '--limit', '3', success=False)
            check('account_course_mid_batch_account_change_no_egress', changed_courses.get('ok') is False and 'Aster Sample' not in json.dumps(changed_courses))
            fixture_mode = 'modern'
        fixture_mode = 'legacy41'
        check('cli_legacy_account_status', cli('status').get('principal_id') == '42')
        fixture_mode = 'modern'
    if PUBLIC_STAGING:
        check('permitted_public_provider_loaded', proxy.evaluate(tab, 'location.origin') == base)
    else:
        check('disposable_fixture_loaded', proxy.evaluate(tab, 'location.href') == base + '/')
    context = proxy.create_isolated_world(tab, 'morrow_adapter_loader_e2e')
    check('real_isolated_world', isinstance(context, int))
    report['source_hashes'] = {str(path.relative_to(TREE)): hashlib.sha256(path.read_bytes()).hexdigest() for path in (TREE / 'helper/server.py', TREE / 'transport/local_chromium.py', TREE / 'moodle/browser_operations.py', TREE / 'moodle/browser_transport.py')}
    report['driver_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if GOVERNED:
        report['source_hashes']['moodle/dispatch.py'] = hashlib.sha256((TREE / 'moodle/dispatch.py').read_bytes()).hexdigest()
    from moodle.browser_operations import MoodleAdapterLoader
    registry = ASSETS / 'moodle-browser-routes.json'
    digest = hashlib.sha256(registry.read_bytes()).hexdigest()
    report['registry_sha256'] = digest
    loader = MoodleAdapterLoader(ASSETS, registry_sha256=digest)
    before_staging_calls = report['provider_calls']
    key_name = 'moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1'
    request = {'mode': 'execute', 'operation': {'key': key_name, 'toolName': 'moodle_list_my_courses', 'provider': 'moodle', 'readOnly': True}, 'binding': {'origin': base.split('/lms')[0], 'siteUrl': base, 'principalId': '42'}, 'arguments': {'limit': 100, 'offset': 0}, 'expiresAt': int(time.time() * 1000) + 60000}
    handle = loader.stage(proxy, tab, context, key_name, request, base_url=base)
    check('large_core_adapter_staged_under_proxy_limit', handle.function_sha256 == json.loads(registry.read_text())['operations'][key_name]['functionSha256'])
    check('staging_does_not_call_provider', report['provider_calls'] == before_staging_calls)
    if not PUBLIC_STAGING:
        # Fixture-only identity seed. Production must derive this inside the browser.
        proxy.evaluate(tab, 'globalThis.M={cfg:%s}' % json.dumps({'wwwroot': base, 'userId': 42, 'sesskey': 'DUMMY_BROWSER_ONLY', 'courseId': 1}), context_id=context)
        result = proxy.evaluate(tab, 'globalThis[%s].fn(globalThis[%s].input)' % (json.dumps(handle.slot), json.dumps(handle.slot)), await_promise=True, context_id=context)
        expected_courses = ([{'id': str(number), 'name': 'Course %d' % number} for number in range(1, 101)]
                            if CLI_PROOF else [{'id': '2', 'name': 'Fixture course'}])
        if COURSE_DISCOVERY_PRIVACY_PROOF and len(expected_courses) > 1:
            expected_courses[1]['name'] = 'Seminar by Aster Sample'
        check('shared_adapter_executes_through_strict_csp', result.get('ok') is True and result.get('data', {}).get('courses') == expected_courses)
        check('exactly_one_fixture_provider_call', report['provider_calls'] == before_staging_calls + 1)
    huge = {'text': 'Unicode 🧪 café ' * 18000}
    large = loader.stage(proxy, tab, context, key_name, huge, base_url=base)
    check('chunked_unicode_input_exact', proxy.evaluate(tab, 'JSON.parse(globalThis[%s].input).text.length' % json.dumps(large.slot), context_id=context) == len(huge['text']) + huge['text'].count('🧪'))
    before = report['provider_calls']
    def refuse(name, action):
        try:
            action()
        except Exception:
            check(name, True)
        else:
            check(name, False)
        check(name + '_no_provider_call', report['provider_calls'] == before)
    refuse('unknown_route_refused', lambda: loader.stage(proxy, tab, context, 'unknown', {}, base_url=base))
    refuse('wrong_site_refused', lambda: loader.stage(proxy, tab, context, key_name, request, base_url=base + '-other'))
    refuse('oversized_input_refused', lambda: loader.stage(proxy, tab, context, key_name, {'text': 'x' * 2200000}, base_url=base))
    refuse('changed_registry_refused', lambda: MoodleAdapterLoader(ASSETS, registry_sha256='0' * 64))
    altered = root / 'altered'
    shutil.copytree(ASSETS, altered)
    module = altered / 'moodle-executor.js'
    module.write_bytes(module.read_bytes() + b'\n// changed\n')
    refuse('changed_module_refused', lambda: MoodleAdapterLoader(altered, registry_sha256=digest).stage(proxy, tab, context, key_name, request, base_url=base))
    module.unlink()
    module.symlink_to(ASSETS / 'moodle-executor.js')
    refuse('symlink_module_refused', lambda: MoodleAdapterLoader(altered, registry_sha256=digest).stage(proxy, tab, context, key_name, request, base_url=base))
    navigate_ready(proxy, tab, base + '/?sesskey=DUMMY_URL_SECRET')
    context = proxy.create_isolated_world(tab, 'morrow_adapter_loader_url_privacy')
    class RecordedProxy(ProxyCDP):
        def evaluate(self, *args, **kwargs):
            value = super().evaluate(*args, **kwargs)
            self.values.append(value)
            return value
    recorded = RecordedProxy(browser.launcher.cdp_port, owner=browser.launcher, server_port=helper.server_port)
    recorded.values = []
    private_url = loader.stage(recorded, tab, context, key_name, {}, base_url=base)
    check('page_url_secret_stays_inside_browser', all('DUMMY_URL_SECRET' not in json.dumps(value) for value in recorded.values))
    proxy.evaluate(tab, 'delete globalThis[%s]' % json.dumps(private_url.slot), context_id=context)
    root_site = loader.stage(proxy, tab, context, key_name, {}, base_url=base.split('/lms')[0])
    check('root_site_accepts_its_course_subpaths', isinstance(root_site.slot, str))
    proxy.evaluate(tab, 'delete globalThis[%s]' % json.dumps(root_site.slot), context_id=context)
    unique = {}
    for operation_key, route in json.loads(registry.read_text())['operations'].items():
        unique.setdefault((route['file'], route['function']), operation_key)
    for index, operation_key in enumerate(unique.values()):
        loaded = loader.stage(proxy, tab, context, operation_key, {}, base_url=base)
        check('canonical_callable_%d_staged' % index, proxy.evaluate(tab, 'typeof globalThis[%s].fn' % json.dumps(loaded.slot), context_id=context) == 'function')
        proxy.evaluate(tab, 'delete globalThis[%s]' % json.dumps(loaded.slot), context_id=context)
    class PartialAckProxy(ProxyCDP):
        def evaluate(self, *args, **kwargs):
            self.calls = getattr(self, 'calls', 0) + 1
            value = super().evaluate(*args, **kwargs)
            return None if self.calls == 3 else value
    partial = PartialAckProxy(browser.launcher.cdp_port, owner=browser.launcher, server_port=helper.server_port)
    count_expression = "Object.keys(globalThis).filter(k=>k.startsWith('__morrow_adapter_')).length"
    staged_count = proxy.evaluate(tab, count_expression, context_id=context)
    refuse('partial_ack_refused', lambda: loader.stage(partial, tab, context, key_name, request, base_url=base))
    check('partial_load_removed', proxy.evaluate(tab, count_expression, context_id=context) == staged_count)
    navigate_ready(proxy, tab, base + ('/login/index.php' if PUBLIC_STAGING else '/other'))
    refuse('replaced_execution_context_refused', lambda: loader.stage(proxy, tab, context, key_name, request, base_url=base))
    if not PUBLIC_STAGING:
        from moodle.browser_transport import MoodleBrowserTransport
        transport = MoodleBrowserTransport(base, browser.launcher, principal_id='42')
        transport.cdp = proxy
        course_request = {**request, 'binding': {**request['binding'], 'courseId': '2'},
                          'arguments': {'course_id': 2, 'limit': 100, 'offset': 0},
                          'expiresAt': int(time.time() * 1000) + 60000}
        for mode in ('modern', 'legacy41'):
            fixture_mode = mode
            prepared_tab, prepared_context, prepared = transport._stage_operation(loader, key_name, course_request)
            values = proxy.evaluate(prepared_tab,
                '({id:String(M.cfg.userId),course:String(M.cfg.courseId),site:M.cfg.wwwroot})', context_id=prepared_context)
            check(mode + '_trusted_private_course_identity', values == {'id': '42', 'course': '2', 'site': base})
            check(mode + '_identity_preparation_no_operation', report['provider_calls'] == before)
            check(mode + '_no_secret_in_staged_handle', 'DUMMY_BROWSER_ONLY' not in str(prepared))
        for mode in ('wrong_account', 'modern_null', 'wrong_course', 'legacy41_wrong_profile',
                     'changed_course_account', 'changed_course_key', 'changed_course_login'):
            fixture_mode = mode
            refuse(mode + '_operation_preparation_refused', lambda: transport._stage_operation(loader, key_name, course_request))
    if GOVERNED:
        fixture_mode = 'legacy41' if LEGACY_GOVERNED else 'modern'
        from moodle.dispatch import MoodleDispatcher
        from dispatch.admission import mint_approval, sign_approval
        from dispatch.executor import find_journal_op
        import uuid
        operation_identity = transport.operation_identity()
        check('operation_identity_has_fresh_session_generation', operation_identity == {'id': '42', 'site_url': base, 'session_generation': 123456})
        check('operation_identity_has_no_browser_secret', 'DUMMY_BROWSER_ONLY' not in json.dumps(operation_identity))
        dispatcher = MoodleDispatcher(transport, ASSETS, registry_sha256=digest)
        read_key = 'moodle.ajax.core_courseformat_get_state.v1'
        hide_key = 'moodle.ajax.core_courseformat_update_course.cm_hide.v1'
        read_result = dispatcher.dispatch(read_key, {'course_id': 2}, op_id=str(uuid.uuid4()))
        check('governed_read_ok', read_result.get('ok') is True)
        check('governed_read_masks_learner', 'Aster Sample' not in json.dumps(read_result) and 'Student A' in json.dumps(read_result))
        if LEGACY_GOVERNED:
            for native_mode in ('legacy41_native_wrong_key', 'legacy41_native_wrong_account', 'legacy41_native_null_account', 'legacy41_native_wrong_login'):
                fixture_mode = native_mode
                before_effects = effects
                refused = dispatcher.dispatch(read_key, {'course_id': 2}, op_id=str(uuid.uuid4()))
                check(native_mode + '_read_refused', refused.get('ok') is not True)
                check(native_mode + '_no_effect', effects == before_effects)
            fixture_mode = 'legacy41'
        args = {'course_id': 2, 'module_id': 19, 'expected_digest': read_result['snapshot_digest']}
        def no_effect(name, action):
            before_effects = effects
            try:
                action()
            except Exception:
                check(name, True)
            else:
                check(name, False)
            check(name + '_no_effect', effects == before_effects)
        no_effect('unapproved_write_refused', lambda: dispatcher.dispatch(hide_key, args, op_id=str(uuid.uuid4())))
        if PREFLIGHT_PROOF:
            provider_state['cm'][0]['name'] = 'Changed source title'
            no_effect('stale_source_plan_refused', lambda: dispatcher.plan(hide_key, args, op_id=str(uuid.uuid4())))
            provider_state['cm'][0]['name'] = 'Essay by Aster Sample'
        write_id = str(uuid.uuid4())
        plan = dispatcher.plan(hide_key, args, op_id=write_id)
        entry = dispatcher.descriptor(hide_key, args)
        approval = sign_approval(mint_approval(entry, args, base, target_identity=plan.target_identity),
                                 'Hide this activity in this disposable fixture.', channel='driver')
        no_effect('driver_channel_refused_by_default', lambda: dispatcher.dispatch(hide_key, args, op_id=write_id, plan=plan, approval=approval))
        no_effect('changed_approved_arguments_refused', lambda: dispatcher.dispatch(hide_key, {**args, 'module_id': 20}, op_id=write_id, plan=plan, approval=approval))
        if PREFLIGHT_PROOF:
            from dispatch.admission import approval_used
            provider_state['cm'][0]['name'] = 'Changed source title'
            no_effect('source_changed_before_send_refused', lambda: dispatcher.dispatch(hide_key, args, op_id=write_id, plan=plan, approval=approval, require_educator_channel=False))
            check('stale_source_keeps_approval_unconsumed', not approval_used(approval))
            provider_state['cm'][0]['name'] = 'Essay by Aster Sample'
        approved_effects_before = effects
        write_result = dispatcher.dispatch(hide_key, args, op_id=write_id, plan=plan, approval=approval, require_educator_channel=False)
        report['approved_write_result'] = write_result
        report['approved_write_journal'] = find_journal_op(write_id)
        check('approved_write_verified', write_result.get('ok') is True and write_result.get('verification', {}).get('status') == 'verified')
        check('exactly_one_approved_effect', effects == approved_effects_before + 1 and provider_state['cm'][0]['visible'] is False)
        record = find_journal_op(write_id)
        check('durable_verified_outcome', record['verification'] == 'verified' and record['uncertain'] is False)
        check('journal_masks_learner', 'Aster Sample' not in json.dumps(record))
        no_effect('completed_write_replay_refused', lambda: dispatcher.dispatch(hide_key, args, op_id=write_id, plan=plan, approval=approval))
        for mode in ('mismatch', 'lost_response'):
            effect_mode = mode
            provider_state['cm'][0].update(visible=True, accessvisible=True, stealth=False)
            current = dispatcher.dispatch(read_key, {'course_id': 2}, op_id=str(uuid.uuid4()))
            args = {**args, 'expected_digest': current['snapshot_digest']}
            op_id = str(uuid.uuid4())
            plan = dispatcher.plan(hide_key, args, op_id=op_id)
            entry = dispatcher.descriptor(hide_key, args)
            approval = sign_approval(mint_approval(entry, args, base, target_identity=plan.target_identity),
                                     'Hide this activity in this disposable fixture.', channel='driver')
            result = dispatcher.dispatch(hide_key, args, op_id=op_id, plan=plan, approval=approval, require_educator_channel=False)
            check(mode + '_not_success', result.get('ok') is False)
            record = find_journal_op(op_id)
            check(mode + '_durable_uncertain', record['uncertain'] is True)
            no_effect(mode + '_replay_refused', lambda: MoodleDispatcher(transport, ASSETS, registry_sha256=digest).dispatch(hide_key, args, op_id=op_id, plan=plan, approval=approval))
            if RESTART_PROOF:
                before_effects = effects
                child = r'''
import json,sys,uuid
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
from transport.local_chromium import ProxyCDP
from moodle.browser_transport import MoodleBrowserTransport
from moodle.dispatch import MoodleDispatcher
from dispatch.admission import mint_approval,sign_approval
from dispatch.executor import find_journal_op
tree,base,assets,pin,port,helper_port,key,arguments,op_id = sys.argv[1:]
owner=SimpleNamespace()
owner.cdp=ProxyCDP(int(port), owner=owner, server_port=int(helper_port))
transport=MoodleBrowserTransport(base,owner,principal_id='42')
dispatcher=MoodleDispatcher(transport,assets,registry_sha256=pin)
args=json.loads(arguments)
before=find_journal_op(op_id)
fresh=dispatcher.dispatch('moodle.ajax.core_courseformat_get_state.v1', {'course_id':args['course_id']},op_id=str(uuid.uuid4()))
args['expected_digest']=fresh['snapshot_digest']
plan=dispatcher.plan(key,args,op_id=op_id)
approval=sign_approval(mint_approval(dispatcher.descriptor(key,args),args,base,target_identity=plan.target_identity), 'Disposable restart proof only.',channel='driver')
result=dispatcher.dispatch(key,args,op_id=op_id,plan=plan,approval=approval,require_educator_channel=False)
after=find_journal_op(op_id)
print(json.dumps({'replay_refused':result.get('ok') is False,'journal_unchanged':before==after,'uncertain':after.get('uncertain') is True}))
'''
                restarted = subprocess.run([sys.executable, '-c', child, str(TREE), base, str(ASSETS), digest,
                    str(browser.launcher.cdp_port), str(helper.server_port), hide_key, json.dumps(args), op_id],
                    capture_output=True, text=True, timeout=90)
                if restarted.returncode:
                    report[mode + '_restart_failure'] = {'returncode': restarted.returncode,
                        'stderr': restarted.stderr[-8000:]}
                check(mode + '_new_process_finished', restarted.returncode == 0)
                restart_result = json.loads(restarted.stdout.strip().splitlines()[-1])
                check(mode + '_new_process_refuses_fresh_approval_replay', restart_result['replay_refused'])
                check(mode + '_new_process_keeps_uncertain_journal', restart_result['journal_unchanged'] and restart_result['uncertain'])
                check(mode + '_new_process_no_effect', effects == before_effects)
        check('all_governed_outputs_secret_free', 'DUMMY_BROWSER_ONLY' not in json.dumps([read_result, write_result, record]))
        report['fixture_effects'] = effects
        if COURSE_NAME_PROOF:
            fixture_mode = 'modern'
            effect_mode = 'normal'
            course_name = 'Course for Aster Sample'
            provider_state['course']['fullname'] = course_name
            current = dispatcher.dispatch(read_key, {'course_id': 2}, op_id=str(uuid.uuid4()))
            args = {'course_id': 2, 'module_id': 19, 'expected_digest': current['snapshot_digest']}
            op_id = str(uuid.uuid4())
            plan = dispatcher.plan(hide_key, args, op_id=op_id)
            check('course_plan_name_privacy_projected', plan.target_identity['course_name'] == 'Course for Student A1')
            approval = sign_approval(mint_approval(dispatcher.descriptor(hide_key, args), args, base, target_identity=plan.target_identity), 'Change this disposable activity.', channel='driver')
            before_effects = effects
            result = dispatcher.dispatch(hide_key, args, op_id=op_id, plan=plan, approval=approval, require_educator_channel=False)
            check('approved_masked_course_write_verified', result.get('ok') is True and result.get('verification', {}).get('status') == 'verified')
            check('approved_masked_course_write_one_effect', effects == before_effects + 1)
            current = dispatcher.dispatch(read_key, {'course_id': 2}, op_id=str(uuid.uuid4()))
            args = {**args, 'expected_digest': current['snapshot_digest']}
            op_id = str(uuid.uuid4())
            plan = dispatcher.plan(hide_key, args, op_id=op_id)
            approval = sign_approval(mint_approval(dispatcher.descriptor(hide_key, args), args, base, target_identity=plan.target_identity), 'Change this disposable activity.', channel='driver')
            course_name = 'Changed course for Aster Sample'
            before_effects = effects
            result = dispatcher.dispatch(hide_key, args, op_id=op_id, plan=plan, approval=approval, require_educator_channel=False)
            check('changed_masked_course_target_refused', result.get('ok') is False)
            check('changed_masked_course_target_no_effect', effects == before_effects)
            course_name = 'Course for Aster Sample'
            result = dispatcher.dispatch(hide_key, args, op_id=op_id, plan=plan, approval=approval, require_educator_channel=False)
            check('restored_masked_course_target_same_approval_verified', result.get('ok') is True and result.get('verification', {}).get('status') == 'verified')
            check('restored_masked_course_target_one_effect', effects == before_effects + 1)
            report['fixture_effects'] = effects
        if LABEL_PROOF:
            fixture_mode = 'modern'
            effect_mode = 'normal'
            section_read = 'moodle.form.course.editsection.read.v1'
            section_write = 'moodle.form.course.editsection.write.v1'
            before = dispatcher.dispatch(section_read, {'course_id': 2, 'section_id': 10}, op_id=str(uuid.uuid4()))
            report['section_read'] = before
            check('native_section_read_ready', before.get('ok') is True)
            args = {'course_id': 2, 'section_id': 10, 'name': 'Section for Student A1', 'expected_digest': before['snapshot_digest']}
            op_id = str(uuid.uuid4())
            plan = dispatcher.plan(section_write, args, op_id=op_id)
            approval = sign_approval(mint_approval(dispatcher.descriptor(section_write, args), args, base, target_identity=plan.target_identity), 'Rename this disposable section.', channel='driver')
            from privacy.executor_wire import _source_vault_path
            for path in (Path(_source_vault_path()), Path(_source_vault_path() + '.key')):
                assert path.is_relative_to(root)
                if path.exists():
                    path.unlink()
            learner_row = {'id': 18, 'name': 'Bram Sample', 'email': 'bram@example.test'}
            provider_state['cm'][0]['name'] = 'Essay by Bram Sample'
            current = dispatcher.dispatch(read_key, {'course_id': 2}, op_id=str(uuid.uuid4()))
            check('new_learner_receives_reissued_label', 'Student A1' in json.dumps(current) and 'Bram Sample' not in json.dumps(current))
            no_effect('old_approval_reissued_label_refused', lambda: dispatcher.dispatch(section_write, args, op_id=op_id, plan=plan, approval=approval, require_educator_channel=False))
    report['passed'] = True
except Exception as exc:
    report['passed'] = False
    report['error_type'] = type(exc).__name__
    raise
finally:
    if ui_helper:
        ui_helper.shutdown()
        ui_helper.server_close()
    if helper:
        helper.shutdown()
        helper.server_close()
    if browser:
        browser.launcher.stop()
    if provider:
        provider.shutdown()
        provider.server_close()
    if scratch:
        scratch.cleanup()
    report['checked_at_utc'] = datetime.now(timezone.utc).isoformat()
    OUT.write_text(json.dumps(report, indent=2) + '\n')
