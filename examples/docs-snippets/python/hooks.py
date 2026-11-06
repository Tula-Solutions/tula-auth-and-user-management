"""The hook call shown in docs/hooks.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]


def register_hook():
    # #region hook-register
    body = {
        # `before_sign_up`, `before_session` or `before_token`: one hook per point.
        "point": "before_sign_up",
        "url": "https://api.example.com/tula/before-sign-up",
        # Optional: 2000 unless given, at least 100, never more than 5000.
        "deadlineMs": 2000,
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/hooks",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        hook = json.load(response)
    # The only time the secret is returned: put it in your secret manager now.
    secret = hook["secret"]
    # #endregion
    return secret
