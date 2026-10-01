"""Real helper proxy and disposable Chromium; trusted adapter staging only."""
import hashlib
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TREE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TREE))
OUT, BINARY, ASSETS = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]).resolve()
PUBLIC_STAGING = "--public-staging-only" in sys.argv[4:]
GOVERNED = "--governed-execution" in sys.argv[4:]
LEGACY_GOVERNED = "--legacy-governed" in sys.argv[4:]
report = {"scope": "public-page adapter staging only" if PUBLIC_STAGING else "private fixture staging and provider read", "test": "morrow.moodle-adapter-loader.real-helper.v1", "checks": {}, "provider_calls": 0}
fixture_mode = 'modern'
effect_mode = 'normal'
effects = 0
provider_state = {'course': {'id': 2, 'fullname': 'Fixture course'},
                  'section': [{'id': 10, 'number': 0, 'visible': True, 'hasrestrictions': False, 'component': None, 'cmlist': [19]}],
                  'cm': [{'id': 19, 'name': 'Essay by Aster Sample', 'module': 'page', 'sectionid': 10,
                          'visible': True, 'accessvisible': True, 'hascmrestrictions': False,
                          'allowstealth': True, 'stealth': False}]}

def check(name, value):
    report["checks"][name] = bool(value)
    assert value, name

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        report['fixture_gets'] = report.get('fixture_gets', 0) + 1
        course_page = '/course/view.php' in self.path or '/user/index.php' in self.path
        cfg = {'wwwroot': base, 'userId': 43 if fixture_mode == 'wrong_account' else 42,
               'sesskey': 'DUMMY_BROWSER_ONLY', 'currentlogin': 123456, 'courseId': 2 if course_page else 1,
               'courseContextId': 200}
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
        content = ('<!doctype html><body id="%s" class="course-%s"><h1>Fixture course</h1><script>M.cfg=%s;</script>%s</body>' %
                   (body_id, cfg['courseId'] if course_page else 2, json.dumps(cfg), footer)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'none'")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        global effects
        report["provider_calls"] += 1
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if '/admin/roles/check.php' in self.path:
            caps = ['moodle/site:accessallgroups', 'moodle/course:enrolreview', 'moodle/course:viewsuspendedusers', 'moodle/user:viewdetails']
            html = '<form method="post" action="%s/admin/roles/check.php?contextid=200"><select name="reportuser"><option selected value="42">Educator</option></select></form><table id="explaincaps">%s</table>' % (base, ''.join('<tr class="rolecap yes"><td><span class="cap-name">%s</span></td><td>Yes</td></tr>' % cap for cap in caps))
            payload = html.encode()
            content_type = 'text/html'
        else:
            call = json.loads(body)[0]
            method = call['methodname']
            if method == 'core_courseformat_get_state':
                data = json.dumps(provider_state)
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
                data = {'html': '<div data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants" data-table-uniqueid="user-index-participants-2" data-table-total-rows="1"><table><tr><td><input class="usercheckbox" name="user17"></td><td>Aster Sample</td><td>aster@example.test</td></tr></table></div>'}
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

helper = browser = provider = scratch = None
try:
    scratch = tempfile.TemporaryDirectory(prefix="morrow-adapter-loader-e2e-")
    tmp = scratch.name
    root = Path(tmp).resolve()
    for name in ("MORROW_USER_ID", "MORROW_CONVERSATION_ID", "LOGIN_HELPER_PRODUCTION", "LOGIN_HELPER_TLS_CERT", "LOGIN_HELPER_TLS_KEY"):
        os.environ.pop(name, None)
    os.environ.update(MORROW_HOME=str(root / 'state'), MORROW_TREE_STATE_DIR=str(root / 'tree'), MORROW_HELPER_ENV_FILE=str(root / 'empty-env'), LOGIN_HELPER_PROFILE_DIR=str(root / 'profile'), HELPER_AUTH_TOKEN='a' * 64, CHROMIUM_BIN=BINARY)
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
    base = 'https://127.0.0.1:%d/lms' % provider.server_port
    os.environ['CANVAS_BASE'] = 'https://sandbox.moodledemo.net'
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    with urllib.request.urlopen(base + '/', context=ssl._create_unverified_context(), timeout=3) as response:
        check('disposable_https_fixture_serves_html', response.status == 200 and b'Fixture course' in response.read())
    if PUBLIC_STAGING:
        base = 'https://sandbox.moodledemo.net'
    spec = importlib.util.spec_from_file_location('morrow_loader_helper_fixture', TREE / 'helper/server.py')
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    browser = server.HelperBrowser()
    browser.launcher.extra_args.extend(['--ignore-certificate-errors', '--disable-features=LocalNetworkAccessChecks'])
    browser.launcher.start()
    browser.cdp = browser.launcher.cdp
    browser.tab = browser.cdp.new_tab('about:blank')
    browser.cdp.call(browser.tab, 'Network.enable', {})
    try:
        report['fixture_navigation'] = browser.cdp.navigate(browser.tab, base + '/', timeout=10)
    except Exception:
        report['navigation_events'] = [{'method': e.get('method'), 'error': (e.get('params') or {}).get('errorText')} for e in browser.cdp.poll_session_events(browser.cdp.tab_session(browser.tab), timeout=1) if e.get('method') in ('Network.loadingFailed', 'Page.loadEventFired')]
        raise
    browser.base_url = base
    server.BROWSER = browser
    helper = server.BoundedThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    threading.Thread(target=helper.serve_forever, daemon=True).start()
    from transport.local_chromium import ProxyCDP
    proxy = ProxyCDP(browser.launcher.cdp_port, owner=browser.launcher, server_port=helper.server_port)
    tab = next(t for t in proxy.tabs() if t['id'] == browser.tab['id'])
    for _ in range(100):
        if proxy.evaluate(tab, 'location.href') == base + '/':
            break
        time.sleep(.05)
    check('real_authenticated_helper_proxy', proxy.evaluate(tab, '1 + 1') == 2)
    if PUBLIC_STAGING:
        check('permitted_public_provider_loaded', proxy.evaluate(tab, 'location.origin') == base)
    else:
        check('disposable_fixture_loaded', proxy.evaluate(tab, 'location.href') == base + '/')
    context = proxy.create_isolated_world(tab, 'morrow_adapter_loader_e2e')
    check('real_isolated_world', isinstance(context, int))
    report['source_hashes'] = {str(path.relative_to(TREE)): hashlib.sha256(path.read_bytes()).hexdigest() for path in (TREE / 'helper/server.py', TREE / 'transport/local_chromium.py', TREE / 'moodle/browser_operations.py', TREE / 'moodle/browser_transport.py', Path(__file__))}
    if GOVERNED:
        report['source_hashes']['moodle/dispatch.py'] = hashlib.sha256((TREE / 'moodle/dispatch.py').read_bytes()).hexdigest()
    from moodle.browser_operations import MoodleAdapterLoader
    registry = ASSETS / 'moodle-browser-routes.json'
    digest = hashlib.sha256(registry.read_bytes()).hexdigest()
    report['registry_sha256'] = digest
    loader = MoodleAdapterLoader(ASSETS, registry_sha256=digest)
    key_name = 'moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1'
    request = {'mode': 'execute', 'operation': {'key': key_name, 'toolName': 'moodle_list_my_courses', 'provider': 'moodle', 'readOnly': True}, 'binding': {'origin': base.split('/lms')[0], 'siteUrl': base, 'principalId': '42'}, 'arguments': {'limit': 100, 'offset': 0}, 'expiresAt': int(time.time() * 1000) + 60000}
    handle = loader.stage(proxy, tab, context, key_name, request, base_url=base)
    check('large_core_adapter_staged_under_proxy_limit', handle.function_sha256 == json.loads(registry.read_text())['operations'][key_name]['functionSha256'])
    check('staging_does_not_call_provider', report['provider_calls'] == 0)
    if not PUBLIC_STAGING:
        # Fixture-only identity seed. Production must derive this inside the browser.
        proxy.evaluate(tab, 'globalThis.M={cfg:%s}' % json.dumps({'wwwroot': base, 'userId': 42, 'sesskey': 'DUMMY_BROWSER_ONLY', 'courseId': 2}), context_id=context)
        result = proxy.evaluate(tab, 'globalThis[%s].fn(globalThis[%s].input)' % (json.dumps(handle.slot), json.dumps(handle.slot)), await_promise=True, context_id=context)
        check('shared_adapter_executes_through_strict_csp', result.get('ok') is True and result.get('data', {}).get('courses') == [{'id': '2', 'name': 'Fixture course'}])
        check('exactly_one_fixture_provider_call', report['provider_calls'] == 1)
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
    proxy.navigate(tab, base + '/?sesskey=DUMMY_URL_SECRET')
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
    proxy.navigate(tab, base + ('/login/index.php' if PUBLIC_STAGING else '/other'))
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
        write_id = str(uuid.uuid4())
        plan = dispatcher.plan(hide_key, args, op_id=write_id)
        entry = dispatcher.descriptor(hide_key, args)
        approval = sign_approval(mint_approval(entry, args, base, target_identity=plan.target_identity),
                                 'Hide this activity in this disposable fixture.', channel='driver')
        no_effect('driver_channel_refused_by_default', lambda: dispatcher.dispatch(hide_key, args, op_id=write_id, plan=plan, approval=approval))
        no_effect('changed_approved_arguments_refused', lambda: dispatcher.dispatch(hide_key, {**args, 'module_id': 20}, op_id=write_id, plan=plan, approval=approval))
        write_result = dispatcher.dispatch(hide_key, args, op_id=write_id, plan=plan, approval=approval, require_educator_channel=False)
        report['approved_write_result'] = write_result
        report['approved_write_journal'] = find_journal_op(write_id)
        check('approved_write_verified', write_result.get('ok') is True and write_result.get('verification', {}).get('status') == 'verified')
        check('exactly_one_approved_effect', effects == 1 and provider_state['cm'][0]['visible'] is False)
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
        check('all_governed_outputs_secret_free', 'DUMMY_BROWSER_ONLY' not in json.dumps([read_result, write_result, record]))
        report['fixture_effects'] = effects
    report['passed'] = True
except Exception as exc:
    report['passed'] = False
    report['error_type'] = type(exc).__name__
    raise
finally:
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
