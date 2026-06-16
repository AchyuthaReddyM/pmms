#!/usr/bin/env python3
"""
make_license.py — Issue a signed PMMS license key.

Reads tools/license_private.pem and signs a JSON payload with RSA-PSS / SHA-256.
Output is a single line you email to your customer:

    <base64(payload_json)>.<base64(signature)>

USAGE — interactive (prompts you for inputs)
--------------------------------------------
    pip install cryptography
    python tools/make_license.py

USAGE — non-interactive (scriptable)
------------------------------------
    python tools/make_license.py \
        --fingerprint abc123… \
        --expiry 2027-12-31 \
        --customer "Ways Automation" \
        --notes "Office testing batch"

Either way the script appends a row to tools/licenses_issued.csv so you have a
record of every key you've ever issued.
"""
import argparse
import base64
import csv
import datetime as dt
import getpass
import json
import os
import re
import sys

try:
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives import hashes, serialization
except ImportError:
    sys.exit("This script needs the 'cryptography' package. Run:\n    pip install cryptography")

HERE = os.path.dirname(os.path.abspath(__file__))
PRIV_PATH = os.path.join(HERE, "license_private.pem")
LOG_PATH  = os.path.join(HERE, "licenses_issued.csv")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def load_private_key():
    if not os.path.exists(PRIV_PATH):
        sys.exit(f"✗ Private key not found at {PRIV_PATH}. Run tools/make_keypair.py first.")
    with open(PRIV_PATH, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)


def sign_payload(priv, payload: dict) -> str:
    """Returns the license string '<b64(json)>.<b64(sig)>'."""
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_b64 = b64(payload_json)

    # Sign the BASE64-ENCODED payload bytes (matches what license.js verifies).
    signature = priv.sign(
        payload_b64.encode("ascii"),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                    salt_length=padding.PSS.MAX_LENGTH),
        hashes.SHA256(),
    )
    return f"{payload_b64}.{b64(signature)}"


def looks_like_fp(s: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{16,64}", s.strip()))


def looks_like_date(s: str) -> bool:
    try:
        dt.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def prompt(label, validator=None, default=None):
    while True:
        raw = input(f"{label}{' ['+default+']' if default else ''}: ").strip()
        if not raw and default is not None:
            raw = default
        if validator is None or validator(raw):
            return raw
        print(f"   ↑ that doesn't look right, try again.")


def main():
    ap = argparse.ArgumentParser(description="Issue a signed PMMS license key.")
    ap.add_argument("--fingerprint", help="32-hex-char machine fingerprint from PMMS.")
    ap.add_argument("--expiry", help="YYYY-MM-DD. Leave blank for perpetual.")
    ap.add_argument("--customer", default="", help="Customer/installation name.")
    ap.add_argument("--notes", default="", help="Free-text notes (kept in the license + your CSV log).")
    args = ap.parse_args()

    print("PMMS license generator")
    print("─" * 60)

    fp = args.fingerprint or prompt("Machine fingerprint", looks_like_fp)
    fp = fp.strip().lower()

    if args.expiry is not None:
        expiry = args.expiry.strip()
    else:
        expiry = prompt("Expiry (YYYY-MM-DD, blank = perpetual)",
                        lambda s: s == "" or looks_like_date(s),
                        default="")
    if expiry and not looks_like_date(expiry):
        sys.exit(f"✗ Bad expiry: {expiry!r}")

    customer = args.customer if args.customer is not None else prompt("Customer name (optional)", default="")
    notes    = args.notes if args.notes is not None else prompt("Notes (optional)", default="")

    payload = {
        "v": 1,
        "fp": fp,
        "iat": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if expiry:   payload["exp"]      = expiry
    if customer: payload["customer"] = customer
    if notes:    payload["notes"]    = notes

    priv = load_private_key()
    license_str = sign_payload(priv, payload)

    print()
    print("=" * 72)
    print("LICENSE KEY — copy the entire single line below to the customer:")
    print("=" * 72)
    print()
    print(license_str)
    print()
    print("=" * 72)
    print(f"Bytes: {len(license_str)} · Payload: {json.dumps(payload, separators=(',',':'))}")
    print()

    # Append to issued-licenses log so you have a paper trail.
    is_new = not os.path.exists(LOG_PATH)
    with open(LOG_PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if is_new:
            w.writerow(["issued_at_utc", "fingerprint", "expiry", "customer", "notes", "issued_by", "license_hash"])
        import hashlib
        lic_hash = hashlib.sha256(license_str.encode("ascii")).hexdigest()[:16]
        w.writerow([payload["iat"], fp, expiry or "perpetual", customer, notes, getpass.getuser(), lic_hash])

    print(f"Logged to {LOG_PATH}")


if __name__ == "__main__":
    main()
