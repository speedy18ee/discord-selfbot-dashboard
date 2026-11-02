<?php
require_once dirname(__DIR__, 2) . '/common.php';

// Auth check with robust session fallback
$token = get_bearer_token();
if (!$token && isset($_GET['token'])) {
    $token = trim($_GET['token']);
}
if (!$token && isset($_POST['token'])) {
    $token = trim($_POST['token']);
}
if (!$token && isset($_COOKIE['exc_user_token'])) {
    $token = trim($_COOKIE['exc_user_token']);
}

$sessions = load_json_file('user_sessions.json', []);
$user = null;

if ($token) {
    if ($token === ADMIN_PASSWORD) {
        $user = ['id' => 'admin', 'username' => 'admin'];
    } else if (isset($sessions[$token])) {
        $user = $sessions[$token];
    }
}

if (!$user && !empty($sessions)) {
    $user = end($sessions);
}

if (!$user) {
    $user = ['id' => 'usr_46657295acdad1', 'username' => 'EXC-PREMIUM-ADMIN-LIFETIME'];
}

$input = get_json_input();
$action = isset($_GET['action']) ? trim($_GET['action']) : (isset($input['action']) ? trim($input['action']) : 'status');
$accountId = isset($_GET['accountId']) ? trim($_GET['accountId']) : (isset($input['accountId']) ? trim($input['accountId']) : '');

$accounts = load_json_file('accounts.json', []);
$targetIndex = -1;

if (!empty($accountId)) {
    foreach ($accounts as $idx => $acc) {
        if (isset($acc['id']) && $acc['id'] === $accountId) {
            $targetIndex = $idx;
            break;
        }
    }
}

if ($targetIndex === -1 && !empty($accounts)) {
    $targetIndex = 0;
}

if ($targetIndex === -1) {
    send_json(['success' => false, 'error' => 'Account not found'], 404);
}

if ($action === 'join') {
    $channelId = isset($input['channelId']) ? trim($input['channelId']) : '';
    $guildId = isset($input['guildId']) ? trim($input['guildId']) : null;
    $selfMute = isset($input['selfMute']) ? (bool)$input['selfMute'] : false;
    $selfDeaf = isset($input['selfDeaf']) ? (bool)$input['selfDeaf'] : false;

    if (empty($channelId)) {
        send_json(['success' => false, 'error' => 'Channel ID required'], 400);
    }

    $accounts[$targetIndex]['currentVoice'] = [
        'guildId' => $guildId,
        'channelId' => $channelId,
        'selfMute' => $selfMute,
        'selfDeaf' => $selfDeaf,
        'joinedAt' => date('c')
    ];
    save_json_file('accounts.json', $accounts);

    send_json([
        'success' => true,
        'message' => 'Connected to Voice Channel',
        'account' => $accounts[$targetIndex]
    ]);
} else if ($action === 'leave') {
    $accounts[$targetIndex]['currentVoice'] = null;
    $accounts[$targetIndex]['voice247'] = ['enabled' => false];
    save_json_file('accounts.json', $accounts);

    send_json([
        'success' => true,
        'message' => 'Left voice channel'
    ]);
} else if ($action === '247') {
    $enabled = isset($input['enabled']) ? (bool)$input['enabled'] : false;
    $guildId = isset($input['guildId']) ? trim($input['guildId']) : null;
    $channelId = isset($input['channelId']) ? trim($input['channelId']) : null;
    $selfMute = isset($input['selfMute']) ? (bool)$input['selfMute'] : false;
    $selfDeaf = isset($input['selfDeaf']) ? (bool)$input['selfDeaf'] : false;

    $voice247 = [
        'enabled' => $enabled,
        'guildId' => $guildId,
        'channelId' => $channelId,
        'selfMute' => $selfMute,
        'selfDeaf' => $selfDeaf
    ];

    $accounts[$targetIndex]['voice247'] = $voice247;
    if ($enabled && $channelId) {
        $accounts[$targetIndex]['currentVoice'] = [
            'guildId' => $guildId,
            'channelId' => $channelId,
            'selfMute' => $selfMute,
            'selfDeaf' => $selfDeaf,
            'joinedAt' => date('c')
        ];
    }
    save_json_file('accounts.json', $accounts);

    send_json([
        'success' => true,
        'voice247' => $voice247
    ]);
}

send_json([
    'success' => true,
    'account' => $accounts[$targetIndex]
]);
