import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, sys.argv[1])
from moodle.session import MoodleSession, MoodleLaneError, SafeRedirectSession

report = {"checks": {}}
state = {"writes": 0, "subject": "Actual subject"}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))[0]
        if request['methodname'] == 'fixture_write':
            state['writes'] += 1
            data = {"id": 71}
        else:
            data = [{"id": 71, "subject": state["subject"]}]
        body = json.dumps([{"error": False, "data": data}]).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ['MOODLE_BASE_ALLOW_HTTP'] = '1'
base = 'http://127.0.0.1:%d' % server.server_port

def check(name, condition):
    report['checks'][name] = bool(condition)

try:
    with tempfile.TemporaryDirectory(prefix='morrow-readback-e2e-') as root:
        session = MoodleSession(base, SafeRedirectSession(), 'DUMMY_KEY', journal_dir=root)
        plan = {"op_id": "fixture-mismatch", "tool": "fixture_write", "args": {},
                "verify": {"method": "fixture_read", "args": {},
                           "match": {"field": "subject", "value": "Expected subject"}}}
        try:
            session.write(plan)
        except MoodleLaneError as exc:
            check('mismatch_explicit_failure', exc.kind == 'verification')
        else:
            check('mismatch_explicit_failure', False)
        records = [json.loads(line) for line in Path(session.journal_path).read_text().splitlines()]
        check('failed_readback_journaled', records[-1]['verify']['status'] == 'FAILED')
        restored = MoodleSession(base, SafeRedirectSession(), 'DUMMY_KEY', journal_dir=root)
        try:
            restored.write(plan)
        except MoodleLaneError:
            check('restart_no_replay', state['writes'] == 1)
        else:
            check('restart_no_replay', False)
        invalid = dict(plan, op_id='fixture-malformed', verify={"method": "fixture_read", "match": {"value": None}})
        before = state['writes']
        try:
            session.write(invalid)
        except MoodleLaneError:
            check('malformed_match_before_write', state['writes'] == before)
        else:
            check('malformed_match_before_write', False)
        valid = dict(plan, op_id='fixture-valid', verify={"method": "fixture_read", "match": {"field": "subject", "value": "Actual subject"}})
        result = session.write(valid)
        check('valid_match_verified', result['verify']['status'] == 'verified')
        report['provider_writes'] = state['writes']
finally:
    server.shutdown()
    Path(sys.argv[2]).write_text(json.dumps(report, indent=2) + '\n')
assert all(report['checks'].values()), report
