"""Bulk mailbox creation module."""

import secrets
import string

from flask import Blueprint, render_template, request, jsonify
from mailcow_api import MailcowAPI

bp = Blueprint("mailboxes", __name__, template_folder="../templates")


PASSWORD_ALPHABET = string.ascii_letters + string.digits + "!@#$%^&*-_=+"
PASSWORD_LENGTH = 20


def _gen_password():
    """Generate a random 20-char password (letters/digits/symbols)."""
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(PASSWORD_LENGTH))


def _mask(pw):
    if not pw:
        return ""
    return pw[:2] + "*" * max(0, len(pw) - 2)


@bp.route("/")
def index():
    return render_template("mailboxes.html")


@bp.route("/api/parse_csv", methods=["POST"])
def api_parse_csv():
    """Parse CSV text into mailbox spec list.

    Format per line: email,password,name,quota_mb
    Empty password -> generated later. Empty name -> local_part.
    Empty quota -> 2048 (handled at create time).
    """
    text = request.json.get("text", "")
    items = []

    for line in text.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        if "\t" in line:
            parts = line.split("\t")
        else:
            parts = line.split(",")
        parts = [p.strip() for p in parts]

        if not parts or "@" not in parts[0]:
            continue

        email = parts[0]
        password = parts[1] if len(parts) > 1 else ""
        name = parts[2] if len(parts) > 2 else ""
        quota_mb = parts[3] if len(parts) > 3 else ""

        items.append({
            "email": email,
            "password": password,
            "name": name,
            "quota_mb": quota_mb,
        })

    return jsonify(items)


@bp.route("/api/batch_create", methods=["POST"])
def api_batch_create():
    """Bulk create mailboxes.

    Expected JSON body:
    {
      "auto_create_domain": true,
      "default_quota_mb": 2048,
      "items": [
        {"email": "u@d.com", "password": "", "name": "", "quota_mb": ""},
        ...
      ]
    }

    Empty password -> randomly generated. Plaintext passwords are returned in
    the response JSON but never written to server logs (only masked form is
    logged via printed errors).
    """
    data = request.json or {}
    auto_create_domain = bool(data.get("auto_create_domain", True))
    default_quota = int(data.get("default_quota_mb") or 2048)
    items = data.get("items", [])

    api = MailcowAPI()

    # Cache existing domains and per-domain mailbox lists to avoid repeated
    # full scans during a single batch.
    domain_cache = {}
    mailbox_cache = {}

    def _domain_known(d):
        d = d.lower()
        if d not in domain_cache:
            domain_cache[d] = api.domain_exists(d)
        return domain_cache[d]

    def _mailbox_known(email):
        email = email.lower()
        local, _, dom = email.partition("@")
        if dom not in mailbox_cache:
            mailbox_cache[dom] = {
                (m.get("username") or "").lower()
                for m in api.get_mailboxes_by_domain(dom)
            }
        return email in mailbox_cache[dom]

    results = []
    for raw in items:
        email = (raw.get("email") or "").strip()
        password = (raw.get("password") or "").strip()
        name = (raw.get("name") or "").strip()
        quota_raw = str(raw.get("quota_mb") or "").strip()

        result = {
            "email": email,
            "password": "",
            "generated": False,
            "domain_created": False,
            "success": False,
            "error": None,
        }

        if "@" not in email:
            result["error"] = "invalid email"
            results.append(result)
            continue

        local_part, _, domain = email.partition("@")
        domain = domain.lower()

        try:
            quota_mb = int(quota_raw) if quota_raw else default_quota
        except ValueError:
            result["error"] = f"invalid quota_mb: {quota_raw}"
            results.append(result)
            continue

        if not password:
            password = _gen_password()
            result["generated"] = True
        result["password"] = password

        try:
            if not _domain_known(domain):
                if not auto_create_domain:
                    raise RuntimeError(f"domain {domain} does not exist")
                api.add_domain(domain)
                domain_cache[domain] = True
                result["domain_created"] = True

            if _mailbox_known(email):
                raise RuntimeError("mailbox already exists")

            api.add_mailbox(
                local_part=local_part,
                domain=domain,
                password=password,
                name=name or local_part,
                quota_mb=quota_mb,
            )
            mailbox_cache.setdefault(domain, set()).add(email.lower())
            result["success"] = True
        except Exception as e:
            # Never write the plaintext password into server output.
            print(f"[mailboxes] create failed: {email} pw={_mask(password)}: {e}",
                  flush=True)
            result["error"] = str(e)

        results.append(result)

    return jsonify({
        "total": len(items),
        "success": sum(1 for r in results if r["success"]),
        "failed": sum(1 for r in results if not r["success"]),
        "results": results,
    })


@bp.route("/api/delete", methods=["POST"])
def api_delete():
    """Delete one or more mailboxes by email (used for cleanup)."""
    data = request.json or {}
    emails = data.get("emails", [])
    api = MailcowAPI()
    result = api.delete_mailbox(emails)
    return jsonify(result)
