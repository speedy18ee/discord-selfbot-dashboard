<?php
require_once dirname(__DIR__, 2) . '/common.php';

$token = get_bearer_token();
if ($token) {
    $sessions = load_json_file('admin_sessions.json', []);
    $sessions = array_filter($sessions, function($t) use ($token) {
        return $t !== $token;
    });
    save_json_file('admin_sessions.json', array_values($sessions));
}

send_json(['success' => true]);
