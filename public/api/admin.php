<?php
declare(strict_types=1);
// Only this endpoint is public. No configuration, token or password hash is shipped.
ini_set('display_errors', '0');
require_once __DIR__ . '/admin-core.php';

try {
    $api = new JksAdminApi(dirname(__DIR__, 2) . '/.jks-admin/config.php');
    JksAdminApi::reply(200, $api->dispatch());
} catch (JksApiError $error) {
    JksAdminApi::reply($error->status, ['error' => $error->errorCode, 'message' => $error->getMessage()]);
} catch (Throwable $error) {
    // Do not return config paths, stack traces, GitHub responses or credentials.
    JksAdminApi::reply(503, ['error' => 'service_unavailable', 'message' => 'Сервис админки временно недоступен. Обратитесь к администратору сайта.']);
}
