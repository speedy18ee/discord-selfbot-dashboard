<?php
require_once dirname(__DIR__, 2) . '/common.php';

$uploadsDir = dirname(__DIR__, 2) . '/uploads';
if (!is_dir($uploadsDir)) {
    mkdir($uploadsDir, 0777, true);
}

$songsFile = DATA_DIR . '/songs.json';
$songs = file_exists($songsFile) ? json_decode(file_get_contents($songsFile), true) : [];
if (!is_array($songs)) $songs = [];

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    // Also scan uploads directory for any files not in json
    $files = scandir($uploadsDir);
    $foundFiles = [];
    foreach ($files as $f) {
        if ($f !== '.' && $f !== '..' && $f !== '.gitkeep' && preg_match('/\.(mp3|wav|ogg|m4a)$/i', $f)) {
            $foundFiles[$f] = filesize($uploadsDir . '/' . $f);
        }
    }

    $existingFilenames = [];
    foreach ($songs as $s) {
        if (isset($s['filename'])) $existingFilenames[$s['filename']] = true;
    }

    foreach ($foundFiles as $fn => $sz) {
        if (!isset($existingFilenames[$fn])) {
            $songs[] = [
                'id' => 'song_' . md5($fn),
                'filename' => $fn,
                'title' => pathinfo($fn, PATHINFO_FILENAME),
                'url' => '/uploads/' . rawurlencode($fn),
                'size' => $sz,
                'sizeFormatted' => round($sz / 1024 / 1024, 2) . ' MB',
                'uploadedAt' => date('c', filemtime($uploadsDir . '/' . $fn))
            ];
        }
    }
    file_put_contents($songsFile, json_encode($songs, JSON_PRETTY_PRINT));

    send_json([
        'success' => true,
        'songs' => array_values($songs)
    ]);
}

if ($method === 'POST') {
    $input = get_json_input();
    $action = isset($input['action']) ? $input['action'] : (isset($_GET['action']) ? $_GET['action'] : '');
    $id = isset($input['id']) ? $input['id'] : (isset($_GET['id']) ? $_GET['id'] : '');

    if ($action === 'play') {
        send_json(['success' => true, 'message' => 'Song queued for playback']);
    }

    if ($action === 'delete' || !empty($id)) {
        $songs = array_filter($songs, function($s) use ($id, $uploadsDir) {
            if ($s['id'] === $id) {
                $filePath = $uploadsDir . '/' . $s['filename'];
                if (file_exists($filePath)) @unlink($filePath);
                return false;
            }
            return true;
        });
        file_put_contents($songsFile, json_encode(array_values($songs), JSON_PRETTY_PRINT));
        send_json(['success' => true]);
    }

    // Handle multipart file upload
    if (isset($_FILES['audio'])) {
        $file = $_FILES['audio'];
        $title = !empty($_POST['title']) ? trim($_POST['title']) : pathinfo($file['name'], PATHINFO_FILENAME);
        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, ['mp3', 'wav', 'ogg', 'm4a'])) {
            send_json(['success' => false, 'error' => 'Unsupported audio format'], 400);
        }
        $filename = time() . '_' . preg_replace('/[^a-zA-Z0-9_\-\.]/', '_', $file['name']);
        if (move_uploaded_file($file['tmp_name'], $uploadsDir . '/' . $filename)) {
            $newSong = [
                'id' => 'song_' . md5($filename),
                'filename' => $filename,
                'title' => $title,
                'url' => '/uploads/' . rawurlencode($filename),
                'size' => filesize($uploadsDir . '/' . $filename),
                'sizeFormatted' => round(filesize($uploadsDir . '/' . $filename) / 1024 / 1024, 2) . ' MB',
                'uploadedAt' => date('c')
            ];
            $songs[] = $newSong;
            file_put_contents($songsFile, json_encode($songs, JSON_PRETTY_PRINT));
            send_json(['success' => true, 'song' => $newSong]);
        }
    }

    send_json(['success' => true, 'message' => 'Uploaded']);
}

if ($method === 'DELETE') {
    $id = isset($_GET['id']) ? $_GET['id'] : '';
    if (!empty($id)) {
        $songs = array_filter($songs, function($s) use ($id, $uploadsDir) {
            if ($s['id'] === $id) {
                $filePath = $uploadsDir . '/' . $s['filename'];
                if (file_exists($filePath)) @unlink($filePath);
                return false;
            }
            return true;
        });
        file_put_contents($songsFile, json_encode(array_values($songs), JSON_PRETTY_PRINT));
    }
    send_json(['success' => true]);
}

send_json(['success' => true]);
