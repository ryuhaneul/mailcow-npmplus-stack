import os
import yaml
from flask import Flask, abort, render_template, url_for
from auth import verify_admin_session


def load_config():
    config_path = os.environ.get("TOOLKIT_CONFIG", "/config/config.yml")
    if not os.path.exists(config_path):
        config_path = os.path.join(os.path.dirname(__file__), "config.yml")
    with open(config_path) as f:
        return yaml.safe_load(f)


class ReverseProxied:
    def __init__(self, app, prefix="/toolkit"):
        self.app = app
        self.prefix = prefix

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path.startswith(self.prefix):
            environ["SCRIPT_NAME"] = self.prefix
            environ["PATH_INFO"] = path[len(self.prefix):] or "/"
        return self.app(environ, start_response)


def create_app():
    app = Flask(__name__)
    cfg = load_config()
    app.config["MAILCOW"] = cfg["mailcow"]
    app.config["TOOLKIT"] = cfg["toolkit"]

    enabled = cfg["toolkit"].get("modules", [])

    if "groups" in enabled:
        from modules.groups import bp as groups_bp
        app.register_blueprint(groups_bp, url_prefix="/groups")
    if "syncjobs" in enabled:
        from modules.syncjobs import bp as syncjobs_bp
        app.register_blueprint(syncjobs_bp, url_prefix="/syncjobs")
    if "mailboxes" in enabled:
        from modules.mailboxes import bp as mailboxes_bp
        app.register_blueprint(mailboxes_bp, url_prefix="/mailboxes")

    @app.before_request
    def _require_admin_session():
        if not verify_admin_session():
            abort(403)

    @app.route("/")
    def dashboard():
        modules = []
        if "groups" in enabled:
            modules.append({
                "id": "groups",
                "name": "Group Management",
                "desc": "Manage alias-based mail groups with visual hierarchy",
                "icon": "group",
                "url": url_for("groups.index"),
            })
        if "syncjobs" in enabled:
            modules.append({
                "id": "syncjobs",
                "name": "Sync Jobs",
                "desc": "Batch create and monitor IMAP sync jobs",
                "icon": "sync",
                "url": url_for("syncjobs.index"),
            })
        if "mailboxes" in enabled:
            modules.append({
                "id": "mailboxes",
                "name": "Mailboxes",
                "desc": "Bulk-create mailboxes from CSV with random passwords",
                "icon": "mailbox",
                "url": url_for("mailboxes.index"),
            })
        return render_template("dashboard.html", modules=modules)

    app.wsgi_app = ReverseProxied(app.wsgi_app, prefix="/toolkit")
    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
