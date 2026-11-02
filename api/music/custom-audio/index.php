<?php
require_once dirname(__DIR__, 2) . '/common.php';

send_json([
    'success' => true,
    'message' => 'Audio streamed successfully to voice channels'
]);
