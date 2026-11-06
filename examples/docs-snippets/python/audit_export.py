"""The audit export calls shown in docs/audit-export.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]


def since_january():
    # #region audit-export-since
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/audit-logs/export",
        data=json.dumps({"format": "csv", "from": "2026-01-01T00:00:00Z"}).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        csv = response.read().decode()
    # #endregion
    return csv


def connection_changes():
    # #region audit-export-organization
    body = {
        "format": "csv",
        "organizationId": "<org id>",
        "action": "sso_connection.updated",
        "from": "2026-07-01T00:00:00Z",
        "to": "2026-10-01T00:00:00Z",
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/audit-logs/export",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        csv = response.read().decode()
    # #endregion
    return csv
