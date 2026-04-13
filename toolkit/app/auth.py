"""Authentication middleware.

For v1: toolkit is served behind Mailcow nginx on the same domain.
We verify authentication by checking that the Mailcow API key in config is valid.
The toolkit session tracks whether the user has passed the login check.

Future: per-user auth via Mailcow session cookie validation.
"""

from functools import wraps
from flask import redirect, session, request, url_for


def auth_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if session.get("authenticated"):
            return f(*args, **kwargs)
        return redirect(url_for("login", next=request.path))
    return decorated
