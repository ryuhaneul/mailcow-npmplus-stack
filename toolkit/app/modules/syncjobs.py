"""Sync Job batch management module."""

import csv
import io

from flask import Blueprint, render_template, request, jsonify
from auth import auth_required
from mailcow_api import MailcowAPI

bp = Blueprint("syncjobs", __name__, template_folder="../templates")


@bp.route("/")
@auth_required
def index():
    return render_template("syncjobs.html")


@bp.route("/api/list")
@auth_required
def api_list():
    api = MailcowAPI()
    jobs = api.get_syncjobs()
    return jsonify(jobs)


@bp.route("/api/detail/<int:job_id>")
@auth_required
def api_detail(job_id):
    api = MailcowAPI()
    job = api.get_syncjob(job_id)
    return jsonify(job)


@bp.route("/api/batch_create", methods=["POST"])
@auth_required
def api_batch_create():
    """Create multiple sync jobs at once.

    Expected JSON body:
    {
      "host1": "mail.old-server.com",
      "port1": "993",
      "enc1": "SSL",
      "accounts": [
        {"user1": "src@old.com", "password1": "pass", "username": "dest@new.com"},
        ...
      ]
    }
    """
    data = request.json
    host1 = data["host1"]
    port1 = data.get("port1", "993")
    enc1 = data.get("enc1", "SSL")
    accounts = data["accounts"]

    api = MailcowAPI()
    results = []
    for acct in accounts:
        job_data = {
            "host1": host1,
            "port1": port1,
            "enc1": enc1,
            "user1": acct["user1"],
            "password1": acct["password1"],
        }
        try:
            result = api.add_syncjob(acct["username"], job_data)
            results.append({
                "user1": acct["user1"],
                "username": acct["username"],
                "success": True,
                "result": result,
            })
        except Exception as e:
            results.append({
                "user1": acct["user1"],
                "username": acct["username"],
                "success": False,
                "error": str(e),
            })

    return jsonify({
        "total": len(accounts),
        "success": sum(1 for r in results if r["success"]),
        "failed": sum(1 for r in results if not r["success"]),
        "results": results,
    })


@bp.route("/api/parse_csv", methods=["POST"])
@auth_required
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
@auth_required
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
@auth_required
def api_delete():
    data = request.json
    ids = data["ids"]
    api = MailcowAPI()
    result = api.delete_syncjobs(ids)
    return jsonify(result)
