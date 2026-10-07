"""mailcow dockerapi client — dovecot ACL tasks only.

Only the three doveadm ACL tasks below are ever sent, only to the
dovecot-mailcow container, and only with the fixed INBOX / lookup+read values.
"""

import requests

DOCKERAPI_URL = "https://dockerapi:443"
DOVECOT_SERVICE = "dovecot-mailcow"
TIMEOUT = 10

# The only mailbox and rights this toolkit ever manages.
MAILBOX = "INBOX"
RIGHTS = ["lookup", "read"]


class DockerApiError(RuntimeError):
    pass


def _request(method, path, body=None):
    try:
        # dockerapi uses a self-signed certificate on the internal docker network
        r = requests.request(method, f"{DOCKERAPI_URL}{path}", json=body,
                             timeout=TIMEOUT, verify=False)
        r.raise_for_status()
        return r.json()
    except (requests.RequestException, ValueError) as e:
        raise DockerApiError(f"dockerapi request failed: {e}") from e


def _dovecot_container_id():
    # dockerapi returns {container_id: inspect_dict}; the exec route only
    # accepts the (alphanumeric) container id, not the container name.
    data = _request("GET", "/containers/json")
    items = data.items() if isinstance(data, dict) else enumerate(data or [])
    for key, c in items:
        if not isinstance(c, dict):
            continue
        labels = (c.get("Config") or {}).get("Labels") or c.get("Labels") or {}
        if labels.get("com.docker.compose.service") == DOVECOT_SERVICE:
            cid = c.get("Id") or (key if isinstance(key, str) else None)
            if cid:
                return cid
    raise DockerApiError(f"{DOVECOT_SERVICE} container not found")


def _exec(task, **params):
    if task not in ("get_acl", "set_acl", "delete_acl"):
        raise DockerApiError(f"task not allowed: {task}")
    cid = _dovecot_container_id()
    return _request("POST", f"/containers/{cid}/exec",
                    {"cmd": "doveadm", "task": task, **params})


def _expect_success(res):
    if not (isinstance(res, dict) and res.get("type") == "success"):
        msg = res.get("msg") if isinstance(res, dict) else res
        raise DockerApiError(f"dockerapi returned failure: {msg}")


def get_acl(owner):
    """Return doveadm ACL entries: [{user, id, mailbox, rights}, ...]."""
    res = _exec("get_acl", id=owner)
    if not isinstance(res, list):
        msg = res.get("msg") if isinstance(res, dict) else res
        raise DockerApiError(f"unexpected get_acl response: {msg}")
    return res


def set_acl(owner, grantee):
    _expect_success(_exec("set_acl", user=owner, mailbox=MAILBOX, id=grantee,
                          rights=RIGHTS))


def delete_acl(owner, grantee):
    _expect_success(_exec("delete_acl", user=owner, mailbox=MAILBOX, id=grantee))
