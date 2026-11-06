"""The SSO connection calls shown in docs/methods/sso.md, with the standard library only.

Copied by region (`bun run docs:generate`) and byte-compiled by the docs harness. Nothing here runs.
"""
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]


def create_oidc_connection():
    # #region sso-create-oidc
    body = {
        "organizationId": "<org id>",
        "name": "Acme Okta",
        "issuer": "https://acme.okta.com",
        "clientId": "<client id>",
        "clientSecret": "<client secret>",
        "domains": ["acme.com"],
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/sso-connections",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        connection = json.load(response)
    # #endregion
    return connection


def create_saml_connection():
    # #region sso-create-saml-url
    body = {
        "organizationId": "<org id>",
        "protocol": "saml",
        "name": "Acme Entra",
        "saml": {"metadataUrl": "https://login.example.com/acme/metadata"},
        "domains": ["acme.com"],
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/admin/sso-connections",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {SECRET_KEY}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        connection = json.load(response)
    # #endregion
    return connection
