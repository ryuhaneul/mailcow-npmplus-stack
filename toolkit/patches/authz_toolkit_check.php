<?php
// Toolkit session authorization check.
// This file is owned by mailcow-toolkit. Mailcow update.sh only touches files
// it tracks in its git checkout; user-added files in data/web/inc/ajax/ are
// preserved. Keep the `authz_toolkit_` prefix to avoid future upstream collisions.
require_once $_SERVER['DOCUMENT_ROOT'] . '/inc/prerequisites.inc.php';
if (!isset($_SESSION['mailcow_cc_role']) || $_SESSION['mailcow_cc_role'] !== 'admin') {
    http_response_code(403);
    exit;
}
http_response_code(204);
exit;
