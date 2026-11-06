"""The webhook endpoint call shown in docs/webhooks.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]


def register_webhook():
    # #region webhook-register
    body = {
        "url": "https://api.example.com/webhooks/tula",
        "eventTypes": ["user.created", "user.deleted", "session.reuse_detected"],
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/webhook-endpoints",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        endpoint = json.load(response)
    # The only time the secret is returned: put it in your secret manager now.
    secret = endpoint["secret"]
    # #endregion
    return secret
