#!/usr/bin/env python3
"""
Generate a VAPID keypair for Web Push.

Usage:
  python backend/scripts/generate_vapid.py
  python backend/scripts/generate_vapid.py --subject mailto:you@example.com
  python backend/scripts/generate_vapid.py --json
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from dataclasses import asdict, dataclass

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
except Exception as exc:  # pragma: no cover
    print(
        "Missing dependency: cryptography\n"
        "Install backend requirements first, then retry.",
        file=sys.stderr,
    )
    raise SystemExit(1) from exc


def b64url_no_pad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


@dataclass
class VapidKeypair:
    public_key: str
    private_key: str
    subject: str


def generate_vapid_keypair(subject: str) -> VapidKeypair:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    # VAPID private key: 32-byte raw scalar, base64url (no padding)
    priv_int = private_key.private_numbers().private_value
    priv_raw = priv_int.to_bytes(32, byteorder="big")
    private_b64 = b64url_no_pad(priv_raw)

    # VAPID public key: uncompressed EC point (65 bytes), base64url (no padding)
    pub_raw = public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    public_b64 = b64url_no_pad(pub_raw)

    return VapidKeypair(
        public_key=public_b64,
        private_key=private_b64,
        subject=subject,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate VAPID keypair")
    parser.add_argument(
        "--subject",
        default="mailto:admin@example.com",
        help="VAPID subject claim (default: mailto:admin@example.com)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print JSON output instead of dotenv lines",
    )
    args = parser.parse_args()

    pair = generate_vapid_keypair(subject=args.subject)

    if args.json:
        print(json.dumps(asdict(pair), indent=2))
        return 0

    print("# Add these to your backend environment (.env)")
    print("WEB_PUSH_ENABLED=true")
    print(f"WEB_PUSH_VAPID_PUBLIC_KEY={pair.public_key}")
    print(f"WEB_PUSH_VAPID_PRIVATE_KEY={pair.private_key}")
    print(f"WEB_PUSH_VAPID_SUBJECT={pair.subject}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())