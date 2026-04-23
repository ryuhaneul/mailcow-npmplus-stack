"""Group management module.

Groups are implemented as Mailcow aliases with a naming convention:
- Group alias: `_group-<name>@<domain>` with comment containing `[toolkit:group:<display_name>]`
- Inbound aliases: regular aliases whose goto points to the group alias address
- Members: the goto field of the group alias (comma-separated mailbox addresses)
"""

from flask import Blueprint, render_template, request, jsonify
from mailcow_api import MailcowAPI

bp = Blueprint("groups", __name__, template_folder="../templates")

GROUP_TAG_PREFIX = "[toolkit:group:"
GROUP_ADDR_PREFIX = "_group-"


def _parse_groups(aliases):
    """Parse Mailcow aliases into toolkit group structures."""
    groups = {}
    inbound_map = {}  # group_address -> list of inbound alias addresses

    # First pass: identify group aliases by comment tag
    for a in aliases:
        comment = a.get("public_comment", "") or ""
        if comment.startswith(GROUP_TAG_PREFIX):
            display_name = comment[len(GROUP_TAG_PREFIX):-1]  # strip trailing ]
            goto = a.get("goto", "")
            members = [m.strip() for m in goto.split(",") if m.strip()]
            groups[a["address"]] = {
                "id": a["id"],
                "address": a["address"],
                "name": display_name,
                "members": members,
                "inbound": [],
            }

    # Second pass: find inbound aliases pointing to group addresses
    for a in aliases:
        comment = a.get("public_comment", "") or ""
        if comment.startswith(GROUP_TAG_PREFIX):
            continue
        goto = a.get("goto", "")
        for target in [t.strip() for t in goto.split(",")]:
            if target in groups:
                groups[target]["inbound"].append({
                    "id": a["id"],
                    "address": a["address"],
                })

    return list(groups.values())


@bp.route("/")
def index():
    return render_template("groups.html")


@bp.route("/api/list")
def api_list():
    api = MailcowAPI()
    aliases = api.get_aliases()
    groups = _parse_groups(aliases)
    return jsonify(groups)


@bp.route("/api/mailboxes")
def api_mailboxes():
    api = MailcowAPI()
    mailboxes = api.get_mailboxes()
    result = [{"username": m["username"], "name": m.get("name", "")}
              for m in mailboxes]
    return jsonify(result)


@bp.route("/api/create", methods=["POST"])
def api_create():
    data = request.json
    name = data["name"]
    domain = data["domain"]
    members = data.get("members", [])

    slug = name.lower().replace(" ", "-")
    group_address = f"{GROUP_ADDR_PREFIX}{slug}@{domain}"
    goto = ",".join(members) if members else ""
    comment = f"{GROUP_TAG_PREFIX}{name}]"

    api = MailcowAPI()
    result = api.add_alias(group_address, goto, comment=comment)
    return jsonify(result)


@bp.route("/api/update", methods=["POST"])
def api_update():
    data = request.json
    alias_id = data["id"]
    members = data.get("members", [])
    name = data.get("name")

    attr = {"goto": ",".join(members)}
    if name is not None:
        attr["public_comment"] = f"{GROUP_TAG_PREFIX}{name}]"

    api = MailcowAPI()
    result = api.edit_alias(alias_id, attr)
    return jsonify(result)


@bp.route("/api/delete", methods=["POST"])
def api_delete():
    data = request.json
    alias_id = data["id"]
    api = MailcowAPI()
    result = api.delete_alias(alias_id)
    return jsonify(result)


@bp.route("/api/add_inbound", methods=["POST"])
def api_add_inbound():
    """Create a new alias that forwards to a group address."""
    data = request.json
    address = data["address"]
    group_address = data["group_address"]

    api = MailcowAPI()
    result = api.add_alias(address, group_address)
    return jsonify(result)


@bp.route("/api/remove_inbound", methods=["POST"])
def api_remove_inbound():
    data = request.json
    alias_id = data["id"]
    api = MailcowAPI()
    result = api.delete_alias(alias_id)
    return jsonify(result)
