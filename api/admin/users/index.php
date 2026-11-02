<?php
require_once dirname(__DIR__, 2) . '/common.php';
require_admin();

$method = $_SERVER['REQUEST_METHOD'];
$users = load_json_file('users.json', []);

if ($method === 'GET') {
    $result = array_map(function($u) {
        return [
            'id' => isset($u['id']) ? $u['id'] : '',
            'username' => isset($u['username']) ? $u['username'] : '',
            'key' => isset($u['key']) ? $u['key'] : (isset($u['username']) ? $u['username'] : ''),
            'botLimit' => isset($u['botLimit']) ? $u['botLimit'] : 10,
            'status' => isset($u['status']) ? $u['status'] : 'active',
            'subscription' => isset($u['subscription']) ? $u['subscription'] : 'default',
            'lastLogin' => isset($u['lastLogin']) ? $u['lastLogin'] : null,
            'createdAt' => isset($u['createdAt']) ? $u['createdAt'] : null,
            'boundDevice' => isset($u['boundDevice']) ? $u['boundDevice'] : null,
            'hwid' => isset($u['hwid']) ? $u['hwid'] : null
        ];
    }, $users);

    send_json([
        'success' => true,
        'users' => array_values($result)
    ]);
}

$input = get_json_input();
$action = isset($input['action']) ? $input['action'] : (isset($_GET['action']) ? $_GET['action'] : '');
$id = isset($input['id']) ? $input['id'] : (isset($_GET['id']) ? $_GET['id'] : '');

if ($method === 'DELETE' || $action === 'delete') {
    if (empty($id)) send_json(['success' => false, 'error' => 'Missing user ID'], 400);
    $users = array_filter($users, function($u) use ($id) {
        return ($u['id'] !== $id && $u['username'] !== $id);
    });
    save_json_file('users.json', array_values($users));
    send_json(['success' => true]);
}

if ($action === 'hwid') {
    if (empty($id)) send_json(['success' => false, 'error' => 'Missing user ID'], 400);
    foreach ($users as &$u) {
        if ($u['id'] === $id || $u['username'] === $id) {
            $u['hwid'] = null;
            $u['boundDevice'] = null;
            break;
        }
    }
    save_json_file('users.json', $users);
    send_json(['success' => true, 'message' => 'User HWID cleared']);
}

if ($action === 'limit') {
    if (empty($id)) send_json(['success' => false, 'error' => 'Missing user ID'], 400);
    $limit = max(intval(isset($input['botLimit']) ? $input['botLimit'] : 10), 1);
    foreach ($users as &$u) {
        if ($u['id'] === $id || $u['username'] === $id) {
            $u['botLimit'] = $limit;
            break;
        }
    }
    save_json_file('users.json', $users);
    send_json(['success' => true, 'botLimit' => $limit]);
}

send_json(['success' => false, 'error' => 'Invalid action'], 400);
