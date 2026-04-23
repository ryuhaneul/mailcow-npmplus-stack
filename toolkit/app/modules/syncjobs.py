"""Sync Job batch management module."""

import csv
import io

from flask import Blueprint, render_template, request, jsonify
from mailcow_api import MailcowAPI

bp = Blueprint("syncjobs", __name__, template_folder="../templates")


@bp.route("/")
def index():
    return render_template("syncjobs.html")


@bp.route("/api/list")
def api_list():
    api = MailcowAPI()
    jobs = api.get_syncjobs()
    return jsonify(jobs)


@bp.route("/api/detail/<int:job_id>")
def api_detail(job_id):
    api = MailcowAPI()
    job = api.get_syncjob(job_id)
    return jsonify(job)


@bp.route("/api/batch_create", methods=["POST"])
def api_batch_create():
    """Create multiple sync jobs at once.

    Expected JSON body:
    {
      "host1": "mail.old-server.com",
      "port1": "993",
      "enc1": "SSL",
      "auto_create_target": false,
      "default_quota_mb": 2048,
      "default_name": "",
      "accounts": [
        {"user1": "src@old.com", "password1": "pass", "username": "dest@new.com"},
        ...
      ]
    }

    If auto_create_target is true, missing destination domains/mailboxes are
    created on the fly. The mailbox password is set to the source password
    (password1) per fixed policy. Existing mailboxes are left untouched.
    """
    data = request.json
    host1 = data["host1"]
    port1 = data.get("port1", "993")
    enc1 = data.get("enc1", "SSL")
    accounts = data["accounts"]
    auto_create = bool(data.get("auto_create_target", False))
    default_quota = int(data.get("default_quota_mb") or 2048)
    default_name = (data.get("default_name") or "").strip()

    api = MailcowAPI()

    # Per-batch caches to avoid scanning all domains/mailboxes per account.
    domain_cache = {}
    mailbox_cache = {}

    def _domain_known(d):
        d = d.lower()
        if d not in domain_cache:
            domain_cache[d] = api.domain_exists(d)
        return domain_cache[d]

    def _mailbox_known(email):
        email = email.lower()
        _, _, dom = email.partition("@")
        if dom not in mailbox_cache:
            mailbox_cache[dom] = {
                (m.get("username") or "").lower()
                for m in api.get_mailboxes_by_domain(dom)
            }
        return email in mailbox_cache[dom]

    results = []
    for acct in accounts:
        username = acct["username"]
        password1 = acct["password1"]
        result = {
            "user1": acct["user1"],
            "username": username,
            "domain_created": False,
            "mailbox_created": False,
            "success": False,
        }

        try:
            if auto_create:
                if "@" not in username:
                    raise RuntimeError(f"invalid destination username: {username}")
                local_part, _, domain = username.partition("@")
                domain = domain.lower()

                if not _domain_known(domain):
                    api.add_domain(domain)
                    domain_cache[domain] = True
                    result["domain_created"] = True

                if not _mailbox_known(username):
                    api.add_mailbox(
                        local_part=local_part,
                        domain=domain,
                        password=password1,
                        name=default_name or local_part,
                        quota_mb=default_quota,
                    )
                    mailbox_cache.setdefault(domain, set()).add(username.lower())
                    result["mailbox_created"] = True

            job_data = {
                "host1": host1,
                "port1": port1,
                "enc1": enc1,
                "user1": acct["user1"],
                "password1": password1,
            }
            api.add_syncjob(username, job_data)
            result["success"] = True
        except Exception as e:
            result["error"] = str(e)

        results.append(result)

    return jsonify({
        "total": len(accounts),
        "success": sum(1 for r in results if r["success"]),
        "failed": sum(1 for r in results if not r["success"]),
        "results": results,
    })


@bp.route("/api/parse_csv", methods=["POST"])
def api_parse_csv():
    """Parse CSV text into account list.

    Accepts plain text with lines: user1,password1,username
    or: user1:password1:username
    """
    text = request.json.get("text", "")
    accounts = []

    for line in text.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        # Support both comma and colon delimiters
        if "\t" in line:
            parts = line.split("\t")
        elif "," in line and ":" not in line:
            parts = line.split(",")
        else:
            parts = line.split(":")

        if len(parts) >= 3:
            accounts.append({
                "user1": parts[0].strip(),
                "password1": parts[1].strip(),
                "username": parts[2].strip(),
            })
        elif len(parts) == 2:
            # user1:password1, assume username = user1
            accounts.append({
                "user1": parts[0].strip(),
                "password1": parts[1].strip(),
                "username": parts[0].strip(),
            })

    return jsonify(accounts)


@bp.route("/api/toggle", methods=["POST"])
def api_toggle():
    """Activate/deactivate sync jobs."""
    data = request.json
    ids = data["ids"]
    active = data["active"]

    api = MailcowAPI()
    results = []
    for job_id in ids:
        try:
            result = api.edit_syncjob(job_id, {"active": "1" if active else "0"})
            results.append({"id": job_id, "success": True})
        except Exception as e:
            results.append({"id": job_id, "success": False, "error": str(e)})

    return jsonify(results)


@bp.route("/api/delete", methods=["POST"])
def api_delete():
    data = request.json
    ids = data["ids"]
    api = MailcowAPI()
    result = api.delete_syncjobs(ids)
    return jsonify(result)
