"""The OAuth provider calls shown in docs/providers/*.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]


def set_apple():
    # #region apple
    with open("AuthKey_XXXXXXXXXX.p8") as file:
        key = file.read()
    body = {
        "clientId": "com.example.web",
        "teamId": "<team id>",
        "keyId": "<key id>",
        "privateKey": key,
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/apple",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def set_discord():
    # #region discord
    body = {
        "clientId": "<client id>",
        "clientSecret": "<client secret>",
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/discord",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def set_facebook():
    # #region facebook
    body = {
        "clientId": "<app id>",
        "clientSecret": "<app secret>",
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/facebook",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def set_github():
    # #region github
    body = {
        "clientId": "<client id>",
        "clientSecret": "<client secret>",
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/github",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def set_google():
    # #region google
    body = {
        "clientId": "<client id>.apps.googleusercontent.com",
        "clientSecret": "<client secret>",
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/google",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def set_google_additional_client_ids():
    # #region google-additional-client-ids
    body = {
        "clientId": "<web client id>.apps.googleusercontent.com",
        "additionalClientIds": [
            "<android client id>.apps.googleusercontent.com",
            "<ios client id>.apps.googleusercontent.com",
        ],
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/google",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def set_linkedin():
    # #region linkedin
    body = {
        "clientId": "<client id>",
        "clientSecret": "<client secret>",
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/linkedin",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def set_microsoft():
    # #region microsoft
    body = {
        "clientId": "<application (client) id>",
        "clientSecret": "<secret value>",
        "tenant": "organizations",
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/microsoft",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion


def set_x():
    # #region x
    body = {
        "clientId": "<client id>",
        "clientSecret": "<client secret>",
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/oauth-providers/x",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="PUT",
    )
    urllib.request.urlopen(request).close()
    # #endregion
