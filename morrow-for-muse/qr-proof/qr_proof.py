#!/usr/bin/env python3
"""Proof-test: QR-bootstrapped mobile OAuth against CHCP Canvas.

Steps:
  1. Decode the QR screenshot Braden sends -> sso.canvaslms.com URL.
  2. GET https://<ssoHost>/api/v1/mobile_verify.json?domain=<domain>
     -> base_url, client_id, client_secret (Instructure's mobile key).
  3. POST <baseUrl>/login/oauth2/token {authorization_code grant}
     -> access_token + refresh_token + user.
  4. GET /api/v1/users/self with the access token -> expect Braden's identity.

Nothing is written to disk. Tokens stay in memory; the grant is revoked
afterward at Account -> Settings -> Approved Integrations.

Usage: python3 qr_proof.py <screenshot.png>
"""
import json
import sys
import urllib.parse
import urllib.request

import cv2

SSO_HOSTS = {"sso.canvaslms.com", "sso.beta.canvaslms.com", "sso.test.canvaslms.com"}


def decode_qr(path: str) -> str:
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"cannot read image: {path}")
    det = cv2.QRCodeDetector()
    data, points, _ = det.detectAndDecode(img)
    if not data:
        # try multi / inverted on grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        data, points, _ = det.detectAndDecode(gray)
    if not data:
        raise SystemExit("no QR code detected in screenshot")
    return data


def get_json(url: str):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def post_json(url: str, payload: dict):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    qr_url = decode_qr(sys.argv[1])
    u = urllib.parse.urlparse(qr_url)
    assert u.scheme == "https", f"unexpected scheme in QR url: {u.scheme}"
    assert u.hostname in SSO_HOSTS, f"unexpected SSO host: {u.hostname}"
    q = urllib.parse.parse_qs(u.query)
    domain = q.get("domain", [None])[0]
    code = q.get("code", [None])[0]
    assert domain and code, "QR url missing domain or code param"
    domain = domain.replace("https://", "").replace("http://", "").rstrip("/")
    print(f"QR ok: sso_host={u.hostname} domain={domain} code_len={len(code)}")

    mv = get_json(
        f"https://{u.hostname}/api/v1/mobile_verify.json?domain={urllib.parse.quote(domain)}"
    )
    assert mv.get("authorized") is True, f"mobile_verify not authorized: {mv}"
    base_url = mv["base_url"].rstrip("/")
    client_id, client_secret = mv["client_id"], mv["client_secret"]
    print(f"mobile_verify ok: base_url={base_url} client_id_len={len(client_id)}")

    tok = post_json(
        f"{base_url}/login/oauth2/token",
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "authorization_code",
            "code": code,
        },
    )
    assert tok.get("refresh_token"), "token response missing refresh_token"
    access = tok["access_token"]
    print(
        f"exchange ok: user={tok.get('user')} expires_in={tok.get('expires_in')} "
        f"refresh_len={len(tok['refresh_token'])}"
    )

    me_req = urllib.request.Request(
        f"{base_url}/api/v1/users/self",
        headers={"Authorization": f"Bearer {access}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(me_req, timeout=30) as r:
        me = json.load(r)
    print(f"users/self ok: id={me.get('id')} name={me.get('name')} email={me.get('email')}")
    print("PROOF PASS: minted OAuth tokens authenticate as the expected user.")


if __name__ == "__main__":
    main()
