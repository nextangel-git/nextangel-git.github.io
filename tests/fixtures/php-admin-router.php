<?php
// Local test fixture, never shipped in public/. Only mocked GitHub transport.
declare(strict_types=1);
ini_set('display_errors', '0');
require dirname(__DIR__, 2) . '/public/api/admin-core.php';
$_SERVER['HTTPS'] = 'on';
try {
    $transport = static function ($method, $path, $payload) {
        if ($method === 'GET' && strpos($path, '/contents/src/data/houses.json') !== false) return ['status'=>200,'data'=>['sha'=>str_repeat('a',40),'encoding'=>'base64','content'=>base64_encode('[]')]];
        throw new RuntimeException('Network disabled in test fixture');
    };
    $config = getenv('JKS_PHP_TEST_DIR') . '/config.php';
    if (isset($_GET['missing_config'])) $config .= '.missing';
    $captchaTransport = static function ($url, $payload, $form) {
        return ['status'=>200, 'data'=>['status'=>($payload['token'] ?? '') === 'TEST_CAPTCHA_TOKEN' ? 'ok' : 'failed', 'host'=>'jks.ooo']];
    };
    $api = new JksAdminApi($config, $transport, $captchaTransport);
    JksAdminApi::reply(200, $api->dispatch());
} catch (JksApiError $error) {
    JksAdminApi::reply($error->status, ['error'=>$error->errorCode,'message'=>$error->getMessage()]);
} catch (Throwable $error) {
    JksAdminApi::reply(503, ['error'=>'test_unavailable','message'=>'Test fixture failure']);
}
