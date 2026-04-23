#!/usr/bin/env python3
"""Idempotently patch Mailcow UI templates for the mailcow-npmplus-stack.

Targets (all under $MAILCOW_DIR, default /home/mailcow-dockerized):
  1. data/web/templates/base.twig
     - Hide navbar Apps dropdown when no user is logged in.
     - Restrict app_links_processed rendering to admin role only.
  2. data/web/templates/admin_index.twig
  3. data/web/templates/domainadmin_index.twig
  4. data/web/templates/user_index.twig
     (2–4): wrap the body-level Apps section with an outer
     `{% if mailcow_cc_username %}…{% endif %}` guard so anonymous
     visitors on the login forms do not see registered app links
     (e.g. Toolkit).

Idempotency: per-file check for MARKER 'PATCH:mailcow-npmplus-stack'.
A file that already contains the marker is skipped. Each patched file
gets its own `<file>.bak-<YYYYMMDDhhmmss>` backup before overwrite.

Failure modes (non-zero exit): missing target file, anchor string not
found, anchor not unique in a file, unmatched closing tag, marker
missing from rewritten content.

Env: MAILCOW_DIR (default /home/mailcow-dockerized).
"""

import os
import re
import sys
import time

MAILCOW_DIR = os.environ.get("MAILCOW_DIR", "/home/mailcow-dockerized")
MARKER = "PATCH:mailcow-npmplus-stack"

# ---- base.twig patches ----
BASE_ORIG_IF = "{% if mailcow_apps_processed or app_links %}"
BASE_NEW_IF = (
    "{# PATCH:mailcow-npmplus-stack #}"
    "{% if mailcow_cc_username and (mailcow_apps_processed or app_links) %}"
)
BASE_ORIG_FOR = "{% for row in app_links_processed %}"
BASE_NEW_FOR = "{% if mailcow_cc_role == 'admin' %}{% for row in app_links_processed %}"

# ---- *_index.twig wrapper patches ----
# Anchor strings are the opening `{% if %}` lines that gate the Apps
# block. Each must appear exactly once per file.
INDEX_ANCHORS = {
    "data/web/templates/admin_index.twig":
        "{% if (mailcow_apps or app_links) and not hide_mailcow_apps %}",
    "data/web/templates/domainadmin_index.twig":
        "{% if (mailcow_apps or app_links) and not hide_mailcow_apps %}",
    "data/web/templates/user_index.twig":
        "{% if not oauth2_request and (mailcow_apps or app_links) and not hide_mailcow_apps %}",
}
WRAPPER_OPEN = "{# PATCH:mailcow-npmplus-stack #}{% if mailcow_cc_username %}"
WRAPPER_CLOSE = "{% endif %}"


class PatchError(RuntimeError):
    pass


def info(msg):
    print(f"[apply-ui-patches] {msg}")


def die(msg, code=1):
    print(f"[apply-ui-patches] ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def _depth_walk(text, start_idx, open_name, close_name):
    """Walk Twig tags from start_idx, tracking depth of open/close pairs.

    Returns the end-index of the matching close tag (first close that
    brings depth back to 0), or -1 if unmatched. The tag at start_idx is
    counted as the initial open (depth becomes 1 after it).

    Ignores `elseif`/`else` since they do not affect if/endif depth.
    """
    pattern = rf"\{{%-?\s*({open_name}|{close_name})\b[^%]*-?%\}}"
    tag_re = re.compile(pattern)
    depth = 0
    for match in tag_re.finditer(text, pos=start_idx):
        tag = match.group(1)
        if tag == open_name:
            depth += 1
        elif tag == close_name:
            depth -= 1
            if depth == 0:
                return match.end()
    return -1


def patch_base_twig(text):
    """Return (new_text, changed, detail). Raises PatchError on anomaly."""
    if MARKER in text:
        return text, False, "marker-present"

    if text.count(BASE_ORIG_IF) == 0:
        raise PatchError(f"base.twig: anchor not found: {BASE_ORIG_IF!r}")
    if text.count(BASE_ORIG_IF) > 1:
        raise PatchError(
            f"base.twig: anchor not unique ({text.count(BASE_ORIG_IF)}): {BASE_ORIG_IF!r}"
        )
    if text.count(BASE_ORIG_FOR) == 0:
        raise PatchError(f"base.twig: anchor not found: {BASE_ORIG_FOR!r}")
    if text.count(BASE_ORIG_FOR) > 1:
        raise PatchError(
            f"base.twig: anchor not unique ({text.count(BASE_ORIG_FOR)}): {BASE_ORIG_FOR!r}"
        )

    for_idx = text.index(BASE_ORIG_FOR)
    outer_endfor_end = _depth_walk(text, for_idx, "for", "endfor")
    if outer_endfor_end < 0:
        raise PatchError("base.twig: outer {% endfor %} not matched")

    # Tail first so head index stays stable.
    text = text[:outer_endfor_end] + "{% endif %}" + text[outer_endfor_end:]
    text = text.replace(BASE_ORIG_FOR, BASE_NEW_FOR, 1)
    text = text.replace(BASE_ORIG_IF, BASE_NEW_IF, 1)
    return text, True, "patched"


def patch_index_twig(text, anchor, label):
    """Wrap the Apps {% if … %}…{% endif %} block with a mailcow_cc_username guard.

    Returns (new_text, changed, detail). Raises PatchError on anomaly.
    """
    if MARKER in text:
        return text, False, "marker-present"

    if text.count(anchor) == 0:
        raise PatchError(f"{label}: anchor not found: {anchor!r}")
    if text.count(anchor) > 1:
        raise PatchError(
            f"{label}: anchor not unique ({text.count(anchor)}): {anchor!r}"
        )

    anchor_idx = text.index(anchor)
    line_start = text.rfind("\n", 0, anchor_idx) + 1  # 0 if no \n before
    indent = text[line_start:anchor_idx]

    # Match the if→endif for this anchor.
    matching_endif_end = _depth_walk(text, anchor_idx, "if", "endif")
    if matching_endif_end < 0:
        raise PatchError(f"{label}: matching {{% endif %}} not found for anchor")

    # Tail first: insert a second endif line right after the existing one.
    tail_insert = f"\n{indent}{WRAPPER_CLOSE}"
    text = text[:matching_endif_end] + tail_insert + text[matching_endif_end:]

    # Head: insert a new indented line with the wrapper open BEFORE the
    # anchor line. `line_start` still points to the original anchor line
    # because we only inserted later in the text.
    head_insert = f"{indent}{WRAPPER_OPEN}\n"
    text = text[:line_start] + head_insert + text[line_start:]

    return text, True, "patched"


def apply_to_file(target_abspath, patcher):
    if not os.path.isfile(target_abspath):
        raise PatchError(f"target file not found: {target_abspath}")

    with open(target_abspath, "r", encoding="utf-8") as f:
        original = f.read()

    new_text, changed, detail = patcher(original)

    if not changed:
        info(f"already applied (marker found) — skipping. file={target_abspath}")
        return False

    if MARKER not in new_text:
        raise PatchError(
            f"internal error: marker missing in output for {target_abspath} — refusing to write"
        )

    ts = time.strftime("%Y%m%d%H%M%S")
    backup = f"{target_abspath}.bak-{ts}"
    with open(backup, "w", encoding="utf-8") as f:
        f.write(original)
    info(f"backup created: {backup}")

    tmp = f"{target_abspath}.tmp-{ts}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(new_text)
    os.replace(tmp, target_abspath)
    info(f"patched: {target_abspath} ({detail})")
    return True


def main():
    plan = []
    # 1. base.twig
    plan.append((
        "data/web/templates/base.twig",
        patch_base_twig,
    ))
    # 2–4. *_index.twig (wrapper patches)
    for relpath, anchor in INDEX_ANCHORS.items():
        plan.append((
            relpath,
            (lambda a, l: (lambda t: patch_index_twig(t, a, l)))(anchor, relpath),
        ))

    any_changed = False
    for relpath, patcher in plan:
        abspath = os.path.join(MAILCOW_DIR, relpath)
        try:
            changed = apply_to_file(abspath, patcher)
        except PatchError as e:
            die(str(e))
        any_changed = any_changed or changed

    if any_changed:
        info("done — at least one file patched")
    else:
        info("done — all targets already carry the marker")
    return 0


if __name__ == "__main__":
    sys.exit(main())
