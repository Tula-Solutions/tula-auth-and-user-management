"""The native app calls shown in docs/native-apps.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]


def register_ios_app():
    # #region native-app-register
    body = {"platform": "ios", "teamId": "A1B2C3D4E5", "bundleId": "app.northline.ios"}
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/native-apps",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        app = json.load(response)
    # #endregion
    return app


def set_link_paths(app_id):
    # #region native-app-link-paths
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/native-apps/{app_id}",
        data=json.dumps({"appLinkPaths": ["/oauth/callback"]}).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PATCH",
    )
    with urllib.request.urlopen(request) as response:
        app = json.load(response)
    # #endregion
    return app
