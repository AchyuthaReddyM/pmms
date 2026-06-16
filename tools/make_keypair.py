#!/usr/bin/env python3
"""
make_keypair.py — Generate the PMMS licensing keypair (RUN ONCE).

Outputs two files in the same directory:
    license_private.pem   ← SECRET. Keep this on your machine only. DO NOT commit.
    license_public.pem    ← Safe to embed in the app. Paste into license.js.

The private key is what you'll use later to sign every license you issue.
The public key goes inside the .exe so the app can verify signatures but cannot
forge them.

USAGE
-----
    pip install cryptography
    python tools/make_keypair.py

Re-running this script OVERWRITES the existing keys. If you do that after
shipping a build, every license you've already issued becomes invalid.
"""
import os
import sys

try:
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
except ImportError:
    sys.exit("This script needs the 'cryptography' package. Run:\n    pip install cryptography")

HERE = os.path.dirname(os.path.abspath(__file__))
PRIV_PATH = os.path.join(HERE, "license_private.pem")
PUB_PATH  = os.path.join(HERE, "license_public.pem")


def main():
    if os.path.exists(PRIV_PATH):
        ans = input(f"⚠  {PRIV_PATH} already exists. Overwrite? Type 'yes' to confirm: ").strip().lower()
        if ans != "yes":
            print("Cancelled.")
            return

    print("Generating 2048-bit RSA keypair... (a couple of seconds)")
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub  = priv.public_key()

    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_pem = pub.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    with open(PRIV_PATH, "wb") as f:
        f.write(priv_pem)
    with open(PUB_PATH, "wb") as f:
        f.write(pub_pem)

    # Lock down the private key permissions on Unix-likes (best-effort on Windows).
    try:
        os.chmod(PRIV_PATH, 0o600)
    except Exception:
        pass

    print()
    print(f"✓ Private key written → {PRIV_PATH}")
    print(f"✓ Public key written  → {PUB_PATH}")
    print()
    print("=" * 72)
    print("NEXT STEP — paste this PUBLIC KEY into license.js:")
    print("=" * 72)
    print()
    print("Open  ./license.js")
    print("Find  const PUBLIC_KEY_PEM = `…`;")
    print("Replace the body (the part BETWEEN -----BEGIN----- and -----END-----)")
    print("with the body of license_public.pem.")
    print()
    print("--- license_public.pem contents ---")
    print(pub_pem.decode("utf-8").rstrip())
    print("--- end ---")
    print()
    print("Keep license_private.pem somewhere safe and OUT of git.")
    print("Anyone with the private key can forge unlimited PMMS licenses.")


if __name__ == "__main__":
    main()
