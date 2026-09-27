#!/usr/bin/env python3
"""Concurrent-consume race harness for the approval gate.

N processes consume the same signed approval at once; exactly one may
win (consume_approval is single-use under the consumed-set lock). Used
by dispatch/admission_selftest.py and dispatch/test_admission_race.py.

The worker lives at module level so it pickles under every
multiprocessing start method (spawn is the macOS default, forkserver
the Linux default from Python 3.14). Run it as its own interpreter
(`python3 -m dispatch.admission_race <record.json> <method> [n]`), so
a spawned child re-imports only this module, never a selftest body.
It uses the MORROW_HOME in the environment; a caller that points the
admission module at other paths (a hermetic selftest) passes them with
--set NAME=PATH for NAME in PATH_OVERRIDES.

Prints one JSON object: {"method", "results", "exitcodes"}.
"""

import json
import multiprocessing
import os
import sys

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE not in sys.path:
    sys.path.insert(0, _TREE)


PATH_OVERRIDES = ("APPROVALS_DIR", "CONSUMED_PATH", "SECRETS_DIR",
                  "SIGNING_KEY_PATH")


def consume_worker(start_event, record, results, overrides=None):
    """Wait for the start signal, consume the approval, report."""
    from dispatch import admission
    for name, value in (overrides or {}).items():
        if name in PATH_OVERRIDES:
            setattr(admission, name, value)
    start_event.wait()
    try:
        admission.consume_approval(record)
    except admission.ApprovalMismatch:
        results.put("lost")
    except Exception as exc:  # noqa: BLE001 - report, never crash
        results.put("error:%r" % (exc,))
    else:
        results.put("won")


def race(record, n=8, method=None, timeout=60, overrides=None):
    """Run n concurrent consumers of record; returns the report dict."""
    ctx = multiprocessing.get_context(method)
    start = ctx.Event()
    results = ctx.Queue()
    procs = [ctx.Process(target=consume_worker,
                         args=(start, record, results, overrides))
             for _ in range(n)]
    for proc in procs:
        proc.start()
    start.set()
    for proc in procs:
        proc.join(timeout)
    outcomes = []
    for _ in range(n):
        try:
            outcomes.append(results.get(timeout=5))
        except Exception:  # noqa: BLE001 - a missing report is a failure
            outcomes.append("missing")
    return {"method": ctx.get_start_method(),
            "results": sorted(outcomes),
            "exitcodes": [proc.exitcode for proc in procs]}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    overrides = {}
    while "--set" in argv:
        i = argv.index("--set")
        name, _, value = (argv[i + 1] if i + 1 < len(argv) else "").partition("=")
        if name not in PATH_OVERRIDES or not value:
            sys.stderr.write("--set takes NAME=PATH for NAME in %s\n"
                             % ", ".join(PATH_OVERRIDES))
            return 2
        overrides[name] = value
        del argv[i:i + 2]
    if len(argv) not in (2, 3):
        sys.stderr.write("usage: python3 -m dispatch.admission_race "
                         "<record.json> <spawn|forkserver|fork> [n] "
                         "[--set NAME=PATH ...]\n")
        return 2
    with open(argv[0], "r", encoding="utf-8") as fh:
        record = json.load(fh)
    n = int(argv[2]) if len(argv) == 3 else 8
    print(json.dumps(race(record, n=n, method=argv[1],
                          overrides=overrides)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
