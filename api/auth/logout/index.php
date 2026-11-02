<?php
require_once dirname(__DIR__, 2) . '/common.php';

$token = get_bearer_token();
if ($token) {
    $sessions = load_json_file('user_sessions.json', []);
    if (isset($sessions[$token])) {
        unset($sessions[$token]);
        save_json_file('user_sessions.json', $sessions);
    }
}

send_json(['success' => true]);
