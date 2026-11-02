<?php
require_once dirname(__DIR__, 2) . '/common.php';
require_admin();

$method = $_SERVER['REQUEST_METHOD'];
$licenses = load_json_file('licenses.json', []);

if ($method === 'GET') {
    send_json([
        'success' => true,
        'licenses' => array_values($licenses)
    ]);
}

$input = get_json_input();
$action = isset($input['action']) ? $input['action'] : (isset($_GET['action']) ? $_GET['action'] : '');
$id = isset($input['id']) ? $input['id'] : (isset($_GET['id']) ? $_GET['id'] : '');

if ($method === 'DELETE' || $action === 'delete') {
    if (empty($id)) send_json(['success' => false, 'error' => 'Missing license ID'], 400);
    $found = false;
    $licenses = array_filter($licenses, function($l) use ($id, &$found) {
        if ($l['id'] === $id) {
            $found = true;
            return false;
        }
        return true;
    });
    save_json_file('licenses.json', array_values($licenses));
    send_json(['success' => true]);
}

if ($action === 'hwid') {
    if (empty($id)) send_json(['success' => false, 'error' => 'Missing license ID'], 400);
    foreach ($licenses as &$lic) {
        if ($lic['id'] === $id) {
            $lic['hwid'] = null;
            break;
        }
    }
    save_json_file('licenses.json', $licenses);
    send_json(['success' => true]);
}

if ($action === 'ban') {
    if (empty($id)) send_json(['success' => false, 'error' => 'Missing license ID'], 400);
    $newStatus = 'banned';
    foreach ($licenses as &$lic) {
        if ($lic['id'] === $id) {
            $lic['status'] = ($lic['status'] === 'banned') ? 'active' : 'banned';
            $newStatus = $lic['status'];
            break;
        }
    }
    save_json_file('licenses.json', $licenses);
    send_json(['success' => true, 'status' => $newStatus]);
}

if ($action === 'limit') {
    if (empty($id)) send_json(['success' => false, 'error' => 'Missing license ID'], 400);
    $limit = max(intval(isset($input['botLimit']) ? $input['botLimit'] : 10), 1);
    foreach ($licenses as &$lic) {
        if ($lic['id'] === $id) {
            $lic['botLimit'] = $limit;
            break;
        }
    }
    save_json_file('licenses.json', $licenses);
    send_json(['success' => true, 'botLimit' => $limit]);
}

// Default POST: Create new licenses
$amount = min(max(intval(isset($input['amount']) ? $input['amount'] : 1), 1), 50);
$botLimit = max(intval(isset($input['botLimit']) ? $input['botLimit'] : 10), 1);
$days = max(intval(isset($input['days']) ? $input['days'] : 30), 1);
$mask = trim(isset($input['mask']) ? $input['mask'] : 'EXC-****-****-****');
$note = trim(isset($input['note']) ? $input['note'] : '');

$created = [];
for ($i = 0; $i < $amount; $i++) {
    // Generate key based on mask
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    $key = '';
    for ($c = 0; $c < strlen($mask); $c++) {
        $ch = $mask[$c];
        if ($ch === '*') {
            $key .= $chars[rand(0, strlen($chars) - 1)];
        } else {
            $key .= $ch;
        }
    }
    
    $expiry = date('c', strtotime("+$days days"));
    $lic = [
        'id' => 'lic_' . bin2hex(random_bytes(8)),
        'key' => $key,
        'status' => 'unused',
        'botLimit' => $botLimit,
        'days' => $days,
        'expiry' => $expiry,
        'hwid' => null,
        'usedBy' => null,
        'note' => $note,
        'createdAt' => date('c'),
        'usedAt' => null
    ];
    $licenses[] = $lic;
    $created[] = $lic;
}

save_json_file('licenses.json', $licenses);

send_json([
    'success' => true,
    'count' => count($created),
    'licenses' => $created
]);
