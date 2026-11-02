<?php
require_once dirname(__DIR__, 2) . '/common.php';

$user = exc_get_current_user();
if (!$user) {
    $token = get_bearer_token();
    if ($token && $token === ADMIN_PASSWORD) {
        $user = ['id' => 'admin', 'username' => 'admin'];
    } else {
        $sessions = load_json_file('user_sessions.json', []);
        if ($token && isset($sessions[$token])) {
            $user = $sessions[$token];
        } else {
            send_json(['success' => false, 'error' => 'Unauthorized: Please log in first.'], 401);
        }
    }
}

$ownerId = $user['id'];
$ownerKey = isset($user['key']) ? $user['key'] : '';
$ownerName = isset($user['username']) ? $user['username'] : '';

$method = $_SERVER['REQUEST_METHOD'];
$accounts = load_json_file('accounts.json', []);

if ($method === 'GET') {
    $userTokens = [];
    foreach ($accounts as $acc) {
        $accOwner = isset($acc['ownerId']) ? $acc['ownerId'] : '';
        if (($accOwner === $ownerId || (!empty($ownerKey) && $accOwner === $ownerKey) || (!empty($ownerName) && $accOwner === $ownerName)) && !empty($acc['token'])) {
            $userTokens[] = trim($acc['token'], " \t\n\r\0\x0B\"'");
        }
    }
    send_json([
        'success' => true,
        'tokens' => array_values(array_unique($userTokens))
    ]);
}

if ($method === 'POST') {
    $input = get_json_input();
    $rawTokens = isset($input['tokens']) ? $input['tokens'] : (isset($input['token']) ? [$input['token']] : []);
    if (!is_array($rawTokens)) {
        $rawTokens = preg_split('/[\r\n,]+/', strval($rawTokens));
    }
    
    $cleanTokens = [];
    foreach ($rawTokens as $t) {
        $t = trim($t, " \t\n\r\0\x0B\"'");
        if (!empty($t) && strlen($t) > 20) {
            $cleanTokens[] = $t;
        }
    }
    $cleanTokens = array_values(array_unique($cleanTokens));

    // Remove existing accounts for this user only
    $accounts = array_filter($accounts, function($acc) use ($ownerId, $ownerKey, $ownerName) {
        $accOwner = isset($acc['ownerId']) ? $acc['ownerId'] : '';
        if ($accOwner === $ownerId) return false;
        if (!empty($ownerKey) && $accOwner === $ownerKey) return false;
        if (!empty($ownerName) && $accOwner === $ownerName) return false;
        return true;
    });

    $userAccounts = [];
    foreach ($cleanTokens as $idx => $tokenStr) {
        $prof = fetch_discord_profile($tokenStr);
        if ($prof) {
            $label = $prof['global_name'];
            $userObj = [
                'id' => $prof['id'],
                'username' => $prof['username'],
                'tag' => $prof['tag'],
                'avatar' => $prof['avatar']
            ];
        } else {
            $label = 'Selfbot ' . ($idx + 1);
            $userObj = [
                'username' => $label,
                'tag' => '@' . $label,
                'avatar' => 'https://cdn.discordapp.com/embed/avatars/' . ($idx % 5) . '.png'
            ];
        }

        $accObj = [
            'id' => 'acc_' . substr(md5($tokenStr . $ownerId), 0, 12),
            'ownerId' => $ownerId,
            'token' => $tokenStr,
            'label' => $label,
            'name' => $label,
            'profile' => $prof,
            'status' => 'online',
            'autoStart' => true,
            'presence' => [ 'status' => 'online' ],
            'user' => $userObj,
            'currentVoice' => null,
            'voice247' => [ 'enabled' => false ],
            'createdAt' => date('c'),
            'updatedAt' => date('c')
        ];
        $accounts[] = $accObj;
        $userAccounts[] = $accObj;
    }

    save_json_file('accounts.json', array_values($accounts));

    send_json([
        'success' => true,
        'count' => count($cleanTokens),
        'accounts' => $userAccounts,
        'message' => 'Tokens saved permanently for user ' . $user['username']
    ]);
}

send_json(['success' => false, 'error' => 'Method not allowed'], 405);
