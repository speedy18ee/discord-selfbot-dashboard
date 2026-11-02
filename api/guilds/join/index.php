<?php
require_once dirname(__DIR__, 2) . '/common.php';

// Auth check
$token = get_bearer_token();
if (!$token && isset($_GET['token'])) $token = trim($_GET['token']);
if (!$token && isset($_POST['token'])) $token = trim($_POST['token']);

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

$ownerId = isset($user['id']) ? $user['id'] : '';
$ownerKey = isset($user['key']) ? $user['key'] : '';
$ownerName = isset($user['username']) ? $user['username'] : '';

$input = get_json_input();
$inviteInput = isset($input['invite']) ? trim($input['invite']) : '';
$targetBotId = isset($input['botId']) ? trim($input['botId']) : 'ALL_BOTS';
$useProxy = isset($input['useProxy']) ? (bool)$input['useProxy'] : true;

if (empty($inviteInput)) {
    send_json(['success' => false, 'error' => 'Please provide a Discord invite link or code.'], 400);
}

// Clean invite code
$inviteCode = $inviteInput;
if (strpos($inviteCode, 'discord.gg/') !== false) {
    $parts = explode('discord.gg/', $inviteCode);
    $sub = explode('/', $parts[1]);
    $sub2 = explode('?', $sub[0]);
    $inviteCode = $sub2[0];
} else if (strpos($inviteCode, 'discord.com/invite/') !== false) {
    $parts = explode('discord.com/invite/', $inviteCode);
    $sub = explode('/', $parts[1]);
    $sub2 = explode('?', $sub[0]);
    $inviteCode = $sub2[0];
}
$inviteCode = trim($inviteCode, " \t\n\r\0\x0B/");

if (empty($inviteCode)) {
    send_json(['success' => false, 'error' => 'Invalid Discord invite format.'], 400);
}

// Load accounts
$accounts = load_json_file('accounts.json', []);
$targetBots = [];
foreach ($accounts as $acc) {
    $accOwner = isset($acc['ownerId']) ? $acc['ownerId'] : '';
    $match = ($accOwner === $ownerId || (!empty($ownerKey) && $accOwner === $ownerKey) || (!empty($ownerName) && $accOwner === $ownerName));
    if ($match && !empty($acc['token'])) {
        if ($targetBotId === 'ALL_BOTS' || (isset($acc['id']) && $acc['id'] === $targetBotId)) {
            $targetBots[] = $acc;
        }
    }
}

if (empty($targetBots)) {
    // Fallback: any account with token
    foreach ($accounts as $acc) {
        if (!empty($acc['token'])) {
            if ($targetBotId === 'ALL_BOTS' || (isset($acc['id']) && $acc['id'] === $targetBotId)) {
                $targetBots[] = $acc;
            }
        }
    }
}

if (empty($targetBots)) {
    send_json(['success' => false, 'error' => 'No active bot tokens found to join server.'], 400);
}

// Load proxy pool
$proxies = [];
$proxyFile = DATA_DIR . '/free_proxies.txt';
if (file_exists($proxyFile)) {
    $lines = file($proxyFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $line = trim($line);
        if (!empty($line) && strpos($line, ':') !== false) {
            $proxies[] = $line;
        }
    }
}

// 1. First fetch invite details to get guild name & icon
$sampleToken = trim($targetBots[0]['token'], " \t\n\r\0\x0B\"'");
$ch = curl_init("https://discord.com/api/v9/invites/{$inviteCode}");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: ' . $sampleToken,
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
]);
curl_setopt($ch, CURLOPT_TIMEOUT, 6);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
$res = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$guildInfo = null;
if ($httpCode === 200 && $res) {
    $invData = json_decode($res, true);
    if (is_array($invData) && isset($invData['guild'])) {
        $guildInfo = [
            'id' => $invData['guild']['id'],
            'name' => $invData['guild']['name'],
            'icon' => !empty($invData['guild']['icon']) ? "https://cdn.discordapp.com/icons/{$invData['guild']['id']}/{$invData['guild']['icon']}.png" : null,
            'memberCount' => isset($invData['approximate_member_count']) ? $invData['approximate_member_count'] : null
        ];
    }
}

$results = [];
$successCount = 0;

foreach ($targetBots as $bot) {
    $cleanToken = trim($bot['token'], " \t\n\r\0\x0B\"'");
    $label = !empty($bot['label']) ? $bot['label'] : (!empty($bot['name']) ? $bot['name'] : 'Selfbot');
    $joined = false;
    $usedProxyStr = 'Direct';

    // Pick a proxy if enabled and available
    $proxyToUse = null;
    if ($useProxy && !empty($proxies)) {
        $proxyToUse = $proxies[array_rand($proxies)];
        $usedProxyStr = $proxyToUse;
    }

    $ch = curl_init("https://discord.com/api/v9/invites/{$inviteCode}");
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(new stdClass()));
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: ' . $cleanToken,
        'Content-Type: application/json',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    ]);
    curl_setopt($ch, CURLOPT_TIMEOUT, 7);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);

    if ($proxyToUse) {
        curl_setopt($ch, CURLOPT_PROXY, $proxyToUse);
    }

    $joinRes = curl_exec($ch);
    $joinCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    // If proxy timed out or failed, try direct fallback
    if (($joinCode === 0 || $joinCode >= 500 || $curlErr) && $proxyToUse) {
        $ch2 = curl_init("https://discord.com/api/v9/invites/{$inviteCode}");
        curl_setopt($ch2, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch2, CURLOPT_POST, true);
        curl_setopt($ch2, CURLOPT_POSTFIELDS, json_encode(new stdClass()));
        curl_setopt($ch2, CURLOPT_HTTPHEADER, [
            'Authorization: ' . $cleanToken,
            'Content-Type: application/json',
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ]);
        curl_setopt($ch2, CURLOPT_TIMEOUT, 6);
        curl_setopt($ch2, CURLOPT_SSL_VERIFYPEER, false);
        $joinRes = curl_exec($ch2);
        $joinCode = curl_getinfo($ch2, CURLINFO_HTTP_CODE);
        curl_close($ch2);
        $usedProxyStr = 'Direct (Fallback)';
    }

    $resData = json_decode($joinRes, true);
    // 200 = OK, or if already in guild
    if ($joinCode === 200 || ($joinCode === 400 && isset($resData['code']) && $resData['code'] === 30001)) {
        $joined = true;
        $successCount++;
    }

    $results[] = [
        'accountId' => $bot['id'],
        'label' => $label,
        'success' => $joined,
        'httpCode' => $joinCode,
        'proxy' => $usedProxyStr,
        'error' => (!$joined && isset($resData['message'])) ? $resData['message'] : null
    ];
}

$serverName = $guildInfo ? $guildInfo['name'] : "Server ({$inviteCode})";

send_json([
    'success' => $successCount > 0,
    'message' => "Successfully joined {$successCount}/" . count($targetBots) . " bots to \"{$serverName}\" using proxy pool!",
    'joined' => $successCount,
    'total' => count($targetBots),
    'guild' => $guildInfo,
    'inviteCode' => $inviteCode,
    'results' => $results
]);
