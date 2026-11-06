"""The user import calls shown in docs/user-import.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]


def import_users():
    # #region user-import
    body = {
        "users": [
            {
                "email": "maya@northline.app",
                "emailVerified": True,
                "name": "Maya Chen",
                "externalId": "auth0|64f1",
                "metadata": {"plan": "team"},
                "password": {"algorithm": "bcrypt", "hash": "$2b$10$…"},
            }
        ]
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/users/import",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        results = json.load(response)["results"]
    # #endregion
    return results


def import_firebase_users():
    # #region user-import-firebase
    body = {
        "firebaseScrypt": {
            "signerKey": "<base64_signer_key>",
            "saltSeparator": "<base64_salt_separator>",
            "rounds": 8,
            "memCost": 14,
        },
        "users": [
            {
                "email": "maya@northline.app",
                "emailVerified": True,
                "password": {
                    "algorithm": "firebase_scrypt",
                    "hash": "<passwordHash>",
                    "params": {"salt": "<salt>"},
                },
            }
        ],
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/users/import",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        results = json.load(response)["results"]
    # #endregion
    return results
