"""Shared access module.

Grants/revokes read-only (lookup, read) access to a mailbox's INBOX for another
mailbox, via mailcow dockerapi (doveadm acl). Folder and rights are fixed in
dockerapi.py; requests only choose owner and grantee, both of which must be
active mailboxes.
"""

from flask import Blueprint, render_template, request, jsonify
import dockerapi
from mailcow_api import MailcowAPI

bp = Blueprint("shares", __name__, template_folder="../templates")


def _active_mailboxes():
    return {m["username"]: m.get("name", "")
            for m in MailcowAPI().get_mailboxes()
            if str(m.get("active")) == "1"}


def _group_mailboxes():
    """Usernames of mailboxes with a distribution filter set up in mailcow's
    filter tab: an active prefilter whose script contains "redirect".

    This is a substring heuristic ("prefilter that mentions redirect"), not a
    precise detection of group mailboxes. Raises if the filter API fails or
    does not return a list.
    """
    filters = MailcowAPI().get_filters()
    if not isinstance(filters, list):
        raise ValueError("unexpected filters response from mailcow")
    return {f["username"] for f in filters
            if isinstance(f, dict) and f.get("username")
            and f.get("filter_type") == "prefilter"
            and str(f.get("active")) == "1"
            and "redirect" in str(f.get("script_data") or "")}


def _grantees(owner):
    """Grantees of owner's INBOX; get_acl also returns ACLs the owner received."""
    return sorted({e["id"] for e in dockerapi.get_acl(owner)
                   if e.get("user") == owner and e.get("mailbox") == dockerapi.MAILBOX})


def _error(msg, status):
    return jsonify({"error": msg}), status


@bp.route("/")
def index():
    return render_template("shares.html")


@bp.route("/api/mailboxes")
def api_mailboxes():
    try:
        boxes = _active_mailboxes()
    except Exception as e:
        return _error(str(e), 502)
    try:
        groups, groups_error = _group_mailboxes(), None
    except Exception as e:
        groups, groups_error = set(), str(e)
    return jsonify({
        "mailboxes": [{"username": u, "name": n, "group": u in groups}
                      for u, n in sorted(boxes.items())],
        "groups_error": groups_error,
    })


@bp.route("/api/grants")
def api_grants():
    owner = request.args.get("owner", "")
    try:
        if owner not in _active_mailboxes():
            return _error("unknown owner mailbox", 400)
        return jsonify({"owner": owner, "grantees": _grantees(owner)})
    except Exception as e:
        return _error(str(e), 502)


def _change(action):
    if not request.is_json:
        return _error("JSON body required", 400)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _error("JSON object required", 400)
    owner, grantee = data.get("owner"), data.get("grantee")
    if not isinstance(owner, str) or not isinstance(grantee, str):
        return _error("owner and grantee are required", 400)
    if owner == grantee:
        return _error("owner and grantee must differ", 400)
    try:
        boxes = _active_mailboxes()
        if owner not in boxes or grantee not in boxes:
            return _error("owner and grantee must be active mailboxes", 400)
        if action == "grant":
            dockerapi.set_acl(owner, grantee)
        else:
            dockerapi.delete_acl(owner, grantee)
        grantees = _grantees(owner)
    except Exception as e:
        return _error(str(e), 502)
    applied = (grantee in grantees) == (action == "grant")
    return jsonify({"owner": owner, "grantee": grantee, "grantees": grantees,
                    "applied": applied})


@bp.route("/api/grant", methods=["POST"])
def api_grant():
    return _change("grant")


@bp.route("/api/revoke", methods=["POST"])
def api_revoke():
    return _change("revoke")
