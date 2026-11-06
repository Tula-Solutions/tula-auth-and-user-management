"""The admin API calls shown in docs/self-host.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]


def read_settings():
    # #region self-host-settings-read
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/settings",
        headers={"Authorization": f"Bearer {SECRET_KEY}"},
        method="GET",
    )
    with urllib.request.urlopen(request) as response:
        etag = response.headers["ETag"]  # '"0"'
        document = json.load(response)  # {"revision": 0, "settings": {"version": 1, …}}
    # #endregion
    return etag, document


def replace_settings(etag):
    # #region self-host-settings-replace
    body = {
        "app": {"name": "Acme", "supportEmail": "help@acme.example"},
        "urls": {"allowedOrigins": ["https://app.acme.example"]},
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/settings",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
            "If-Match": etag,
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def reset_factors(user_id):
    # #region self-host-reset-factors
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/users/{user_id}/factors",
        headers={"Authorization": f"Bearer {SECRET_KEY}"},
        method="DELETE",
    )
    with urllib.request.urlopen(request) as response:
        can_still_sign_in = response.headers["x-tula-can-still-sign-in"]
    # #endregion
    return can_still_sign_in


def verify_session(cookie):
    # #region self-host-verify-session
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/sessions/verify",
        data=json.dumps({"token": cookie}).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        claims = json.load(response)
    # #endregion
    return claims


def end_sessions(user_id):
    # #region self-host-revoke-sessions
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/users/{user_id}/sessions",
        headers={"Authorization": f"Bearer {SECRET_KEY}"},
        method="DELETE",
    )
    urllib.request.urlopen(request).close()
    # #endregion
