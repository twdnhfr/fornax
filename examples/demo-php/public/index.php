<?php
// Minimal app for the `php` preset: no framework, no build step.
header('Content-Type: application/json');
if (($_SERVER['REQUEST_URI'] ?? '/') === '/health') {
    echo json_encode(['ok' => true]);
    return;
}
echo json_encode([
    'app' => 'fornax-demo-php',
    'version' => trim((string) @file_get_contents(__DIR__ . '/../VERSION')) ?: 'dev',
    'php' => PHP_VERSION,
    'user' => posix_getpwuid(posix_geteuid())['name'] ?? null,
]);
