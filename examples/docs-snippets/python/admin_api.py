"""The first call shown in docs/admin-api.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""

# #region first-call
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]  # server-side only

request = urllib.request.Request(
    f"{API_URL}/v1/admin/users?size=10",
    headers={"Authorization": f"Bearer {SECRET_KEY}"},
)
with urllib.request.urlopen(request) as response:
    users = json.load(response)
# #endregion
