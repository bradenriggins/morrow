"""A read-only probe must not rely on a nonexistent mutation target."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, sys.argv[1])
from moodle.probe import probe_function, FUNCTION_SET
from moodle.session import MoodleSession, SafeRedirectSession

state = {'writes': 0}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))[0]
        if req['methodname'] in ('mod_forum_add_discussion', 'mod_forum_delete_discussion'):
            state['writes'] += 1
        data = json.dumps([{'error': False, 'data': {'id': 999999999}}]).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ['MOODLE_BASE_ALLOW_HTTP'] = '1'
report = {}
try:
    with tempfile.TemporaryDirectory(prefix='morrow-probe-e2e-') as root:
        sess = MoodleSession('http://127.0.0.1:%d' % server.server_port,
                             SafeRedirectSession(), 'DUMMY', journal_dir=root)
        result = probe_function(sess, 'mod_forum_add_discussion',
                                {'forumid': 999999999, 'subject': 'probe', 'message': 'probe'})
        report['write_calls'] = state['writes']
        report['direct_write_probe_refused_before_provider'] = state['writes'] == 0
        report['default_probe_set_has_no_writes'] = not any(
            fn in ('mod_forum_add_discussion', 'mod_forum_delete_discussion') for fn, _, _ in FUNCTION_SET)
        report['classification'] = result.get('signal')
        read = probe_function(sess, 'core_course_get_enrolled_courses_by_timeline_classification',
                              {'classification': 'all'})
        report['known_read_still_probed'] = read.get('ajax') is True and state['writes'] == report['write_calls']
finally:
    server.shutdown()
    Path(sys.argv[2]).write_text(json.dumps(report, indent=2) + '\n')
assert report['direct_write_probe_refused_before_provider'] and report['default_probe_set_has_no_writes'] and report['known_read_still_probed'], report
