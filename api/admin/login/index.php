<?php
require_once dirname(__DIR__, 2) . '/common.php';

$input = get_json_input();
$password = trim(isset($input['password']) ? $input['password'] : (isset($input['adminKey']) ? $input['adminKey'] : ''));

if (empty($password) && isset($_GET['password'])) {
    $password = trim($_GET['password']);
}

if ($password === ADMIN_PASSWORD) {
    $token = 'exc_adm_' . bin2hex(random_bytes(16));
    $sessions = load_json_file('admin_sessions.json', []);
    $sessions[] = $token;
    save_json_file('admin_sessions.json', array_values(array_unique($sessions)));

    send_json([
        'success' => true,
        'token' => $token
    ]);
} else {
    send_json([
        'success' => false,
        'error' => 'Incorrect Admin Password'
    ], 401);
}
