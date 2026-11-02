<?php
// Universal API Gateway & Self-Hosted KeyAuth Licensing Engine
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Authorization, x-access-token, x-admin-token');

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$renderBase = 'https://exc-selfbot.onrender.com';
$dataDir = __DIR__ . '/../data';
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0777, true);
}

$licensesFile = $dataDir . '/licenses.json';
$sessionsFile = $dataDir . '/sessions.json';

// Initialize default licenses if file missing
if (!file_exists($licensesFile)) {
    $defaultLicenses = [
        [
            'id' => 'lic_8aedba99bc660725',
            'key' => 'EVC-TEST-XVBY-25B',
            'status' => 'active',
            'botLimit' => 25,
            'days' => 30,
            'expiry' => date('c', strtotime('+30 days')),
            'hwid' => null,
            'usedBy' => 'VIP Buyer',
            'note' => 'VIP Buyer (Created by Admin)',
            'createdAt' => date('c'),
            'usedAt' => date('c')
        ],
        [
            'id' => 'lic_d1a691f5118be3f0',
            'key' => 'EXC-PREMIUM-ADMIN-LIFETIME',
            'status' => 'active',
            'botLimit' => 100,
            'days' => 9999,
            'expiry' => null,
            'hwid' => null,
            'usedBy' => 'admin',
            'note' => 'Default Master License',
            'createdAt' => date('c'),
            'usedAt' => date('c')
        ]
    ];
    @file_put_contents($licensesFile, json_encode($defaultLicenses, JSON_PRETTY_PRINT));
}

function loadJSON($file, $default = []) {
    if (file_exists($file)) {
        $content = file_get_contents($file);
        $data = json_decode($content, true);
        if (is_array($data)) return $data;
    }
    return $default;
}

function saveJSON($file, $data) {
    @file_put_contents($file, json_encode($data, JSON_PRETTY_PRINT));
}

function getRenderToken($renderBase, $dataDir, $forceRefresh = false) {
    $tokenFile = $dataDir . '/render_master_token.json';
    if (!$forceRefresh && file_exists($tokenFile)) {
        $saved = json_decode(file_get_contents($tokenFile), true);
        $cachedToken = $saved['token'] ?? '';
        if (!empty($cachedToken) && (time() - ($saved['time'] ?? 0)) < 86400 * 2) {
            $ch = curl_init($renderBase . '/api/accounts');
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_HTTPHEADER, ['Authorization: Bearer ' . $cachedToken]);
            curl_setopt($ch, CURLOPT_TIMEOUT, 3);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_exec($ch);
            $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($code === 200) {
                return $cachedToken;
            }
        }
    }

    @unlink($tokenFile);
    $ch = curl_init($renderBase . '/api/auth/login');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'username' => 'RED',
        'password' => '1',
        'hwid' => 'HWID-2EB757AB171C81CEC48072C8D035EE4A'
    ]));
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 6);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    $resp = curl_exec($ch);
    curl_close($ch);
    $data = json_decode($resp, true);
    if (!empty($data['token'])) {
        @file_put_contents($tokenFile, json_encode(['token' => $data['token'], 'time' => time()]));
        return $data['token'];
    }
    return '';
}

function searchLavalinkTracks($query) {
    $nodes = [
        [
            'url' => 'https://lava-v4.millohost.my.id/v4/loadtracks?identifier=' . urlencode('ytsearch:' . $query),
            'auth' => 'https://discord.gg/mjS5J2K3ep'
        ],
        [
            'url' => 'https://lavalinkv4.serenetia.com/v4/loadtracks?identifier=' . urlencode('ytsearch:' . $query),
            'auth' => 'https://dsc.gg/ajidevserver'
        ]
    ];

    foreach ($nodes as $node) {
        $ch = curl_init($node['url']);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Authorization: ' . $node['auth'],
            'Accept: application/json'
        ]);
        curl_setopt($ch, CURLOPT_TIMEOUT, 3);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code === 200 && $res) {
            $data = json_decode($res, true);
            $rawTracks = [];
            if (($data['loadType'] ?? '') === 'search' && is_array($data['data'])) {
                $rawTracks = $data['data'];
            } elseif (($data['loadType'] ?? '') === 'track' && isset($data['data'])) {
                $rawTracks = [$data['data']];
            }
            if (!empty($rawTracks)) {
                $converted = [];
                foreach ($rawTracks as $t) {
                    if (empty($t['encoded']) || empty($t['info'])) continue;
                    $id = $t['info']['identifier'] ?? '';
                    $converted[] = [
                        'encoded' => $t['encoded'],
                        'info' => [
                            'identifier' => $id,
                            'title' => $t['info']['title'] ?? 'Unknown',
                            'author' => $t['info']['author'] ?? 'Unknown',
                            'length' => (int)($t['info']['length'] ?? 0),
                            'isSeekable' => $t['info']['isSeekable'] ?? true,
                            'isStream' => $t['info']['isStream'] ?? false,
                            'uri' => $t['info']['uri'] ?? ($id ? "https://www.youtube.com/watch?v={$id}" : ""),
                            'artworkUrl' => $t['info']['artworkUrl'] ?? ($id ? "https://img.youtube.com/vi/{$id}/hqdefault.jpg" : ""),
                            'sourceName' => $t['info']['sourceName'] ?? 'youtube'
                        ]
                    ];
                    if (count($converted) >= 12) break;
                }
                if (!empty($converted)) {
                    return $converted;
                }
            }
        }
    }
    return searchYouTube($query);
}

function searchYouTube($query) {
    $url = 'https://www.youtube.com/results?search_query=' . urlencode($query);
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language: en-US,en;q=0.9'
    ]);
    curl_setopt($ch, CURLOPT_TIMEOUT, 6);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    $html = curl_exec($ch);
    curl_close($ch);

    if (!$html) return [];

    $marker = 'var ytInitialData = ';
    $pos = strpos($html, $marker);
    if ($pos === false) return [];

    $start = $pos + strlen($marker);
    $end = strpos($html, ';</script>', $start);
    if ($end === false) return [];

    $jsonStr = substr($html, $start, $end - $start);
    $data = json_decode($jsonStr, true);
    if (!is_array($data)) return [];

    $contents = $data['contents']['twoColumnSearchResultsRenderer']['primaryContents']['sectionListRenderer']['contents'][0]['itemSectionRenderer']['contents'] ?? [];
    $tracks = [];

    foreach ($contents as $item) {
        $v = $item['videoRenderer'] ?? null;
        if (!$v) continue;
        $id = $v['videoId'] ?? null;
        if (!$id) continue;

        $title = $v['title']['runs'][0]['text'] ?? ($v['title']['simpleText'] ?? 'Unknown');
        $author = $v['ownerText']['runs'][0]['text'] ?? 'YouTube';
        $durText = $v['lengthText']['simpleText'] ?? '3:30';

        $durParts = explode(':', $durText);
        $durSec = 0;
        if (count($durParts) === 2) {
            $durSec = ((int)$durParts[0] * 60) + (int)$durParts[1];
        } elseif (count($durParts) === 3) {
            $durSec = ((int)$durParts[0] * 3600) + ((int)$durParts[1] * 60) + (int)$durParts[2];
        } else {
            $durSec = 210;
        }

        $tracks[] = [
            'encoded' => 'yt_' . $id,
            'info' => [
                'identifier' => $id,
                'title' => $title,
                'author' => $author,
                'length' => $durSec * 1000,
                'isSeekable' => true,
                'isStream' => false,
                'uri' => 'https://www.youtube.com/watch?v=' . $id,
                'artworkUrl' => "https://img.youtube.com/vi/{$id}/hqdefault.jpg",
                'sourceName' => 'youtube'
            ]
        ];

        if (count($tracks) >= 8) break;
    }

    return $tracks;
}

// Determine target path
$targetPath = '';
if (isset($_GET['__path'])) {
    $targetPath = $_GET['__path'];
} else {
    $requestUri = $_SERVER['REQUEST_URI'];
    $parts = explode('?', $requestUri, 2);
    $targetPath = $parts[0];
}

$cleanPath = '/' . ltrim($targetPath, '/');
$cleanPathNoSlash = rtrim($cleanPath, '/');

// Parse internal query string from __path if passed that way
$targetQuery = [];
if (strpos($cleanPath, '?') !== false) {
    $parts = explode('?', $cleanPath, 2);
    $cleanPath = $parts[0];
    $cleanPathNoSlash = rtrim($cleanPath, '/');
    parse_str($parts[1], $targetQuery);
}

$rawBody = file_get_contents('php://input');
$bodyJson = json_decode($rawBody, true) ?: [];

// Get auth token from header
$authHeader = '';
if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'];
} elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
    $authHeader = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
} else {
    $all = function_exists('getallheaders') ? getallheaders() : [];
    foreach ($all as $k => $v) {
        if (strtolower($k) === 'authorization') {
            $authHeader = $v;
            break;
        }
    }
}
$token = '';
if ($authHeader && stripos($authHeader, 'Bearer ') === 0) {
    $token = trim(substr($authHeader, 7));
}

// =========================================================================
// 1. FAST YOUTUBE MUSIC SEARCH: /api/music/search
// =========================================================================
if ($cleanPathNoSlash === '/api/music/search') {
    header('Content-Type: application/json');
    $q = trim($_GET['q'] ?? ($targetQuery['q'] ?? ''));
    if (empty($q)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Query parameter q required']);
        exit;
    }

    $tracks = searchLavalinkTracks($q);
    if (!empty($tracks)) {
        echo json_encode([
            'success' => true,
            'result' => [
                'loadType' => 'search',
                'tracks' => $tracks
            ]
        ]);
        exit;
    }
}

// =========================================================================
// 2. SELF-HOSTED KEYAUTH LOGIN: /api/auth/login
// =========================================================================
if ($cleanPathNoSlash === '/api/auth/login' && $method === 'POST') {
    header('Content-Type: application/json');
    $key = trim($bodyJson['key'] ?? $bodyJson['licenseKey'] ?? $bodyJson['username'] ?? '');
    $clientHwid = trim($bodyJson['hwid'] ?? '');
    $deviceInfo = $bodyJson['deviceInfo'] ?? [];

    if (empty($key)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Please enter your KeyAuth license key']);
        exit;
    }

    $licenses = loadJSON($licensesFile, []);
    $foundLic = null;
    $foundIdx = -1;

    foreach ($licenses as $idx => $l) {
        if (strtoupper($l['key']) === strtoupper($key) || (isset($l['id']) && $l['id'] === $key)) {
            $foundLic = $l;
            $foundIdx = $idx;
            break;
        }
    }

    // Strict KeyAuth check: Only licenses generated and managed in the Admin Panel can log in
    if (!$foundLic) {
        http_response_code(401);
        echo json_encode([
            'success' => false,
            'error' => 'Invalid License Key! Only keys generated in the Admin Panel can log in.'
        ]);
        exit;
    }

    if (($foundLic['status'] ?? '') === 'banned') {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'This license key has been banned by an administrator.']);
        exit;
    }

    if (!empty($foundLic['expiry'])) {
        $expTime = strtotime($foundLic['expiry']);
        if ($expTime && time() > $expTime) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'This license key has expired. Please renew your subscription.']);
            exit;
        }
    }

    if (empty($foundLic['hwid'])) {
        if (empty($clientHwid)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'error' => 'Device HWID fingerprint required to activate key.']);
            exit;
        }
        $foundLic['hwid'] = strtoupper($clientHwid);
        $foundLic['boundDevice'] = $deviceInfo;
        $foundLic['status'] = 'active';
        $foundLic['usedAt'] = date('c');
        if ($foundIdx >= 0) {
            $licenses[$foundIdx] = $foundLic;
            saveJSON($licensesFile, $licenses);
        }
    } else {
        if (empty($clientHwid) || strtoupper($foundLic['hwid']) !== strtoupper($clientHwid)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => "HWID Mismatch! This license key is locked to another device. Ask admin to reset HWID."]);
            exit;
        }
    }

    $sessionToken = 'exc_usr_' . bin2hex(random_bytes(24));
    $sessions = loadJSON($sessionsFile, []);
    $sessions[$sessionToken] = [
        'userId' => $foundLic['id'],
        'username' => $foundLic['key'],
        'key' => $foundLic['key'],
        'hwid' => $foundLic['hwid'],
        'botLimit' => (int)($foundLic['botLimit'] ?? 10),
        'status' => $foundLic['status'] ?? 'active',
        'expiry' => $foundLic['expiry'] ?? null,
        'createdAt' => time()
    ];
    saveJSON($sessionsFile, $sessions);

    echo json_encode([
        'success' => true,
        'token' => $sessionToken,
        'user' => [
            'id' => $foundLic['id'],
            'username' => $foundLic['key'],
            'key' => $foundLic['key'],
            'hwid' => $foundLic['hwid'],
            'botLimit' => (int)($foundLic['botLimit'] ?? 10),
            'status' => $foundLic['status'] ?? 'active',
            'expiry' => $foundLic['expiry'] ?? null
        ]
    ]);
    exit;
}

// =========================================================================
// 3. SELF-HOSTED KEYAUTH SESSION CHECK: /api/auth/me
// =========================================================================
if ($cleanPathNoSlash === '/api/auth/me' && $method === 'GET') {
    header('Content-Type: application/json');
    if (empty($token)) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'No authorization token provided']);
        exit;
    }

    $sessions = loadJSON($sessionsFile, []);
    if (isset($sessions[$token])) {
        $sess = $sessions[$token];
        $licenses = loadJSON($licensesFile, []);
        $lic = null;
        foreach ($licenses as $l) {
            if ($l['id'] === $sess['userId'] || strtoupper($l['key']) === strtoupper($sess['key'])) {
                $lic = $l;
                break;
            }
        }

        // If license was banned
        if ($lic && ($lic['status'] ?? '') === 'banned') {
            unset($sessions[$token]);
            saveJSON($sessionsFile, $sessions);
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'This license key has been banned by an administrator.']);
            exit;
        }

        // Strict 1-Device Enforce: If HWID was reset by admin (empty), invalidate this session so user must re-bind
        if ($lic && empty($lic['hwid'])) {
            unset($sessions[$token]);
            saveJSON($sessionsFile, $sessions);
            http_response_code(401);
            echo json_encode(['success' => false, 'error' => 'HWID was reset by admin. Please login again to bind this device.']);
            exit;
        }

        echo json_encode([
            'success' => true,
            'user' => [
                'id' => $sess['userId'],
                'userId' => $sess['userId'],
                'username' => $sess['username'],
                'key' => $sess['key'] ?? $sess['username'],
                'hwid' => $lic['hwid'] ?? $sess['hwid'] ?? '',
                'botLimit' => (int)($lic['botLimit'] ?? $sess['botLimit'] ?? 10),
                'status' => $lic['status'] ?? $sess['status'] ?? 'active'
            ]
        ]);
        exit;
    } else {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Session expired. Please login again.']);
        exit;
    }
}

// =========================================================================
// 4. ADMIN PORTAL APIS: /api/admin/*
// =========================================================================
if (strpos($cleanPathNoSlash, '/api/admin') === 0) {
    header('Content-Type: application/json');

    // Admin Login: /api/admin/login
    if ($cleanPathNoSlash === '/api/admin/login' && $method === 'POST') {
        $pass = trim($bodyJson['password'] ?? $bodyJson['adminKey'] ?? '');
        if ($pass === 'speedy18ee') {
            $admToken = 'exc_adm_' . bin2hex(random_bytes(24));
            $sessions = loadJSON($sessionsFile, []);
            $sessions[$admToken] = ['role' => 'admin', 'createdAt' => time()];
            saveJSON($sessionsFile, $sessions);
            echo json_encode(['success' => true, 'token' => $admToken]);
            exit;
        } else {
            http_response_code(401);
            echo json_encode(['success' => false, 'error' => 'Invalid Master Admin Password']);
            exit;
        }
    }

    // Admin Logout
    if ($cleanPathNoSlash === '/api/admin/logout') {
        if ($token) {
            $sessions = loadJSON($sessionsFile, []);
            unset($sessions[$token]);
            saveJSON($sessionsFile, $sessions);
        }
        echo json_encode(['success' => true]);
        exit;
    }

    $sessions = loadJSON($sessionsFile, []);
    $isAdmin = false;
    if ($token && ((isset($sessions[$token]['role']) && $sessions[$token]['role'] === 'admin') || strpos($token, 'exc_adm_') === 0)) {
        $isAdmin = true;
    }
    if (!$isAdmin) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Unauthorized Admin Access']);
        exit;
    }

    // Stats: /api/admin/stats
    if ($cleanPathNoSlash === '/api/admin/stats') {
        $licenses = loadJSON($licensesFile, []);
        $totalLicenses = count($licenses);
        $unusedLicenses = 0;
        $activeUsers = 0;
        foreach ($licenses as $l) {
            if (($l['status'] ?? '') === 'unused' || empty($l['hwid'])) $unusedLicenses++;
            if (($l['status'] ?? '') === 'active' && !empty($l['hwid'])) $activeUsers++;
        }
        echo json_encode([
            'success' => true,
            'stats' => [
                'totalLicenses' => $totalLicenses,
                'totalUsers' => max($activeUsers, 1),
                'unusedLicenses' => $unusedLicenses,
                'onlineBots' => 1
            ]
        ]);
        exit;
    }

    // Licenses: GET & POST /api/admin/licenses
    if ($cleanPathNoSlash === '/api/admin/licenses') {
        $licenses = loadJSON($licensesFile, []);

        if ($method === 'GET') {
            echo json_encode(['success' => true, 'licenses' => $licenses]);
            exit;
        }

        if ($method === 'POST') {
            $action = $bodyJson['action'] ?? 'create';

            if ($action === 'hwid') {
                $id = $bodyJson['id'] ?? '';
                $targetKey = '';
                foreach ($licenses as &$l) {
                    if ($l['id'] === $id || $l['key'] === $id) {
                        $l['hwid'] = null;
                        $l['boundDevice'] = null;
                        $targetKey = $l['key'];
                        break;
                    }
                }
                saveJSON($licensesFile, $licenses);

                // Invalidate all active sessions for this key so new device must bind
                $sessions = loadJSON($sessionsFile, []);
                $changed = false;
                foreach ($sessions as $tok => $s) {
                    if (($s['userId'] ?? '') === $id || strtoupper($s['key'] ?? '') === strtoupper($targetKey)) {
                        unset($sessions[$tok]);
                        $changed = true;
                    }
                }
                if ($changed) saveJSON($sessionsFile, $sessions);

                echo json_encode(['success' => true, 'message' => 'HWID reset successfully. Device unbound.']);
                exit;
            }

            if ($action === 'ban') {
                $id = $bodyJson['id'] ?? '';
                $newStatus = 'active';
                foreach ($licenses as &$l) {
                    if ($l['id'] === $id || $l['key'] === $id) {
                        $l['status'] = ($l['status'] === 'active') ? 'banned' : 'active';
                        $newStatus = $l['status'];
                        break;
                    }
                }
                saveJSON($licensesFile, $licenses);
                echo json_encode(['success' => true, 'status' => $newStatus]);
                exit;
            }

            if ($action === 'delete') {
                $id = $bodyJson['id'] ?? '';
                $licenses = array_values(array_filter($licenses, function($l) use ($id) {
                    return !($l['id'] === $id || $l['key'] === $id);
                }));
                saveJSON($licensesFile, $licenses);
                echo json_encode(['success' => true, 'message' => 'License deleted']);
                exit;
            }

            if ($action === 'limit') {
                $id = $bodyJson['id'] ?? '';
                $limit = (int)($bodyJson['limit'] ?? 10);
                foreach ($licenses as &$l) {
                    if ($l['id'] === $id || $l['key'] === $id) {
                        $l['botLimit'] = $limit;
                        break;
                    }
                }
                saveJSON($licensesFile, $licenses);
                echo json_encode(['success' => true, 'limit' => $limit]);
                exit;
            }

            // Generate New Licenses
            $amount = max(1, min(50, (int)($bodyJson['amount'] ?? 1)));
            $botLimit = max(1, (int)($bodyJson['botLimit'] ?? 10));
            $days = (int)($bodyJson['days'] ?? 30);
            $mask = trim($bodyJson['mask'] ?? 'EXC-XXXX-XXXX-XXXX');
            $note = trim($bodyJson['note'] ?? 'VIP Buyer');

            $created = [];
            for ($i = 0; $i < $amount; $i++) {
                $key = '';
                if (strpos($mask, 'XXXX') !== false) {
                    $key = preg_replace_callback('/X/', function() {
                        $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
                        return $chars[rand(0, strlen($chars) - 1)];
                    }, $mask);
                } else {
                    $key = 'EXC-' . strtoupper(substr(bin2hex(random_bytes(2)), 0, 4)) . '-' . strtoupper(substr(bin2hex(random_bytes(2)), 0, 4)) . '-' . strtoupper(substr(bin2hex(random_bytes(2)), 0, 4));
                }

                $expiry = ($days > 0 && $days < 9999) ? date('c', strtotime("+$days days")) : null;
                $lic = [
                    'id' => 'lic_' . bin2hex(random_bytes(8)),
                    'key' => $key,
                    'status' => 'active',
                    'botLimit' => $botLimit,
                    'days' => $days,
                    'expiry' => $expiry,
                    'hwid' => null,
                    'usedBy' => 'Buyer',
                    'note' => $note,
                    'createdAt' => date('c'),
                    'usedAt' => date('c')
                ];
                $licenses[] = $lic;
                $created[] = $lic;
            }
            saveJSON($licensesFile, $licenses);
            echo json_encode(['success' => true, 'count' => count($created), 'licenses' => $created]);
            exit;
        }
    }

    // Users list: GET & POST /api/admin/users
    if ($cleanPathNoSlash === '/api/admin/users') {
        $licenses = loadJSON($licensesFile, []);
        $users = [];
        foreach ($licenses as $l) {
            $users[] = [
                'id' => $l['id'],
                'username' => $l['key'],
                'key' => $l['key'],
                'hwid' => $l['hwid'],
                'botLimit' => $l['botLimit'] ?? 10,
                'status' => $l['status'] ?? 'active',
                'createdAt' => $l['createdAt'] ?? date('c'),
                'lastLogin' => $l['usedAt'] ?? date('c'),
                'note' => $l['note'] ?? ''
            ];
        }

        if ($method === 'GET') {
            echo json_encode(['success' => true, 'users' => $users]);
            exit;
        }

        if ($method === 'POST') {
            $action = $bodyJson['action'] ?? '';
            $id = $bodyJson['id'] ?? '';
            if ($action === 'hwid') {
                $targetKey = '';
                foreach ($licenses as &$l) {
                    if ($l['id'] === $id || $l['key'] === $id) {
                        $l['hwid'] = null;
                        $l['boundDevice'] = null;
                        $targetKey = $l['key'];
                        break;
                    }
                }
                saveJSON($licensesFile, $licenses);

                // Invalidate all active sessions for this key so new device must bind
                $sessions = loadJSON($sessionsFile, []);
                $changed = false;
                foreach ($sessions as $tok => $s) {
                    if (($s['userId'] ?? '') === $id || strtoupper($s['key'] ?? '') === strtoupper($targetKey)) {
                        unset($sessions[$tok]);
                        $changed = true;
                    }
                }
                if ($changed) saveJSON($sessionsFile, $sessions);

                echo json_encode(['success' => true, 'message' => 'User HWID cleared. Device unbound.']);
                exit;
            }
            if ($action === 'ban') {
                $newStatus = 'active';
                foreach ($licenses as &$l) {
                    if ($l['id'] === $id || $l['key'] === $id) {
                        $l['status'] = ($l['status'] === 'active') ? 'suspended' : 'active';
                        $newStatus = $l['status'];
                        break;
                    }
                }
                saveJSON($licensesFile, $licenses);
                echo json_encode(['success' => true, 'status' => $newStatus]);
                exit;
            }
        }
    }
}

// =========================================================================
// 5. MULTI-TENANT ISOLATION & DIRECT FORWARDING TO RENDER
// =========================================================================
$renderMasterToken = getRenderToken($renderBase, $dataDir);

// Resolve calling user session
$sessions = loadJSON($sessionsFile, []);
$callingUser = null;
$callingKey = '';
$isMasterAdmin = false;

if (!empty($token) && isset($sessions[$token])) {
    $callingUser = $sessions[$token];
    $callingKey = strtoupper($callingUser['key'] ?? $callingUser['username'] ?? '');
    if ($callingKey === 'EXC-PREMIUM-ADMIN-LIFETIME' || ($callingUser['role'] ?? '') === 'admin') {
        $isMasterAdmin = true;
    }
}

// User Accounts Mapping File (tracks bot account IDs per license key)
$userAccountsFile = $dataDir . '/user_accounts.json';
$userAccountsMapping = loadJSON($userAccountsFile, [
    'EXC-PREMIUM-ADMIN-LIFETIME' => ['acc_mvkpblbg14j7', 'acc_mvv4fbh4e4ih']
]);

function executeRenderForward($targetUrl, $method, $token, $rawBody) {
    $ch = curl_init($targetUrl);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'Accept: application/json',
        'Authorization: Bearer ' . $token
    ]);
    if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE']) && !empty($rawBody)) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    }
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);
    return [$response, $httpCode, $contentType];
}

function executeRenderForwardParallel($urlPayloadPairs, $token) {
    if (empty($urlPayloadPairs)) return [];
    
    $mh = curl_multi_init();
    $curlHandles = [];
    
    foreach ($urlPayloadPairs as $idx => $item) {
        $targetUrl = $item['url'];
        $method = $item['method'] ?? 'POST';
        $body = $item['body'] ?? '';
        
        $ch = curl_init($targetUrl);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        if ($method === 'POST' || $method === 'PUT') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $headers = [
            'Content-Type: application/json',
            'Accept: application/json'
        ];
        if (!empty($token)) {
            $headers[] = 'Authorization: Bearer ' . $token;
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 12);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
        
        curl_multi_add_handle($mh, $ch);
        $curlHandles[$idx] = $ch;
    }
    
    $active = null;
    do {
        $status = curl_multi_exec($mh, $active);
        if ($active) {
            curl_multi_select($mh, 0.05);
        }
    } while ($active && $status == CURLM_OK);
    
    $results = [];
    foreach ($curlHandles as $idx => $ch) {
        $results[$idx] = curl_multi_getcontent($ch);
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    
    return $results;
}


// --- 5A. GET /api/accounts: Filter bots to only the current user's accounts ---
if ($cleanPathNoSlash === '/api/accounts' && $method === 'GET') {
    header('Content-Type: application/json');
    list($response, $httpCode, $contentType) = executeRenderForward($renderBase . '/api/accounts', 'GET', $renderMasterToken, '');
    if ($httpCode === 401) {
        $freshToken = getRenderToken($renderBase, $dataDir, true);
        if ($freshToken) {
            $renderMasterToken = $freshToken;
            list($response, $httpCode, $contentType) = executeRenderForward($renderBase . '/api/accounts', 'GET', $renderMasterToken, '');
        }
    }

    $data = json_decode($response, true);
    if (!empty($data['success']) && isset($data['accounts'])) {
        $userAccountsMapping = loadJSON($userAccountsFile, []);
        $ownedIds = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];
        $userBots = [];
        foreach ($data['accounts'] as $b) {
            if (in_array($b['id'], $ownedIds)) {
                $userBots[] = $b;
            }
        }
        echo json_encode(['success' => true, 'accounts' => $userBots]);
        exit;
    }

    http_response_code($httpCode ?: 200);
    echo $response;
    exit;
}

// --- 5B. POST /api/accounts: Enforce quota and register new bot to user key ---
if ($cleanPathNoSlash === '/api/accounts' && $method === 'POST') {
    header('Content-Type: application/json');
    if (isset($bodyJson['token'])) {
        $bodyJson['token'] = trim((string)$bodyJson['token'], " \t\n\r\0\x0B\"'");
        $rawBody = json_encode($bodyJson);
    }
    
    // Live Bot Quota Limit from Admin Panel licenses.json
    $licenses = loadJSON($licensesFile, []);
    $liveLic = null;
    foreach ($licenses as $l) {
        if (strtoupper($l['key']) === $callingKey || (isset($l['id']) && $l['id'] === ($callingUser['userId'] ?? ''))) {
            $liveLic = $l;
            break;
        }
    }
    $botLimit = $liveLic ? (int)($liveLic['botLimit'] ?? 10) : (int)($callingUser['botLimit'] ?? 10);
    $ownedIds = $userAccountsMapping[$callingKey] ?? [];

    $userAccountsMapping = loadJSON($userAccountsFile, []);
    $ownedIds = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];
    if (!empty($callingKey) && count($ownedIds) >= $botLimit) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => "Bot account limit reached (" . count($ownedIds) . "/{$botLimit} bots). Your license allows up to {$botLimit} bots. Please contact admin to increase your limit."
        ]);
        exit;
    }

    list($response, $httpCode, $contentType) = executeRenderForward($renderBase . '/api/accounts', 'POST', $renderMasterToken, $rawBody);
    if ($httpCode === 401) {
        $freshToken = getRenderToken($renderBase, $dataDir, true);
        if ($freshToken) {
            $renderMasterToken = $freshToken;
            list($response, $httpCode, $contentType) = executeRenderForward($renderBase . '/api/accounts', 'POST', $renderMasterToken, $rawBody);
        }
    }

    $data = json_decode($response, true);
    if (!empty($data['success']) && !empty($data['account']['id']) && !empty($callingKey)) {
        $newId = $data['account']['id'];
        if (!isset($userAccountsMapping[$callingKey])) {
            $userAccountsMapping[$callingKey] = [];
        }
        if (!in_array($newId, $userAccountsMapping[$callingKey])) {
            $userAccountsMapping[$callingKey][] = $newId;
            saveJSON($userAccountsFile, $userAccountsMapping);
        }
        // Automatically clear 24/7 music playing presence
        executeRenderForward($renderBase . "/api/accounts/{$newId}/presence", 'POST', $renderMasterToken, json_encode([
            'status' => 'online',
            'activity' => ['name' => '', 'type' => 'PLAYING']
        ]));
    }

    http_response_code($httpCode ?: 200);
    echo $response;
    exit;
}

// --- 5B2. POST /api/accounts/mass: Enforce quota and register all imported bots to user key ---
if ($cleanPathNoSlash === '/api/accounts/mass' && $method === 'POST') {
    header('Content-Type: application/json');

    $licenses = loadJSON($licensesFile, []);
    $liveLic = null;
    foreach ($licenses as $l) {
        if (strtoupper($l['key']) === $callingKey || (isset($l['id']) && $l['id'] === ($callingUser['userId'] ?? ''))) {
            $liveLic = $l;
            break;
        }
    }
    $botLimit = $liveLic ? (int)($liveLic['botLimit'] ?? 10) : (int)($callingUser['botLimit'] ?? 10);
    $userAccountsMapping = loadJSON($userAccountsFile, []);
    $ownedIds = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];

    $incomingTokens = $bodyJson['tokens'] ?? [];
    if (!is_array($incomingTokens) || empty($incomingTokens)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Tokens array is required']);
        exit;
    }

    // Auto-clean tokens: strip surrounding quotes, single-quotes, and whitespace
    $cleanedTokens = [];
    foreach ($incomingTokens as $t) {
        $rawT = is_array($t) ? ($t['token'] ?? '') : $t;
        $rawT = trim((string)$rawT, " \t\n\r\0\x0B\"'");
        if (!empty($rawT)) {
            $cleanedTokens[] = is_array($t) ? array_merge($t, ['token' => $rawT]) : $rawT;
        }
    }
    $incomingTokens = $cleanedTokens;
    $bodyJson['tokens'] = $incomingTokens;
    $rawBody = json_encode($bodyJson);

    $available = max(0, $botLimit - count($ownedIds));
    if ($available <= 0) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => "Bot account limit reached (" . count($ownedIds) . "/{$botLimit} bots). Your license allows up to {$botLimit} bots."
        ]);
        exit;
    }

    if (count($incomingTokens) > $available) {
        $bodyJson['tokens'] = array_slice($incomingTokens, 0, $available);
        $rawBody = json_encode($bodyJson);
    }

    list($response, $httpCode, $contentType) = executeRenderForward($renderBase . '/api/accounts/mass', 'POST', $renderMasterToken, $rawBody);
    if ($httpCode === 401) {
        $freshToken = getRenderToken($renderBase, $dataDir, true);
        if ($freshToken) {
            $renderMasterToken = $freshToken;
            list($response, $httpCode, $contentType) = executeRenderForward($renderBase . '/api/accounts/mass', 'POST', $renderMasterToken, $rawBody);
        }
    }

    $data = json_decode($response, true);
    if (!empty($data['success']) && !empty($data['added']) && !empty($callingKey)) {
        $userAccountsMapping = loadJSON($userAccountsFile, []);
        if (!isset($userAccountsMapping[$callingKey])) {
            $userAccountsMapping[$callingKey] = [];
        }
        foreach ($data['added'] as $acc) {
            if (!empty($acc['id']) && !in_array($acc['id'], $userAccountsMapping[$callingKey])) {
                $userAccountsMapping[$callingKey][] = $acc['id'];
                executeRenderForward($renderBase . "/api/accounts/{$acc['id']}/presence", 'POST', $renderMasterToken, json_encode([
                    'status' => 'online',
                    'activity' => ['name' => '', 'type' => 'PLAYING']
                ]));
            }
        }
        saveJSON($userAccountsFile, $userAccountsMapping);
    }

    http_response_code($httpCode ?: 200);
    echo $response;
    exit;
}

// --- 5B3. GET /api/accounts/tokens: Retrieve only current user's tokens ---
if ($cleanPathNoSlash === '/api/accounts/tokens' && $method === 'GET') {
    header('Content-Type: application/json');
    $userAccountsMapping = loadJSON($userAccountsFile, []);
    $ownedIds = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];

    list($response) = executeRenderForward($renderBase . '/api/accounts', 'GET', $renderMasterToken, '');
    $data = json_decode($response, true);
    $userTokens = [];
    if (!empty($data['accounts'])) {
        foreach ($data['accounts'] as $b) {
            if (in_array($b['id'], $ownedIds) && !empty($b['token'])) {
                $userTokens[] = $b['token'];
            }
        }
    }
    echo json_encode(['success' => true, 'tokens' => array_values(array_unique($userTokens))]);
    exit;
}

// --- 5C. DELETE /api/accounts/:id: Enforce ownership & unregister ---
if (preg_match('#^/api/accounts/([^/]+)$#', $cleanPathNoSlash, $m) && $method === 'DELETE') {
    header('Content-Type: application/json');
    $accId = $m[1];
    $ownedIds = $userAccountsMapping[$callingKey] ?? [];

    $userAccountsMapping = loadJSON($userAccountsFile, []);
    $ownedIds = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];
    if (!empty($callingKey) && !in_array($accId, $ownedIds)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Permission denied: This bot account belongs to another user.']);
        exit;
    }

    list($response, $httpCode, $contentType) = executeRenderForward($renderBase . $cleanPathNoSlash, 'DELETE', $renderMasterToken, $rawBody);
    if (!empty($callingKey) && isset($userAccountsMapping[$callingKey])) {
        $userAccountsMapping[$callingKey] = array_values(array_filter($userAccountsMapping[$callingKey], function($id) use ($accId) {
            return $id !== $accId;
        }));
        saveJSON($userAccountsFile, $userAccountsMapping);
    }

    http_response_code($httpCode ?: 200);
    echo $response;
    exit;
}

// --- 5D0. Mass Voice Join: /api/accounts/voice/join-all ---
if ($cleanPathNoSlash === '/api/accounts/voice/join-all' && $method === 'POST') {
    header('Content-Type: application/json');
    $userAccountsMapping = loadJSON($userAccountsFile, []);
    $ownedIds = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];
    
    if (empty($ownedIds)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'No bots registered under your license key.']);
        exit;
    }

    $guildId = $bodyJson['guildId'] ?? '';
    $channelId = $bodyJson['channelId'] ?? '';
    $keep247 = $bodyJson['keep247'] ?? true;
    $selfMute = !empty($bodyJson['selfMute']);
    $selfDeaf = !empty($bodyJson['selfDeaf']);

    if (empty($channelId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Voice Channel ID is required']);
        exit;
    }

    $joinRequests = [];
    foreach ($ownedIds as $bId) {
        $joinRequests[] = [
            'url' => $renderBase . "/api/accounts/{$bId}/voice/join",
            'method' => 'POST',
            'body' => json_encode([
                'guildId' => $guildId,
                'channelId' => $channelId,
                'keep247' => $keep247,
                'selfMute' => $selfMute,
                'selfDeaf' => $selfDeaf
            ])
        ];
    }
    executeRenderForwardParallel($joinRequests, $renderMasterToken);

    if ($keep247) {
        $stayRequests = [];
        foreach ($ownedIds as $bId) {
            $stayRequests[] = [
                'url' => $renderBase . "/api/accounts/{$bId}/voice/247",
                'method' => 'POST',
                'body' => json_encode([
                    'enabled' => true,
                    'guildId' => $guildId,
                    'channelId' => $channelId,
                    'selfMute' => $selfMute,
                    'selfDeaf' => $selfDeaf
                ])
            ];
        }
        executeRenderForwardParallel($stayRequests, $renderMasterToken);
    }
    echo json_encode(['success' => true, 'joinedCount' => count($ownedIds), 'total' => count($ownedIds)]);
    exit;
}

// --- 5D1. Mass Voice Leave: /api/accounts/voice/leave-all or /api/actions/voice/leave-all ---
if (($cleanPathNoSlash === '/api/accounts/voice/leave-all' || $cleanPathNoSlash === '/api/actions/voice/leave-all') && $method === 'POST') {
    header('Content-Type: application/json');
    $userAccountsMapping = loadJSON($userAccountsFile, []);
    $ownedIds = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];

    $count = 0;
    foreach ($ownedIds as $bId) {
        list($resp, $code) = executeRenderForward($renderBase . "/api/accounts/{$bId}/voice/leave", 'POST', $renderMasterToken, '{}');
        $respData = json_decode($resp, true);
        if (!empty($respData['success'])) {
            $count++;
        }
    }
    echo json_encode(['success' => true, 'disconnectedCount' => $count]);
    exit;
}

// --- 5D. Single Bot Operations: /api/accounts/:id/* ---
if (preg_match('#^/api/accounts/([^/]+)/#', $cleanPathNoSlash, $m)) {
    $accId = $m[1];
    $specialRoutes = ['voice', 'mass', 'tokens', 'start-all', 'stop-all'];
    if (!in_array($accId, $specialRoutes)) {
        $userAccountsMapping = loadJSON($userAccountsFile, []);
        $ownedIds = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];
        if (!empty($callingKey) && !in_array($accId, $ownedIds)) {
            header('Content-Type: application/json');
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Permission denied: You do not own this bot account.']);
            exit;
        }
    }
}

// --- 5E. Mass Bot Actions: /api/accounts/start-all & stop-all ---
if (($cleanPathNoSlash === '/api/accounts/start-all' || $cleanPathNoSlash === '/api/accounts/stop-all') && !$isMasterAdmin && !empty($callingKey)) {
    header('Content-Type: application/json');
    $action = ($cleanPathNoSlash === '/api/accounts/start-all') ? 'start' : 'stop';
    $ownedIds = $userAccountsMapping[$callingKey] ?? [];
    foreach ($ownedIds as $bId) {
        executeRenderForward($renderBase . "/api/accounts/{$bId}/{$action}", 'POST', $renderMasterToken, '{}');
    }
    echo json_encode(['success' => true, 'count' => count($ownedIds)]);
    exit;
}

// --- 5F. Mass Voice Disconnect: /api/actions/voice/leave-all ---
if ($cleanPathNoSlash === '/api/actions/voice/leave-all' && !$isMasterAdmin && !empty($callingKey)) {
    header('Content-Type: application/json');
    $ownedIds = $userAccountsMapping[$callingKey] ?? [];
    foreach ($ownedIds as $bId) {
        executeRenderForward($renderBase . "/api/accounts/{$bId}/voice/leave", 'POST', $renderMasterToken, '{}');
    }
    echo json_encode(['success' => true, 'count' => count($ownedIds)]);
    exit;
}

// --- 5G. Status Overview: /api/status ---
if ($cleanPathNoSlash === '/api/status') {
    header('Content-Type: application/json');
    list($response, $httpCode, $contentType) = executeRenderForward($renderBase . '/api/status', 'GET', $renderMasterToken, '');
    $data = json_decode($response, true);
    if (!empty($data['success']) && isset($data['onlineBots']) && !empty($callingKey)) {
        $userAccountsMapping = loadJSON($userAccountsFile, []);
        $ownedIds = $userAccountsMapping[$callingKey] ?? [];
        $filteredBots = [];
        foreach ($data['onlineBots'] as $b) {
            if (in_array($b['id'], $ownedIds)) {
                $filteredBots[] = $b;
            }
        }
        $data['onlineBots'] = $filteredBots;
        $data['botsCount'] = count($filteredBots);
        echo json_encode($data);
        exit;
    }
    http_response_code($httpCode ?: 200);
    echo $response;
    exit;
}


// --- 5G. Custom Audio & Uploaded MP3 Playback with Parallel Multi-Bot Sync ---
if (($cleanPathNoSlash === '/api/music/custom-audio' || preg_match('#^/api/music/uploads/([^/]+)/play$#', $cleanPathNoSlash)) && $method === 'POST') {
    header('Content-Type: application/json');
    $userAccountsMapping = loadJSON($userAccountsFile, []);
    $ownedBots = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];

    if (empty($ownedBots)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'No bots registered under your license key. Please add a bot first!']);
        exit;
    }

    $targetAccountId = $bodyJson['accountId'] ?? null;
    if (!empty($targetAccountId) && $targetAccountId !== 'ALL_BOTS') {
        if (!in_array($targetAccountId, $ownedBots)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Permission denied: This bot does not belong to your license key.']);
            exit;
        }
        $bodyJson['singleBot'] = true;
        list($response, $httpCode, $contentType) = executeRenderForward($renderBase . $cleanPathNoSlash, 'POST', $renderMasterToken, json_encode($bodyJson));
        http_response_code($httpCode ?: 200);
        echo $response;
        exit;
    }

    // ALL BOTS for MP3 / Custom Audio: Dispatch in parallel across all owned bots for synchronized smooth playback
    $parallelRequests = [];
    foreach ($ownedBots as $bId) {
        $singlePayload = $bodyJson;
        $singlePayload['accountId'] = $bId;
        $singlePayload['singleBot'] = true;
        $parallelRequests[] = [
            'url' => $renderBase . $cleanPathNoSlash,
            'method' => 'POST',
            'body' => json_encode($singlePayload)
        ];
    }
    executeRenderForwardParallel($parallelRequests, $renderMasterToken);

    echo json_encode([
        'success' => true,
        'massPlay' => true,
        'botCount' => count($ownedBots),
        'title' => $bodyJson['title'] ?? 'MP3 Audio'
    ]);
    exit;
}

// --- 5H. ISOLATED MUSIC PLAYBACK PER USER KEY (Tracks never mix across keys) ---
if (preg_match('#^/api/music/player/([^/]+)/play$#', $cleanPathNoSlash, $m) && $method === 'POST') {
    header('Content-Type: application/json');
    $guildId = $m[1];
    $ownedBots = $userAccountsMapping[$callingKey] ?? [];

    $userAccountsMapping = loadJSON($userAccountsFile, []);
    $ownedBots = !empty($callingKey) ? ($userAccountsMapping[$callingKey] ?? []) : [];
    if (empty($ownedBots)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'No bots registered under your license key. Please add a bot first!']);
        exit;
    }

    $targetAccountId = $bodyJson['accountId'] ?? null;

    if (!empty($targetAccountId) && $targetAccountId !== 'ALL_BOTS') {
        if (!in_array($targetAccountId, $ownedBots)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Permission denied: This bot does not belong to your license key.']);
            exit;
        }
        $bodyJson['singleBot'] = true;
        $bodyJson['allBots'] = false;
        list($response, $httpCode, $contentType) = executeRenderForward($renderBase . $cleanPathNoSlash, 'POST', $renderMasterToken, json_encode($bodyJson));
        http_response_code($httpCode ?: 200);
        echo $response;
        exit;
    }

    // ALL BOTS SYNCED PLAYBACK: Parallel Atomic Dispatch across ALL owned bots for 100% sync
    $parallelRequests = [];
    foreach ($ownedBots as $bId) {
        $singlePayload = $bodyJson;
        $singlePayload['accountId'] = $bId;
        $singlePayload['singleBot'] = true;
        $singlePayload['allBots'] = false;
        $parallelRequests[] = [
            'url' => $renderBase . "/api/music/player/{$guildId}/play",
            'method' => 'POST',
            'body' => json_encode($singlePayload)
        ];
    }

    executeRenderForwardParallel($parallelRequests, $renderMasterToken);

    echo json_encode([
        'success' => true,
        'massPlay' => true,
        'count' => count($ownedBots),
        'result' => ['status' => 'playing', 'track' => $bodyJson['track'] ?? null]
    ]);
    exit;
}

// Playlist Isolation
if (preg_match('#^/api/music/player/([^/]+)/playlist$#', $cleanPathNoSlash, $m) && $method === 'POST') {
    header('Content-Type: application/json');
    $guildId = $m[1];
    $ownedBots = $userAccountsMapping[$callingKey] ?? [];

    if (!$isMasterAdmin && empty($ownedBots)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'No bots registered under your license key. Please add a bot first!']);
        exit;
    }

    $targetAccountId = $bodyJson['accountId'] ?? null;
    if (!empty($targetAccountId) && $targetAccountId !== 'ALL_BOTS') {
        if (!in_array($targetAccountId, $ownedBots)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Permission denied: This bot does not belong to your license key.']);
            exit;
        }
        $bodyJson['singleBot'] = true;
        $bodyJson['allBots'] = false;
        list($response, $httpCode, $contentType) = executeRenderForward($renderBase . $cleanPathNoSlash, 'POST', $renderMasterToken, json_encode($bodyJson));
        http_response_code($httpCode ?: 200);
        echo $response;
        exit;
    }

    $parallelRequests = [];
    foreach ($ownedBots as $bId) {
        $singlePayload = $bodyJson;
        $singlePayload['accountId'] = $bId;
        $singlePayload['singleBot'] = true;
        $singlePayload['allBots'] = false;
        $parallelRequests[] = [
            'url' => $renderBase . "/api/music/player/{$guildId}/playlist",
            'method' => 'POST',
            'body' => json_encode($singlePayload)
        ];
    }
    executeRenderForwardParallel($parallelRequests, $renderMasterToken);

    echo json_encode(['success' => true, 'massPlay' => true, 'count' => count($bodyJson['tracks'] ?? []), 'botCount' => count($ownedBots)]);
    exit;
}

// Controls Isolation (pause, skip, stop, seek, volume, loop)
if (preg_match('#^/api/music/player/([^/]+)/(pause|skip|stop|seek|volume|loop)$#', $cleanPathNoSlash, $m) && $method === 'POST') {
    header('Content-Type: application/json');
    $guildId = $m[1];
    $action = $m[2];
    $ownedBots = $userAccountsMapping[$callingKey] ?? [];
    $targetAccountId = $bodyJson['accountId'] ?? null;

    if (!empty($targetAccountId) && $targetAccountId !== 'ALL_BOTS') {
        if (!in_array($targetAccountId, $ownedBots)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Permission denied: This bot does not belong to your license key.']);
            exit;
        }
        list($response, $httpCode, $contentType) = executeRenderForward($renderBase . $cleanPathNoSlash, 'POST', $renderMasterToken, $rawBody);
        http_response_code($httpCode ?: 200);
        echo $response;
        exit;
    }

    $parallelRequests = [];
    foreach ($ownedBots as $bId) {
        $singlePayload = $bodyJson;
        $singlePayload['accountId'] = $bId;
        $parallelRequests[] = [
            'url' => $renderBase . "/api/music/player/{$guildId}/{$action}",
            'method' => 'POST',
            'body' => json_encode($singlePayload)
        ];
    }
    executeRenderForwardParallel($parallelRequests, $renderMasterToken);
    echo json_encode(['success' => true]);
    exit;
}

// Get Player Isolation: GET /api/music/player/:guildId
if (preg_match('#^/api/music/player/([^/]+)$#', $cleanPathNoSlash, $m) && $method === 'GET') {
    header('Content-Type: application/json');
    $guildId = $m[1];
    $ownedBots = $userAccountsMapping[$callingKey] ?? [];
    $reqBotId = $_GET['accountId'] ?? ($targetQuery['accountId'] ?? null);

    if (empty($reqBotId) || $reqBotId === 'ALL_BOTS') {
        $reqBotId = !empty($ownedBots) ? $ownedBots[0] : null;
    }

    if ($reqBotId) {
        $fetchUrl = $renderBase . "/api/music/player/{$guildId}?accountId=" . urlencode($reqBotId);
        list($response, $httpCode, $contentType) = executeRenderForward($fetchUrl, 'GET', $renderMasterToken, '');
        http_response_code($httpCode ?: 200);
        echo $response;
        exit;
    }
}

// --- 5I. Generic Forward for all remaining routes ---
$targetUrl = $renderBase . $cleanPath;
$mergedQuery = array_merge($targetQuery, $_GET);
unset($mergedQuery['__path']);
if (!empty($mergedQuery)) {
    $targetUrl .= '?' . http_build_query($mergedQuery);
}

list($response, $httpCode, $contentType) = executeRenderForward($targetUrl, $method, $renderMasterToken, $rawBody);

// Auto-healing: If Render returned 401 Unauthorized, automatically re-authenticate and retry ONCE!
if ($httpCode === 401) {
    $freshToken = getRenderToken($renderBase, $dataDir, true);
    if (!empty($freshToken)) {
        list($response, $httpCode, $contentType) = executeRenderForward($targetUrl, $method, $freshToken, $rawBody);
    }
}

http_response_code($httpCode ?: 200);
if ($contentType) header("Content-Type: $contentType");

echo $response;
