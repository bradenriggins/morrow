#!/usr/bin/env python3
"""Live proof battery: Item Banks SDK lane (transport/item_bank_sdk.py).

Disposable lifecycle on the Canvas sandbox course:
  bank create -> item create -> item GET readback (direct, anomalous) ->
  entries before attach -> bank-entry attach -> entries after attach ->
  entry GET readback -> item PATCH -> entry GET readback (rename) ->
  direct item DELETE probe -> bank-entry DELETE -> entries after delete
  (pre-archive absence readback) -> terminal item GET -> bank archive ->
  bank list verify gone.

Item CRUD follows the provider's two-phase model (item-banks-sdk.md):
the item object is created first, then attached to the bank with
POST /api/banks/{bank_id}/bank_entries; the entry GET is the working
item read path (direct item GET is provider-anomalous). Item removal
is DELETE /api/banks/{bank_id}/bank_entries/{entry_id} (204); the
absence readback is the entries list, taken before bank archive.

DO NOT RUN without a live educator session: the script fails fast when
the Canvas Login Helper reports logged_in:false. Nothing here cleans
the sandbox course; every object it creates is disposable and archived
at the end (bank archive is the provider's whole-bank delete).

Evidence: proof-battery/evidence/item_bank_sdk_battery_<stamp>.json
Stdlib only. Chromium is the only lane (verified launcher attach or a
private --remote-debugging-pipe browser; no TCP CDP).
"""

import datetime
import json
import os
import sys
import time
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
for _p in (_REPO, os.path.join(_REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# W4-P2-16: bare CDP(port) construction is refused. This battery runs
# as a same-tree Morrow process, so it attaches through the verified
# launcher: start() either binds the token-authenticated ProxyCDP to the
# serving helper (after the holder proof) or launches a private
# --remote-debugging-pipe browser. No TCP CDP exists in either mode.
from local_chromium import (  # noqa: E402
    ChromiumLauncher, default_binary, tree_cdp_port,
    tree_helper_profile_dir)
import item_bank_sdk as ibsdk  # noqa: E402

COURSE_ID = "89585"
HELPER_STATUS = "http://127.0.0.1:8901/status"
EVIDENCE_DIR = os.path.join(_HERE, "evidence")

STAMP = "MORROW-SDK-PROOF-" + datetime.datetime.now(
    datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def log(msg):
    print("[sdk-battery] %s" % msg, flush=True)


def check_session():
    """Fail fast when the helper reports a logged-out session."""
    try:
        with urllib.request.urlopen(HELPER_STATUS, timeout=10) as resp:
            status = json.load(resp)
    except Exception as exc:
        raise SystemExit("FATAL: helper status unreachable (%s)" % exc)
    if not status.get("logged_in"):
        raise SystemExit(
            "FATAL: helper reports logged_in:false; sign in through the "
            "Canvas Login Helper, then re-run")
    log("helper session live (logged_in:true)")


def main():
    check_session()
    # W4 hardening: validate CANVAS_BASE before touching the launcher
    # or the SDK, so a missing tenant fails before any browser attach
    # or launch attempt.
    canvas_base = os.environ.get("CANVAS_BASE")
    if not canvas_base:
        raise SystemExit("FATAL: set CANVAS_BASE to the educator's tenant "
                         "(no default; never hardcode a tenant)")
    launcher = ChromiumLauncher(
        default_binary(), tree_helper_profile_dir(),
        cdp_port=tree_cdp_port())
    mode = launcher.start()  # "attached" or "launched"; raises on a
    # foreign helper (holder proof), never adopts it
    cdp = launcher.cdp
    sdk = ibsdk.ItemBankSdk(cdp, canvas_base, COURSE_ID)
    rows = []
    evidence = {"stamp": STAMP, "course_id": COURSE_ID, "rows": rows}

    def rec(op, status, body, note=""):
        try:
            payload = json.loads(body) if body else None
        except ValueError:
            payload = None
        rows.append({"op": op, "status": status, "note": note,
                     "payload": payload,
                     "body_snip": (body or "")[:400]})
        log("%s -> %s %s" % (op, status, note))

    bank_id = None
    item_id = None
    try:
        # 1. Disposable bank.
        status, body = sdk.request(
            "POST", "/api/banks", {"bank": {"title": STAMP + " bank"}})
        payload = json.loads(body) if body else {}
        bank = payload.get("bank") if isinstance(payload, dict) else None
        bank_id = (bank or {}).get("id") if isinstance(bank, dict) \
            else payload.get("id")
        rec("bank_create", status, body, "bank_id=%s" % bank_id)
        if status != 201 or not bank_id:
            raise SystemExit("FATAL: no disposable bank; aborting")

        # 2. Item create (fields nested under top-level "item").
        status, body = sdk.create_item(
            bank_id, ibsdk.build_disposable_choice_item(
                "SDK proof question " + STAMP))
        payload = json.loads(body) if body else {}
        item = payload.get("item") if isinstance(payload, dict) else None
        item_id = (item or {}).get("id") if isinstance(item, dict) \
            else payload.get("id")
        rec("item_create", status, body, "item_id=%s" % item_id)
        created_ok = status in (200, 201) and item_id

        # 3. Item GET readback (direct; provider-anomalous on old lanes).
        pre_delete_get_status = None
        if created_ok:
            status, body = sdk.get_item(bank_id, item_id)
            pre_delete_get_status = status
            rec("item_get_readback", status, body,
                "direct GET " + ("answered" if status == 200 else "anomalous"))

            # 4. Bank entries before attach: the item object exists but is
            # not yet IN the bank (two-phase model, item-banks-sdk.md).
            status, body = sdk.request(
                "GET", "/api/banks/%s/bank_entries" % bank_id)
            try:
                before = json.loads(body) if body else []
            except ValueError:
                before = []
            rec("entries_before_attach", status, body,
                "count=%d" % (len(before) if isinstance(before, list) else -1))

            # 5. Attach the item to the bank (bank-entry association).
            status, body = sdk.request(
                "POST", "/api/banks/%s/bank_entries" % bank_id,
                {"bank_entry": {"bank_id": bank_id, "entry_type": "Item",
                                "entry_id": item_id}})
            entry_id = None
            try:
                payload = json.loads(body) if body else {}
                be = payload.get("bank_entry", payload) \
                    if isinstance(payload, dict) else {}
                entry_id = (be or {}).get("id")
            except ValueError:
                pass
            rec("entry_attach", status, body, "entry_id=%s" % entry_id)
            attached_ok = status in (200, 201) and entry_id

            # 6. Entries after attach: the association readback.
            status, body = sdk.request(
                "GET", "/api/banks/%s/bank_entries" % bank_id)
            try:
                after = json.loads(body) if body else []
            except ValueError:
                after = []
            after_ids = [str(e.get("id")) for e in after] \
                if isinstance(after, list) else []
            rec("entries_after_attach", status, body,
                "count=%d attached_entry_present=%s"
                % (len(after_ids), str(entry_id) in after_ids))

            # 7. Entry GET: the working item read path (IB-10).
            if attached_ok:
                status, body = sdk.request(
                    "GET", "/api/banks/%s/bank_entries/%s"
                    % (bank_id, entry_id))
                rec("entry_get_readback", status, body, "")

            # 8. Item update (PATCH, never PUT) against the attached item.
            new_body = "<p>SDK proof question RENAMED %s</p>" % STAMP
            status, body = sdk.update_item(
                bank_id, item_id, {"item": {"item_body": new_body}})
            rec("item_update", status, body, "")
            update_ok = status in (200, 201)

            # 9. Entry GET after update: the update readback (IB-18).
            renamed = False
            if attached_ok:
                status, body = sdk.request(
                    "GET", "/api/banks/%s/bank_entries/%s"
                    % (bank_id, entry_id))
                try:
                    entry = json.loads(body) if body else {}
                except ValueError:
                    entry = {}
                seen = ((entry or {}).get("entry") or {}).get("item_body")
                renamed = seen == new_body
                rec("entry_get_after_update", status, body,
                    "rename_match" if renamed else "rename_mismatch")

            # 10. Direct item DELETE probe (IB-19's route): provider-
            # anomalous on old lanes (404 on existing items); record the
            # SDK-lane answer and claim nothing from it.
            status, body = sdk.delete_item(bank_id, item_id)
            rec("item_delete_attempt", status, body,
                "direct DELETE route result; unclaimed until reviewed")

            # 11. Entry DELETE: the provider's item-removal route
            # (item-banks-sdk.md). 204 detaches the item from the bank.
            if attached_ok:
                status, body = sdk.request(
                    "DELETE", "/api/banks/%s/bank_entries/%s"
                    % (bank_id, entry_id))
                rec("entry_delete", status, body, "")

            # 12. Entries after entry delete: the pre-archive absence
            # readback (W3-P0-14 / Lane 5). The exact attached entry must
            # be gone from the provider's list before the bank archives.
            status, body = sdk.request(
                "GET", "/api/banks/%s/bank_entries" % bank_id)
            try:
                gone_list = json.loads(body) if body else []
            except ValueError:
                gone_list = []
            gone_ids = [str(e.get("id")) for e in gone_list] \
                if isinstance(gone_list, list) else []
            entry_gone = str(entry_id) not in gone_ids if attached_ok \
                else None
            rec("entries_after_delete", status, body,
                "count=%d attached_entry_absent=%s"
                % (len(gone_ids), entry_gone))

            # 13. Terminal direct item GET: kept for the anomalous-route
            # record. Interpreted against the pre-delete GET (step 3): a
            # 404 after a 404 is the provider-anomalous read, never a
            # delete proof. The delete proof is step 12's list absence.
            terminal_status, terminal_body = sdk.get_item(
                bank_id, item_id)
            if terminal_status == 404 and pre_delete_get_status == 200:
                terminal_note = "terminal_404_delete_confirmed"
            elif terminal_status == 404:
                terminal_note = "terminal_404_anomalous_route"
            else:
                terminal_note = "terminal_status_%s" % terminal_status
            rec("item_get_terminal", terminal_status, terminal_body,
                terminal_note)
    finally:
        # 7. Cleanup: archive the disposable bank (provider's whole-bank
        # delete), then confirm it left the live list.
        if bank_id:
            try:
                status, body = sdk.request(
                    "DELETE", "/api/banks/%s" % bank_id)
                rec("bank_archive_cleanup", status, body, "")
                time.sleep(2)
                status, body = sdk.request("GET", "/api/banks")
                gone = str(bank_id) not in (body or "")
                rec("bank_list_verify_gone", status, "",
                    "absent_from_list" if gone else "STILL_LISTED")
            except Exception as exc:  # noqa: BLE001 - cleanup must not mask
                rec("bank_archive_cleanup", -99, "",
                    "CLEANUP_ERROR %s" % exc)
        try:
            sdk.close()
        except Exception:  # noqa: BLE001
            pass
        # Never stop the helper's browser out from under it; only tear
        # down a private browser this battery launched itself.
        if mode == "launched":
            try:
                launcher.stop()
            except Exception:  # noqa: BLE001
                pass

    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    out_path = os.path.join(
        EVIDENCE_DIR, "item_bank_sdk_battery_%s.json" % STAMP)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, indent=1)
    log("evidence -> %s" % out_path)
    print(json.dumps({"evidence": out_path,
                      "rows": [(r["op"], r["status"], r["note"])
                               for r in rows]}, indent=1))


if __name__ == "__main__":
    main()
