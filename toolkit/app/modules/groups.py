"""Team distribution module.

A team is a mailbox whose active prefilter has top-level
``redirect :copy "<address>";`` lines; each line is a member that receives a
copy. This module lists teams and adds/removes one member line at a time by
editing the filter script in mailcow (see sieve_dist for how scripts are read).

Every save is serialised by a file lock, written to an append-only backup
(before the mailcow call), checked against a fresh read just before saving, and
verified by reading the filter back afterwards. mailcow's own filter screen
can still change a script between that last read and the save; that window is
not closed.
"""

import fcntl
import json
import logging
import os
import uuid
from datetime import datetime, timezone

from flask import Blueprint, render_template, request, jsonify
import sieve_dist
from mailcow_api import MailcowAPI

bp = Blueprint("groups", __name__, template_folder="../templates")

BACKUP_SUBDIR = "filter-backups"
log = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def _error(status, code, message, **extra):
    return jsonify({"ok": False, "error": message, "code": code, **extra}), status


def _data_dir():
    return os.environ.get("TOOLKIT_DATA_DIR", "/data")


def _active_mailboxes():
    boxes = MailcowAPI().get_mailboxes()
    if not isinstance(boxes, list):
        raise ValueError("unexpected mailboxes response from mailcow")
    return {m["username"]: m.get("name", "") or ""
            for m in boxes
            if isinstance(m, dict) and m.get("username") and str(m.get("active")) == "1"}


def _filters():
    filters = MailcowAPI().get_filters()
    if not isinstance(filters, list):
        raise ValueError("unexpected filters response from mailcow")
    return [f for f in filters if isinstance(f, dict)]


def _active_prefilters(filters):
    """username -> list of active prefilters."""
    out = {}
    for f in filters:
        if f.get("username") and f.get("filter_type") == "prefilter" \
                and str(f.get("active")) == "1":
            out.setdefault(f["username"], []).append(f)
    return out


def _mentions_redirect(f):
    return "redirect" in str(f.get("script_data") or "").lower()


def _members_out(analysis, names):
    seen, out = set(), []
    for m in analysis.members:
        key = m.address.lower()
        if key not in seen:
            seen.add(key)
            out.append({"address": m.address, "name": names.get(m.address, "")})
    return out


def _team_view(filters, names):
    """(teams, forwards) from the mailcow filter list."""
    teams, forwards = [], []
    for user, fl in sorted(_active_prefilters(filters).items()):
        if len(fl) > 1:
            if any(_mentions_redirect(f) for f in fl):
                teams.append({"mailbox": user, "filter_id": None, "members": [],
                              "editable": False, "reason": "multiple_prefilters"})
            continue
        f = fl[0]
        a = sieve_dist.analyze(f.get("script_data"))
        if not a.parsed:
            if _mentions_redirect(f):
                teams.append({"mailbox": user, "filter_id": f.get("id"), "members": [],
                              "editable": False, "reason": "unparseable"})
            continue
        if a.members:
            reason = "stopper_before_member" if a.stopper_before_member else (
                "line_not_simple" if not a.members[-1].simple else "")
            teams.append({"mailbox": user, "filter_id": f.get("id"),
                          "members": _members_out(a, names),
                          "editable": not reason, "reason": reason})
        elif a.forwards:
            for to in a.forwards:
                forwards.append({"mailbox": user, "to": to})
    return teams, forwards


@bp.route("/")
def index():
    return render_template("groups.html")


@bp.route("/api/teams")
def api_teams():
    try:
        names = _active_mailboxes()
        teams, forwards = _team_view(_filters(), names)
    except Exception as e:
        return jsonify({"teams": [], "forwards": [], "mailboxes": [], "error": str(e)}), 502
    # active mailboxes are listed so the screen can offer them as new members
    return jsonify({"teams": teams, "forwards": forwards, "error": None,
                    "mailboxes": [{"address": u, "name": n} for u, n in sorted(names.items())]})


# -- writes -----------------------------------------------------------------

def _ensure_backup_dir():
    d = os.path.join(_data_dir(), BACKUP_SUBDIR)
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    return d


def _append_line(d, path, record):
    """Append one JSON line to path and fsync it. Raises on any failure."""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    dfd = os.open(d, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _team_filter(filters, team):
    fl = _active_prefilters(filters).get(team, [])
    if not fl:
        raise ApiError(400, "not_team", "that mailbox has no active prefilter")
    if len(fl) > 1:
        raise ApiError(400, "not_editable", "more than one active prefilter")
    return fl[0]


def _apply(action, team, address):
    """Run one add/remove. Returns (changed, members). Raises ApiError."""
    try:
        d = _ensure_backup_dir()
        lock_fd = os.open(os.path.join(d, ".lock"), os.O_WRONLY | os.O_CREAT, 0o600)
    except OSError as e:
        raise ApiError(500, "backup_failed", f"backup directory unavailable: {e}")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        return _apply_locked(action, team, address, d)
    finally:
        os.close(lock_fd)  # closing releases the flock


def _apply_locked(action, team, address, backup_dir):
    api = MailcowAPI()
    try:
        names = _active_mailboxes()
        filters = _filters()
    except Exception as e:
        raise ApiError(502, "mailcow_error", str(e))
    if team not in names:
        raise ApiError(400, "invalid_team", "team must be an active mailbox")
    if action == "add":
        if address not in names:
            raise ApiError(400, "not_active_mailbox", "address must be an active mailbox")
        if address.lower() == team.lower():
            raise ApiError(400, "invalid_address", "a team cannot be its own member")
    f = _team_filter(filters, team)
    before = f.get("script_data")
    try:
        edit = sieve_dist.add_member if action == "add" else sieve_dist.remove_member
        after, changed = edit(before, address)
    except sieve_dist.Refused as e:
        raise ApiError(500 if e.code == "self_check_failed" else 400, e.code, str(e))
    if not changed:
        return False, _members_out(sieve_dist.analyze(before), names)

    # 1. backup first; a failure here stops everything before mailcow is called
    op_id = uuid.uuid4().hex
    path = os.path.join(backup_dir, datetime.now(timezone.utc).strftime("%Y-%m") + ".jsonl")
    try:
        _append_line(backup_dir, path, {
            "id": op_id, "ts": _now(),
            "mailbox": team, "filter_id": f.get("id"), "action": action,
            "address": address, "before": before, "after": after,
        })
    except OSError as e:
        raise ApiError(500, "backup_failed", f"could not write backup: {e}")

    # 2-4. the attempt; a result line follows whatever happens (the backup line
    # alone does not mean the script was saved)
    result = "error"
    try:
        _save(api, f, team, before, after)
        result = "saved"
    except ApiError as e:
        if e.code == "conflict":
            result = "conflict"
        raise
    finally:
        try:
            _append_line(backup_dir, path, {"id": op_id, "result": result, "ts": _now()})
        except OSError:
            log.exception("could not write result line for filter backup %s", op_id)
    return True, _members_out(sieve_dist.analyze(after), names)


def _save(api, f, team, before, after):
    # re-read right before saving; refuse if the script moved underneath us
    try:
        again = _team_filter(_filters(), team)
    except ApiError:
        raise ApiError(409, "conflict", "changed elsewhere; reload and try again")
    except Exception as e:
        raise ApiError(502, "mailcow_error", str(e))
    if again.get("id") != f.get("id") or again.get("script_data") != before:
        raise ApiError(409, "conflict", "changed elsewhere; reload and try again")

    # save script_data only; keep description / active / type as they are
    attr = {"script_data": after}
    for k in ("script_desc", "active", "filter_type"):
        if f.get(k) is not None:
            attr[k] = str(f[k])
    try:
        api.edit_filter(f.get("id"), attr)
        check = _team_filter(_filters(), team)
    except ApiError:
        raise ApiError(502, "verify_failed", "saved filter could not be read back")
    except Exception as e:
        raise ApiError(502, "mailcow_error", str(e))

    # confirm what mailcow now holds is what we meant to save
    if check.get("script_data") != after:
        raise ApiError(502, "verify_failed", "saved filter does not match; check it in mailcow")


def _change(action):
    if not request.is_json:
        return _error(400, "json_required", "JSON body required")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _error(400, "json_required", "JSON object required")
    team, address = data.get("team"), data.get("address")
    if not isinstance(team, str) or not isinstance(address, str) or not team or not address:
        return _error(400, "invalid_input", "team and address are required")
    if action == "add" and not sieve_dist.ADDRESS_RE.match(address):
        return _error(400, "invalid_address", "invalid address")
    if action == "remove" and (len(address) > 254 or any(
            ch.isspace() or ch in '"\\' or ord(ch) < 32 for ch in address)):
        return _error(400, "invalid_address", "invalid address")
    try:
        changed, members = _apply(action, team, address)
    except ApiError as e:
        return _error(e.status, e.code, str(e))
    return jsonify({"ok": True, "changed": changed, "members": members, "error": None})


@bp.route("/api/add", methods=["POST"])
def api_add():
    return _change("add")


@bp.route("/api/remove", methods=["POST"])
def api_remove():
    return _change("remove")
