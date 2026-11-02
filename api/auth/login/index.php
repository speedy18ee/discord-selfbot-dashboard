<?php
require_once dirname(__DIR__, 2) . '/common.php';

$input = get_json_input();
$key = trim(isset($input['key']) ? $input['key'] : (isset($input['username']) ? $input['username'] : ''));
$password = isset($input['password']) ? trim($input['password']) : '';
$hwid = isset($input['hwid']) ? trim($input['hwid']) : '';
$deviceInfo = isset($input['deviceInfo']) ? $input['deviceInfo'] : [];

if (empty($key)) {
    send_json(['success' => false, 'error' => 'Please provide a valid License Key or Username'], 400);
}

// 1. Check in licenses.json
$licenses = load_json_file('licenses.json', []);
$matchedLic = null;
foreach ($licenses as &$lic) {
    if (strcasecmp($lic['key'], $key) === 0) {
        $matchedLic = &$lic;
        break;
    }
}

if ($matchedLic) {
    if (isset($matchedLic['status']) && $matchedLic['status'] === 'banned') {
        send_json(['success' => false, 'error' => 'This license key has been banned.'], 403);
    }
    
    // Check expiry
    if (!empty($matchedLic['expiry'])) {
        $expTime = strtotime($matchedLic['expiry']);
        if ($expTime && $expTime < time()) {
            send_json(['success' => false, 'error' => 'License key has expired.'], 403);
        }
    }

    // Check HWID binding
    if (!empty($matchedLic['hwid']) && !empty($hwid)) {
        if ($matchedLic['hwid'] !== $hwid) {
            send_json(['success' => false, 'error' => 'HWID Mismatch: License is bound to another hardware device.'], 403);
        }
    } else if (empty($matchedLic['hwid']) && !empty($hwid)) {
        $matchedLic['hwid'] = $hwid;
    }

    $matchedLic['status'] = 'active';
    $matchedLic['usedAt'] = date('c');
    save_json_file('licenses.json', $licenses);

    $userId = 'usr_' . substr(md5($matchedLic['key']), 0, 14);
    $userObj = [
        'id' => $userId,
        'username' => $matchedLic['key'],
        'key' => $matchedLic['key'],
        'botLimit' => isset($matchedLic['botLimit']) ? $matchedLic['botLimit'] : 10,
        'subscription' => 'License Tier (' . (isset($matchedLic['botLimit']) ? $matchedLic['botLimit'] : 10) . ' Bots)',
        'expiry' => $matchedLic['expiry'],
        'status' => 'active'
    ];

    $token = 'exc_usr_' . bin2hex(random_bytes(16));
    $userSessions = load_json_file('user_sessions.json', []);
    $userSessions[$token] = $userObj;
    save_json_file('user_sessions.json', $userSessions);

    send_json([
        'success' => true,
        'token' => $token,
        'user' => $userObj
    ]);
}

// 2. Check in users.json
$users = load_json_file('users.json', []);
foreach ($users as &$u) {
    if (strcasecmp($u['username'], $key) === 0 || (isset($u['key']) && strcasecmp($u['key'], $key) === 0)) {
        if (!empty($password) && isset($u['password']) && $u['password'] !== $password) {
            send_json(['success' => false, 'error' => 'Invalid password'], 401);
        }
        
        $u['lastLogin'] = date('c');
        if (!empty($hwid) && empty($u['hwid'])) {
            $u['hwid'] = $hwid;
            $u['boundDevice'] = $deviceInfo;
        }
        save_json_file('users.json', $users);

        $token = 'exc_usr_' . bin2hex(random_bytes(16));
        $userObj = [
            'id' => $u['id'],
            'username' => $u['username'],
            'key' => isset($u['key']) ? $u['key'] : $u['username'],
            'botLimit' => isset($u['botLimit']) ? $u['botLimit'] : 10,
            'status' => isset($u['status']) ? $u['status'] : 'active'
        ];
        $userSessions = load_json_file('user_sessions.json', []);
        $userSessions[$token] = $userObj;
        save_json_file('user_sessions.json', $userSessions);

        send_json([
            'success' => true,
            'token' => $token,
            'user' => $userObj
        ]);
    }
}

send_json(['success' => false, 'error' => 'License Key / User not found'], 404);
