"""Mailcow API client."""

import requests
from flask import current_app


class MailcowAPI:
    """Thin wrapper around the Mailcow REST API."""

    def __init__(self, api_url=None, api_key=None):
        cfg = current_app.config["MAILCOW"]
        self.base = (api_url or cfg["api_url"]).rstrip("/")
        self.key = api_key or cfg["api_key"]
        self.session = requests.Session()
        self.session.headers.update({
            "X-API-Key": self.key,
            "Content-Type": "application/json",
        })
        # Internal docker network uses self-signed certs; disable verification
        self.session.verify = False

    # -- low level --------------------------------------------------------

    def _get(self, path):
        r = self.session.get(f"{self.base}{path}", timeout=15)
        r.raise_for_status()
        return r.json()

    def _post(self, path, data):
        r = self.session.post(f"{self.base}{path}", json=data, timeout=30)
        r.raise_for_status()
        return r.json()

    # -- aliases -----------------------------------------------------------

    def get_aliases(self):
        return self._get("/api/v1/get/alias/all")

    def add_alias(self, address, goto, comment=""):
        return self._post("/api/v1/add/alias", {
            "address": address,
            "goto": goto,
            "active": "1",
            "sogo_visible": "0",
            "comment": comment,
        })

    def edit_alias(self, alias_id, data):
        return self._post("/api/v1/edit/alias", {
            "items": [str(alias_id)],
            "attr": data,
        })

    def delete_alias(self, alias_ids):
        if not isinstance(alias_ids, list):
            alias_ids = [alias_ids]
        return self._post("/api/v1/delete/alias", [str(i) for i in alias_ids])

    # -- mailboxes ---------------------------------------------------------

    def get_mailboxes(self):
        return self._get("/api/v1/get/mailbox/all")

    # -- sync jobs ---------------------------------------------------------

    def get_syncjobs(self):
        return self._get("/api/v1/get/syncjobs/all/no_log")

    def get_syncjob(self, syncjob_id):
        return self._get(f"/api/v1/get/syncjobs/{syncjob_id}")

    def add_syncjob(self, username, data):
        payload = {
            "username": username,
            "host1": data["host1"],
            "port1": data.get("port1", "993"),
            "user1": data["user1"],
            "password1": data["password1"],
            "enc1": data.get("enc1", "SSL"),
            "mins_interval": data.get("mins_interval", "20"),
            "subfolder2": data.get("subfolder2", ""),
            "maxage": data.get("maxage", "0"),
            "maxbytespersecond": data.get("maxbytespersecond", "0"),
            "timeout1": data.get("timeout1", "600"),
            "timeout2": data.get("timeout2", "600"),
            "exclude": data.get("exclude", ""),
            "custom_params": data.get("custom_params", ""),
            "delete2duplicates": data.get("delete2duplicates", "1"),
            "delete1": data.get("delete1", "0"),
            "delete2": data.get("delete2", "0"),
            "automap": data.get("automap", "1"),
            "skipcrossduplicates": data.get("skipcrossduplicates", "0"),
            "subscribeall": data.get("subscribeall", "1"),
            "active": data.get("active", "1"),
        }
        return self._post("/api/v1/add/syncjob", payload)

    def edit_syncjob(self, syncjob_id, data):
        return self._post("/api/v1/edit/syncjob", {
            "items": [str(syncjob_id)],
            "attr": data,
        })

    def delete_syncjobs(self, ids):
        if not isinstance(ids, list):
            ids = [ids]
        return self._post("/api/v1/delete/syncjob", [str(i) for i in ids])

    # -- health ------------------------------------------------------------

    def check_auth(self):
        """Return True if the API key is valid."""
        try:
            r = self.session.get(
                f"{self.base}/api/v1/get/status/containers", timeout=5
            )
            return r.status_code == 200
        except Exception:
            return False
