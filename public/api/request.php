<?php
declare(strict_types=1);
ini_set('display_errors', '0');
require_once __DIR__ . '/request-core.php';
try {
    $api = new JksRequestApi(dirname(__DIR__, 2) . '/.jks-admin');
    JksRequestApi::reply(200, $api->dispatch());
} catch (JksApiError $error) {
    JksRequestApi::reply($error->status, ['error'=>$error->errorCode, 'message'=>$error->getMessage()]);
} catch (Throwable $error) {
    JksRequestApi::reply(503, ['error'=>'request_unavailable', 'message'=>'Отправка обращений временно недоступна. Свяжитесь с УК по телефону или почте.']);
}
