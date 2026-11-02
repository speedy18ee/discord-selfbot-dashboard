<?php
require_once dirname(__DIR__, 2) . '/common.php';

$user = exc_get_current_user();
if (!$user) {
    send_json(['success' => false, 'error' => 'Unauthorized'], 401);
}

send_json([
    'success' => true,
    'user' => $user
]);
