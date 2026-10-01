"""Account pairing and governed Moodle operations in installed Chromium."""
import argparse
from contextlib import redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import uuid

TREE = Path(__file__).resolve().parents[1]
if str(TREE) not in sys.path:
    sys.path.insert(0, str(TREE))

from dispatch import admission, executor
from moodle.browser_transport import MoodleBrowserTransport
from moodle.dispatch import MoodleDispatcher
from moodle.contracts import normalize_moodle_base
from transport import local_chromium as lc


def _read_private(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 2 * 1024 * 1024:
            raise ValueError('Invalid private Moodle record')
        return json.loads(stream.read().decode('utf-8'))


def _create_private(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.moodle-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)


def _accounts():
    return Path(lc.tree_state_dir()) / 'moodle_accounts'


def _account(site=None):
    if site:
        base = normalize_moodle_base(site)
        paths = [_accounts() / (hashlib.sha256(base.encode()).hexdigest() + '.json')]
    else:
        paths = list(_accounts().glob('*.json'))
    if len(paths) != 1:
        raise ValueError('Select one paired Moodle site')
    record = _read_private(paths[0])
    if (record.get('schema') != 'morrow.moodle-account.v1' or
            normalize_moodle_base(record.get('site')) != record.get('site') or
            paths[0].stem != hashlib.sha256(record['site'].encode()).hexdigest() or
            not isinstance(record.get('principal_id'), str)):
        raise ValueError('Invalid paired Moodle account')
    return record


def _launcher():
    port = lc.tree_helper_port()
    launcher = lc.ChromiumLauncher(lc.default_binary(), lc.tree_helper_profile_dir(),
                                   cdp_port=lc.tree_cdp_port())
    # The public command must use the attended helper's exact profile.
    if not launcher._helper_serving(port):
        raise ValueError('Open the private sign-in helper first')
    launcher.start(attach_only=True)
    if not launcher.attached:
        raise ValueError('The private sign-in helper is unavailable')
    return launcher


def _dispatcher(transport):
    manifest = json.loads((TREE / 'pack/carve-manifest.json').read_text())
    pin = manifest['files']['moodle/browser-assets/moodle-browser-routes.json']
    return MoodleDispatcher(transport, TREE / 'moodle/browser-assets', registry_sha256=pin)


def _context(record, args):
    account = hashlib.sha256((record['site'] + '\n' + record['principal_id']).encode()).hexdigest()
    ctx = {'user_id': 'moodle:' + account}
    conversation = os.environ.get('MORROW_CONVERSATION_ID')
    if conversation:
        ctx['conversation_id'] = conversation
    if args.get('course_id') is not None:
        ctx['course_resolution'] = {'course_id': str(args['course_id']), 'confidence': 1.0}
    return ctx


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    pair = commands.add_parser('pair', help='pair one signed-in account; no course selection')
    pair.add_argument('--site', required=True)
    for name in ('status', 'courses', 'catalog', 'read', 'execute', 'plan', 'approve', 'mode', 'stage-file'):
        command = commands.add_parser(name)
        command.add_argument('--site')
        if name == 'stage-file':
            command.add_argument('--course-id', type=int, required=True)
            command.add_argument('--path', required=True)
            command.add_argument('--filename')
        if name == 'courses':
            command.add_argument('--offset', type=int, default=0)
            command.add_argument('--limit', type=int, default=100)
        if name in ('read', 'execute', 'plan'):
            command.add_argument('--operation', required=True)
            command.add_argument('--arguments', required=True, help='JSON arguments with the course ID')
            command.add_argument('--op-id', default=None)
        if name == 'execute':
            command.add_argument('--approval')
            command.add_argument('--plan')
        if name == 'approve':
            command.add_argument('--op-id', required=True)
            command.add_argument('--authorization', required=True, help="educator's exact approval reply")
        if name == 'mode':
            command.add_argument('action', choices=('status', 'set'))
            command.add_argument('value', nargs='?', choices=('plan', 'edit'))
    return parser


def _run(args):
    if args.command == 'pair':
        base = normalize_moodle_base(args.site)
        transport = MoodleBrowserTransport.discover(base, _launcher())
        record = {'schema': 'morrow.moodle-account.v1', 'site': base, 'principal_id': transport.principal_id}
        path = _accounts() / (hashlib.sha256(base.encode()).hexdigest() + '.json')
        try:
            _create_private(path, record)
            already = False
        except FileExistsError:
            if _account(base) != record:
                raise ValueError('The paired Moodle account changed')
            already = True
        return {'ok': True, **record, 'already_paired': already}
    record = _account(args.site)
    if args.command == 'mode':
        from settings.commands import mode_status, mode_set
        ctx = _context(record, {})
        if args.action == 'status':
            return mode_status(ctx['user_id'], ctx.get('conversation_id'))
        if args.value is None:
            raise ValueError('Select plan or edit mode')
        return mode_set(ctx['user_id'], args.value, ctx.get('conversation_id'))
    if args.command == 'catalog':
        transport = MoodleBrowserTransport(record['site'], type('Owner', (), {'cdp': None})(),
                                            principal_id=record['principal_id'])
        dispatcher = _dispatcher(transport)
        return {'ok': True, 'operations': [row for key, row in dispatcher.loader.definitions.items()
                if dispatcher.loader.operations[key]['inputKind'] == 'operation']}
    transport = MoodleBrowserTransport(record['site'], _launcher(), principal_id=record['principal_id'])
    if args.command == 'status':
        transport.identity()
        return {'ok': True, **record}
    dispatcher = _dispatcher(transport)
    if args.command == 'courses':
        result = dispatcher.dispatch('moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1',
            {'offset': args.offset, 'limit': args.limit}, op_id=str(uuid.uuid4()), mode_ctx=_context(record, {}))
        return {'ok': True, **result['data']} if result.get('ok') is True else result
    if args.command == 'stage-file':
        return dispatcher.stage_file(args.course_id, args.path, args.filename or Path(args.path).name)
    pending = Path(lc.tree_state_dir()) / 'moodle_pending'
    if args.command == 'approve':
        op_id = executor.check_uuid(args.op_id)
        prepared = _read_private(pending / (op_id + '.json'))
        if prepared['account'] != record:
            raise ValueError('The pending write belongs to another account')
        parameters = prepared['plan']['params']
        signed = admission.sign_approval(prepared['approval'], args.authorization, channel='educator-chat')
        result = dispatcher.dispatch(prepared['operation'], parameters, op_id=op_id,
            plan=executor.FrozenPlan(prepared['plan'], '<Moodle approved plan>'), approval=signed,
            mode_ctx=_context(record, parameters))
        return {**result, 'op_id': op_id}
    parameters = json.loads(args.arguments)
    if not isinstance(parameters, dict):
        raise ValueError('Moodle arguments must be an object')
    op_id = executor.check_uuid(args.op_id or str(uuid.uuid4()))
    args.op_id = op_id
    entry = dispatcher.descriptor(args.operation, parameters)
    if args.command == 'read' and entry['effects'] != 'read':
        raise ValueError('The read command cannot write')
    if args.command == 'plan':
        plan = dispatcher.plan(args.operation, parameters, op_id=op_id)
        subject = admission.request_subject(entry, parameters)
        data = {'op_id': op_id, 'entry_name': plan.entry_name, 'params': plan.params,
                'before_state_digest': plan.before_state_digest, 'frozen_readback': plan.frozen_readback,
                'target_identity': plan.target_identity, 'request': subject,
                'request_digest': admission.request_digest(subject)}
        if executor.digest_of(data) != plan.digest:
            raise ValueError('The frozen Moodle plan changed')
        approval = admission.mint_approval(entry, parameters, record['site'], target_identity=plan.target_identity)
        _create_private(pending / (op_id + '.json'), {'account': record, 'operation': args.operation,
                        'plan': data, 'approval': approval})
        definition = dispatcher.loader.definitions[args.operation]
        values = {key: value for key, value in parameters.items() if key not in ('expected_digest', 'course_id')}
        display = '%s in "%s" (course %s) on %s.\n\nValues:\n%s\n\nUndo is not declared for this operation. Approve this change in the chat to proceed.' % (
            definition['summary'], plan.target_identity['course_name'], plan.target_identity['course_id'],
            record['site'], json.dumps(values, ensure_ascii=False, indent=2))
        return {'ok': True, 'op_id': op_id, 'target': plan.target_identity,
                'review': display}
    plan = executor.load_frozen_plan(args.plan, entry['name']) if getattr(args, 'plan', None) else None
    approval = _read_private(Path(args.approval)) if getattr(args, 'approval', None) else None
    result = dispatcher.dispatch(args.operation, parameters, op_id=op_id, plan=plan, approval=approval,
                                 mode_ctx=_context(record, parameters))
    return {**result, 'op_id': op_id}


def main(argv=None):
    args = _parser().parse_args(argv)
    try:
        with redirect_stdout(sys.stderr):
            result = _run(args)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0 if result.get('ok') is True else 1
    except Exception as exc:
        try:
            op_id = executor.check_uuid(getattr(args, 'op_id', None))
        except Exception:
            op_id = None
        print(json.dumps({'ok': False, 'error': 'moodle_operation_not_confirmed',
                          'error_type': type(exc).__name__,
                          'op_id': op_id,
                          'recovery': 'Check the private sign-in helper, account, and arguments. Inspect the operation journal and provider state before retrying a change.'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
