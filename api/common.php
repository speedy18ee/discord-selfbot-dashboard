<?php
// Common API helper for CloudeWave
ini_set('display_errors', 1);
error_reporting(E_ALL);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, x-admin-key');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

header('Content-Type: application/json; charset=utf-8');

define('ADMIN_PASSWORD', 'speedy18ee');
// __DIR__ is <site>/api, so dirname(__DIR__) is <site>
define('DATA_DIR', dirname(__DIR__) . '/data');

if (!function_exists('getallheaders')) {
    function getallheaders() {
        $headers = [];
        foreach ($_SERVER as $name => $value) {
            if (substr($name, 0, 5) == 'HTTP_') {
                $headerName = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($name, 5)))));
                $headers[$headerName] = $value;
            } else if ($name === 'CONTENT_TYPE') {
                $headers['Content-Type'] = $value;
            } else if ($name === 'AUTHORIZATION') {
                $headers['Authorization'] = $value;
            }
        }
        return $headers;
    }
}

function get_json_input() {
    $raw = file_get_contents('php://input');
    if (!$raw) return $_POST;
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function send_json($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit;
}

function load_json_file($filename, $default = []) {
    $path = DATA_DIR . '/' . $filename;
    if (!file_exists($path)) {
        return $default;
    }
    $content = file_get_contents($path);
    $data = json_decode($content, true);
    return is_array($data) ? $data : $default;
}

function save_json_file($filename, $data) {
    if (!is_dir(DATA_DIR)) {
        mkdir(DATA_DIR, 0777, true);
    }
    $path = DATA_DIR . '/' . $filename;
    return file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

function get_bearer_token() {
    $headers = getallheaders();
    $auth = '';
    foreach ($headers as $k => $v) {
        if (strtolower($k) === 'authorization') {
            $auth = $v;
            break;
        }
    }
    if (empty($auth) && isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $auth = $_SERVER['HTTP_AUTHORIZATION'];
    }
    if (empty($auth) && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $auth = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }

    if (preg_match('/Bearer\s(\S+)/i', $auth, $matches)) {
        return $matches[1];
    }
    if (isset($_GET['adminToken'])) return $_GET['adminToken'];
    if (isset($_GET['token'])) return $_GET['token'];
    return null;
}

function require_admin() {
    $token = get_bearer_token();
    if (!$token) {
        send_json(['success' => false, 'error' => 'Unauthorized Admin Access - Missing Token'], 401);
    }
    if ($token === ADMIN_PASSWORD) {
        return true;
    }
    $sessions = load_json_file('admin_sessions.json', []);
    if (in_array($token, $sessions)) {
        return true;
    }
    send_json(['success' => false, 'error' => 'Unauthorized Admin Access - Invalid Session'], 401);
}

function exc_get_current_user() {
    $token = get_bearer_token();
    if (!$token) return null;
    $sessions = load_json_file('user_sessions.json', []);
    return isset($sessions[$token]) ? $sessions[$token] : null;
}

function fetch_discord_profile($token) {
    $token = trim($token, " \t\n\r\0\x0B\"'");
    if (empty($token) || strlen($token) < 25) {
        return null;
    }

    $ch = curl_init('https://discord.com/api/v9/users/@me');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: ' . $token,
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    ]);
    curl_setopt($ch, CURLOPT_TIMEOUT, 3);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 2);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode === 200 && $response) {
        $data = json_decode($response, true);
        if (is_array($data) && isset($data['id'])) {
            $username = $data['username'];
            $globalName = !empty($data['global_name']) ? $data['global_name'] : $username;
            $avatarUrl = '';
            if (!empty($data['avatar'])) {
                $ext = (strpos($data['avatar'], 'a_') === 0) ? 'gif' : 'png';
                $avatarUrl = 'https://cdn.discordapp.com/avatars/' . $data['id'] . '/' . $data['avatar'] . '.' . $ext . '?size=128';
            } else {
                $discrim = isset($data['discriminator']) ? intval($data['discriminator']) : 0;
                $idx = ($discrim === 0) ? ((intval($data['id']) >> 22) % 6) : ($discrim % 5);
                $avatarUrl = 'https://cdn.discordapp.com/embed/avatars/' . $idx . '.png';
            }

            return [
                'id' => $data['id'],
                'username' => $username,
                'global_name' => $globalName,
                'tag' => '@' . $username,
                'avatar' => $avatarUrl
            ];
        }
    }
    return null;
}
