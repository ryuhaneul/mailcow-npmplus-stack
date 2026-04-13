import os
import yaml
from flask import Flask, redirect, url_for, render_template, session, request


def load_config():
    config_path = os.environ.get("TOOLKIT_CONFIG", "/config/config.yml")
    if not os.path.exists(config_path):
        config_path = os.path.join(os.path.dirname(__file__), "config.yml")
    with open(config_path) as f:
        return yaml.safe_load(f)


class ReverseProxied:
    """WSGI middleware: strip SCRIPT_NAME prefix from PATH_INFO.

    nginx passes the full path (e.g. /toolkit/login) to the backend.
    This middleware sets SCRIPT_NAME=/toolkit and strips it from PATH_INFO,
    so Flask routes on /login but generates URLs with /toolkit/ prefix.
    """
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
    app.secret_key = cfg["toolkit"]["secret_key"]
    app.config["MAILCOW"] = cfg["mailcow"]
    app.config["TOOLKIT"] = cfg["toolkit"]

    from auth import auth_required

    # Register enabled modules
    enabled = cfg["toolkit"].get("modules", [])

    if "groups" in enabled:
        from modules.groups import bp as groups_bp
        app.register_blueprint(groups_bp, url_prefix="/groups")

    if "syncjobs" in enabled:
        from modules.syncjobs import bp as syncjobs_bp
        app.register_blueprint(syncjobs_bp, url_prefix="/syncjobs")

    @app.route("/")
    @auth_required
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
        return render_template("dashboard.html", modules=modules)

    @app.route("/login", methods=["GET", "POST"])
    def login():
        error = None
        if request.method == "POST":
            from mailcow_api import MailcowAPI
            with app.app_context():
                api = MailcowAPI()
                if api.check_auth():
                    session["authenticated"] = True
                    next_url = request.args.get("next")
                    if next_url:
                        return redirect("/toolkit" + next_url)
                    return redirect(url_for("dashboard"))
                else:
                    error = "API key invalid or Mailcow unreachable"

        return render_template("login.html", error=error)

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    app.wsgi_app = ReverseProxied(app.wsgi_app, prefix="/toolkit")
    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
