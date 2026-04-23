"""Authentication middleware — delegates to Mailcow admin session.

Every request must carry a valid Mailcow MCSESSID cookie that maps to an
admin-role PHP session. Verification is performed by calling an internal
Mailcow endpoint that inspects the PHP session and returns 204 (admin ok)
or 403 (not admin / no session / expired). No local login flow exists —
Mailcow admin login is the only identity provider.
"""
import os
import requests
import urllib3
from flask import request

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

MAILCOW_INTERNAL_URL = os.environ.get(
    "MAILCOW_INTERNAL_URL",
    "https://nginx-mailcow:8443/inc/ajax/authz_toolkit_check.php",
)
VERIFY_TIMEOUT = float(os.environ.get("MAILCOW_AUTHZ_TIMEOUT", "2.0"))


def verify_admin_session() -> bool:
    cookie = request.headers.get("Cookie", "")
    if "MCSESSID=" not in cookie:
        return False
    # Forward the original browser's User-Agent. Mailcow's session layer stores
    # the UA at login and flags any request with a different UA as
    # "Form token invalid: User-Agent validation error". Without forwarding,
    # python-requests's default UA would poison the session on every check.
    forwarded_ua = request.headers.get("User-Agent", "")
    try:
        r = requests.get(
            MAILCOW_INTERNAL_URL,
            headers={
                "Cookie": cookie,
                "Sec-Fetch-Dest": "empty",
                "User-Agent": forwarded_ua,
            },
            timeout=VERIFY_TIMEOUT,
            allow_redirects=False,
            verify=False,
        )
    except requests.RequestException:
        return False
    return r.status_code == 204
