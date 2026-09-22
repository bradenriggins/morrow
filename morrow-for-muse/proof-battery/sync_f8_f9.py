#!/usr/bin/env python3
"""Workstream C: catalog sync for F-8/F-9. Reads OPERATION_CATALOG.md, applies
battery evidence, recomputes the footer, writes the file back. Idempotent."""
import re, json, sys

CAT = '/home/hatch/workspace/morrow-for-muse-deploy/proof-battery/OPERATION_CATALOG.md'

# ---- load evidence ----
batt = {}
for line in open('/home/hatch/workspace/write-battery/MATRIX.md'):
    m = re.match(r'\| ([A-Z]+-\d+) \|', line)
    if m:
        parts = [p.strip() for p in line.split('|')]
        verdict = re.sub(r'\*', '', parts[5]).strip()
        batt[m.group(1)] = (verdict, parts[6])

PROVEN = {i for i, (v, _) in batt.items() if v == 'PROVEN'}
FAILED = {i for i, (v, _) in batt.items() if v == 'FAILED'}
assert len(PROVEN) == 89 and len(FAILED) == 27, (len(PROVEN), len(FAILED))

getres = json.load(open('/home/hatch/workspace/adversarial-get-battery/results_raw.json'))
getops = json.load(open('/home/hatch/workspace/adversarial-get-battery/ops.json'))
by_cat = {}
for r in getres:
    if r.get('status') == 200 and r['catalog'] not in by_cat:
        by_cat[r['catalog']] = (r['status'], r.get('shape', ''))
GET = {o['catalog']: by_cat[o['catalog']] for o in getops if o['catalog'] in by_cat}
# g14-6 (C-73 brand_variables): verified via browser navigation, not fetch (302 to
# CloudFront-hosted JSON; fetch blocked by CORS). Per REPORT.md it is VERIFIED.
GET['C-73'] = ('nav', 'CloudFront-hosted variables JSON (ic-brand-primary-*, etc.)')
assert len(GET) == 103, len(GET)

# provider does not serve the route at all -> unsupported
UNSUPPORTED = {'C-10', 'C-11', 'C-18', 'C-76', 'C-96', 'C-97', 'C-99',
               'C-101', 'C-123', 'C-175', 'C-404'}

C286_NOTE = ("2026-09-21 Chromium write battery: quiz-object create/update/delete "
    "PROVEN through the Chromium lane (provider path only). C-286: POST 200, quiz ids "
    "4045401/4045406/4045410/4045411. C-299: PATCH 200, readback title matched. C-289: "
    "DELETE 200, terminal GET 404. NOT proven: publish, question items on the quiz, "
    "the product pipeline. This supersedes the stale 2026-09-21 correction "
    "(401-under-quiz.build reading and the false 4045374 claim are retired).")

IB_LANE = {
    'IB-1':  'Proof lanes: quiz-api-token 2026-09-20 (bank lifecycle) and Chromium 2026-09-21 write battery (DELETE 204 archive, archived readback).',
    'IB-5':  'Proof lanes: quiz-api-token 2026-09-20 (bank lifecycle) and Chromium 2026-09-21 write battery (POST 201, banks 4053/4054/4055/4056).',
    'IB-16': 'Proof lanes: quiz-api-token 2026-09-20 (rename) and Chromium 2026-09-21 write battery (PATCH 200 rename 4053, readback title_match).',
    'IB-17': 'Proof lanes: quiz-api-token 2026-09-20 (shares 38922/38924) and Chromium 2026-09-21 write battery (POST 201 share 38934; PATCH 200 unshare; list verify clean).',
    'IB-9':  'Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane.',
    'IB-10': 'Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane.',
    'IB-12': 'Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane.',
    'IB-13': 'Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane.',
    'IB-15': 'Proof lane: quiz-api-token 2026-09-20 only. Not proven through the Chromium lane.',
}

changed = {'proven': 0, 'get': 0, 'failed': 0, 'unsupported': 0, 'ib_lane': 0}

def data_row(line):
    return bool(re.match(r'\| (C-\d+|IB-\d+|M-\d+|NQS-\d+) \|', line))

def append_note(parts, text):
    if text[:40] in parts[-1]:
        return False
    notes = parts[-1]
    sep = ' ' if notes and not notes.endswith(' ') else ''
    parts[-1] = notes + sep + text
    return True

out = []
for line in open(CAT).read().split('\n'):
    if not data_row(line):
        out.append(line)
        continue
    parts = [p.strip() for p in line.split('|')][1:-1]
    opid, status, notes = parts[0], parts[-2], parts[-1]

    if opid in PROVEN:
        ev = batt[opid][1]
        if opid == 'C-401':
            # Braden's exclusion (subaccount impact) stands; record the proof anyway
            if append_note(parts, '2026-09-21 Chromium write battery: %s. Stays excluded: Braden exclusion (affects subaccount).' % ev):
                changed['proven'] += 1
        elif opid in ('C-286', 'C-289', 'C-299'):
            parts[-2] = 'live-proven'
            if opid == 'C-286':
                if C286_NOTE not in parts[-1]:
                    parts[-1] = C286_NOTE
                    changed['proven'] += 1
            elif opid == 'C-289':
                if append_note(parts, '2026-09-21 Chromium write battery: DELETE 200, terminal GET 404. '
                    'Proof scope: quiz-object lifecycle only; publish and question items not proven (see C-286).'):
                    changed['proven'] += 1
            else:
                if append_note(parts, '2026-09-21 Chromium write battery: PATCH 200, readback title matched. '
                    'Proof scope: quiz-object lifecycle only; publish and question items not proven (see C-286).'):
                    changed['proven'] += 1
        else:
            parts[-2] = 'live-proven'
            if append_note(parts, '2026-09-21 Chromium write battery: %s.' % ev):
                changed['proven'] += 1
    elif opid in GET:
        st, shape = GET[opid]
        parts[-2] = 'live-proven'
        if st == 'nav':
            if append_note(parts, '2026-09-21 Chromium GET battery: VERIFIED via browser navigation (302 to %s); endpoint live with real data.' % shape):
                changed['get'] += 1
        else:
            if append_note(parts, '2026-09-21 Chromium GET battery: HTTP %d verified live (in-page fetch, CDP); body %s.' % (st, shape)):
                changed['get'] += 1
    elif opid in FAILED:
        ev = batt[opid][1]
        if opid in UNSUPPORTED:
            parts[-2] = 'unsupported'
            newnote = '2026-09-21 Chromium write battery: %s. Provider does not serve this route; moved to unsupported.' % ev
            if newnote[:40] not in parts[-1]:
                parts[-1] = newnote
                changed['unsupported'] += 1
        else:
            parts[-2] = 'failed'
            note = '2026-09-21 Chromium write battery FAILED: %s.' % ev
            if opid in ('IB-4', 'IB-6', 'IB-7', 'IB-18'):
                note += ' Supersedes the excluded quiz-api-token lane live-proven mark (Chromium is the only lane for Item Banks reads and writes).'
            if note[:40] not in parts[-1]:
                parts[-1] = note
                changed['failed'] += 1

    # IB lane reconciliation for rows not touched above
    if opid in IB_LANE and opid not in PROVEN and opid not in FAILED:
        if append_note(parts, IB_LANE[opid]):
            changed['ib_lane'] += 1
    # evidence-hold quiz_entries rows: battery confirmed the 401 hold
    if opid in ('IB-2', 'IB-3', 'IB-8', 'IB-14'):
        if append_note(parts, '2026-09-21 Chromium write battery BLOCKED: confirmed 401 (scope has no quiz_entries policy); hold stands.'):
            changed['ib_lane'] += 1

    out.append('| ' + ' | '.join(parts) + ' |')

text = '\n'.join(out)

# proof standard: add failed status
old_std = "Statuses: live-proven, pending, evidence-hold, unsupported, excluded, source-only."
new_std = ("Statuses: live-proven, pending, evidence-hold, unsupported, excluded, source-only, failed. "
    "failed means a disposable live battery attempted the operation and it did not succeed; "
    "the failure evidence is recorded in the notes and the op is not retried without a code or request-shape change.")
if old_std in text:
    text = text.replace(old_std, new_std)
assert new_std in text

# Moodle section context annotation
old_moodle = ("Reference: the desktop Moodle browser catalog (250 operations). Live proof: proofs/moodle-lane-proof.md "
    "(2026-09-20, sandbox.moodledemo.net, Moodle 5.2, teacher demo account). The sandbox resets hourly; production SSO "
    "variants and session lifetimes are unproven (proof section 6).")
new_moodle = (old_moodle + " Context 2026-09-21: the Moodle read battery (moodle-read-battery/MATRIX.md) enumerated "
    "352 registered external functions on sandbox.moodledemo.net (Moodle 5.2.3): 110 PROVEN / 65 FAILED / 177 BLOCKED "
    "over AJAX. The Moodle lane is out of v1, so catalog M-rows keep their existing statuses; this battery is context only, "
    "not per-op proof.")
if old_moodle in text:
    text = text.replace(old_moodle, new_moodle)
assert new_moodle in text

# recompute footer counts
def count(status_filter, prefix):
    n = 0
    for line in text.split('\n'):
        if data_row(line):
            parts = [p.strip() for p in line.split('|')][1:-1]
            st = parts[-2].split(' ')[0]  # strip [LEARNER-DATA] flag
            if st == status_filter and parts[0].startswith(prefix):
                n += 1
    return n

stats = ['live-proven', 'pending', 'failed', 'evidence-hold', 'unsupported', 'excluded', 'source-only']
canvas = {s: count(s, 'C-') + count(s, 'IB-') for s in stats}
moodle = {s: count(s, 'M-') for s in stats}
nqs_lp = count('live-proven', 'NQS-')
nqs_un = count('unsupported', 'NQS-')

old_table = re.search(r'## Counts by status\n\n(\|.*\n)+', text).group(0)
new_table = ("## Counts by status\n\n"
    "| Status | Canvas + Item Bank | Moodle lane | Total |\n"
    "|--------|------------------|-------------|-------|\n")
for s in stats:
    new_table += "| %s | %d | %d | %d |\n" % (s, canvas[s], moodle[s], canvas[s] + moodle[s])
new_table += "| New Quiz sequence rows | - | - | %d live-proven, %d unsupported |\n" % (nqs_lp, nqs_un)
text = text.replace(old_table, new_table)

open(CAT, 'w').write(text)
print("changed:", changed)
print("canvas+IB:", canvas)
print("moodle:", moodle)
print("nqs:", nqs_lp, "live-proven,", nqs_un, "unsupported")
