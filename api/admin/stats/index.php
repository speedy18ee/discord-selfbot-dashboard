<?php
require_once dirname(__DIR__, 2) . '/common.php';
require_admin();

$licenses = load_json_file('licenses.json', []);
$users = load_json_file('users.json', []);

$totalLicenses = count($licenses);
$activeLicenses = 0;
$unusedLicenses = 0;
$bannedLicenses = 0;

foreach ($licenses as $lic) {
    $st = isset($lic['status']) ? $lic['status'] : 'active';
    if ($st === 'active') $activeLicenses++;
    else if ($st === 'unused') $unusedLicenses++;
    else if ($st === 'banned') $bannedLicenses++;
}

send_json([
    'success' => true,
    'stats' => [
        'totalLicenses' => $totalLicenses,
        'activeLicenses' => $activeLicenses,
        'unusedLicenses' => $unusedLicenses,
        'bannedLicenses' => $bannedLicenses,
        'totalUsers' => count($users),
        'onlineBots' => 0
    ]
]);
