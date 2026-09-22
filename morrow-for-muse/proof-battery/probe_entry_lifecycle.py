#!/usr/bin/env python3
"""One-off probe: Item Bank full lifecycle with entry association.

Disposable objects only; archives the bank at the end. Prints a JSON
summary of every step. Does NOT touch the catalog or admission policy.
"""
import json
import sys
import time

sys.path.insert(0, "/home/hatch/workspace/morrow-for-muse-deploy/transport")
# W4-P2-16: bare CDP(port) construction is refused; this probe attaches
# through the verified launcher (helper ProxyCDP or a private pipe
# browser). No TCP CDP exists.
from local_chromium import (
    ChromiumLauncher, default_binary, tree_cdp_port,
    tree_helper_profile_dir)
from item_bank_sdk import ItemBankSdk, build_disposable_choice_item

CANVAS_BASE = "https://chcp.instructure.com"
COURSE_ID = "89585"
TAG = "MORROW-PROBE-%s" % time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())

steps = []


def rec(op, status, note="", body=""):
    steps.append({"op": op, "status": status, "note": note, "body": str(body)[:400]})
    print("%-28s %s  %s" % (op, status, note), flush=True)


def main():
    # Sentinels first: launcher.start() itself can fail after spawning a
    # private browser, so the finalizer owns the whole lifecycle from
    # construction onward. Nothing outside the try can leak.
    launcher = None
    mode = None
    sdk = None
    bank_id = item_id = entry_id = None
    try:
        launcher = ChromiumLauncher(
            default_binary(), tree_helper_profile_dir(),
            cdp_port=tree_cdp_port())
        mode = launcher.start()
        cdp = launcher.cdp
        sdk = ItemBankSdk(cdp, CANVAS_BASE, COURSE_ID)
        # W4 hardening: the whole lifecycle runs inside try/finally so a
        # mid-run assert never leaks the SDK session or a private browser.
        sdk.launch()
        rec("sdk_launch", 200, "launched")

        st, body = sdk.request("POST", "/api/banks", {"bank": {"title": TAG + " bank"}})
        bank_id = (json.loads(body) or {}).get("id")
        rec("bank_create", st, "bank_id=%s" % bank_id)
        assert st in (200, 201) and bank_id, "bank create failed"

        item_title = TAG + " item"
        item_payload = build_disposable_choice_item(TAG + " item")
        st, body = sdk.request(
            "POST", "/api/banks/%s/items" % bank_id, item_payload)
        item_id = (json.loads(body) or {}).get("id")
        rec("item_create", st, "item_id=%s" % item_id)
        assert st in (200, 201) and item_id, "item create failed"

        st, body = sdk.request("GET", "/api/banks/%s/bank_entries" % bank_id)
        before = json.loads(body) if st == 200 else None
        rec("entries_before", st, "count=%s" % (len(before) if isinstance(before, list) else "?"))

        st, body = sdk.request(
            "POST", "/api/banks/%s/bank_entries" % bank_id,
            {"bank_entry": {"bank_id": bank_id, "entry_type": "Item",
                            "entry_id": item_id}})
        entry_id = None
        try:
            payload = json.loads(body)
            be = payload.get("bank_entry", payload)
            entry_id = be.get("id")
        except Exception:
            pass
        rec("entry_attach", st, "entry_id=%s" % entry_id, body)

        st, body = sdk.request("GET", "/api/banks/%s/bank_entries" % bank_id)
        after = json.loads(body) if st == 200 else []
        rec("entries_after_attach", st,
            "count=%d" % (len(after) if isinstance(after, list) else -1),
            body[:300] if isinstance(body, str) else "")

        entry = None
        if entry_id:
            st, body = sdk.request(
                "GET", "/api/banks/%s/bank_entries/%s" % (bank_id, entry_id))
            try:
                entry = json.loads(body)
            except Exception:
                entry = None
            title = ((entry or {}).get("entry") or {}).get("title")
            rec("entry_get", st, "title=%r" % title)

        new_body = "<p>%s item RENAMED</p>" % TAG
        st, body = sdk.request(
            "PATCH", "/api/banks/%s/items/%s" % (bank_id, item_id),
            {"item": {"item_body": new_body}})
        rec("item_patch_after_attach", st, "", body)

        if entry_id:
            st, body = sdk.request(
                "GET", "/api/banks/%s/bank_entries/%s" % (bank_id, entry_id))
            try:
                entry2 = json.loads(body)
            except Exception:
                entry2 = None
            body2 = ((entry2 or {}).get("entry") or {}).get("item_body")
            rec("entry_get_after_patch", st,
                "item_body=%r renamed=%s" % (body2, body2 == new_body))

        st, body = sdk.request(
            "DELETE", "/api/banks/%s/items/%s" % (bank_id, item_id))
        rec("item_delete_direct", st, "direct item DELETE probe", body)

        if entry_id:
            st, body = sdk.request(
                "DELETE", "/api/banks/%s/bank_entries/%s" % (bank_id, entry_id))
            rec("entry_delete", st, "bank entry removal", body)

        st, body = sdk.request("GET", "/api/banks/%s/bank_entries" % bank_id)
        gone = json.loads(body) if st == 200 else None
        rec("entries_after_delete", st,
            "count=%s" % (len(gone) if isinstance(gone, list) else "?"))

        st, body = sdk.request(
            "PATCH", "/api/banks/%s" % bank_id, {"bank": {"status": "archived"}})
        rec("bank_archive", st, "")

        st, body = sdk.request("GET", "/api/banks")
        banks = json.loads(body) if st == 200 else []
        ids = [str(b.get("id")) for b in banks] if isinstance(banks, list) else []
        rec("bank_list_verify_gone", st,
            "absent_from_list" if str(bank_id) not in ids else "STILL_PRESENT")

    finally:
        if sdk is not None:
            try:
                sdk.close()
            except Exception:
                pass
        # Never stop the helper's browser; only a private browser this
        # probe launched itself.
        if launcher is not None and mode == "launched":
            try:
                launcher.stop()
            except Exception:
                pass
    print(json.dumps({"tag": TAG, "bank_id": bank_id, "item_id": item_id,
                      "entry_id": entry_id, "steps": steps}, indent=1))


if __name__ == "__main__":
    main()
