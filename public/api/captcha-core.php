<?php
declare(strict_types=1);
require_once __DIR__ . '/admin-schema.php';

final class JksCaptcha {
    const VALIDATE_URL = 'https://smartcaptcha.cloud.yandex.ru/validate';
    const FORM_URL = 'https://formsubmit.co/ajax/uk@jks.ooo';
    const SITEKEY = 'ysc1_c1z811srDG3allSQnw0xpIy1ubAve2lTWfeKJrLe29c108b2';
    private $configPath;
    private $transport;
    public function __construct(string $configPath, ?callable $transport = null) {
        $this->configPath = $configPath; $this->transport = $transport;
    }
    public static function post(string $url, array $payload, bool $form, ?callable $transport = null): array {
        if (!in_array($url, [self::VALIDATE_URL, self::FORM_URL], true)) throw new RuntimeException('Unsupported upstream');
        if ($transport !== null) return call_user_func($transport, $url, $payload, $form);
        if (!function_exists('curl_init')) throw new RuntimeException('Transport unavailable');
        $curl = curl_init($url); $buffer = '';
        curl_setopt_array($curl, [CURLOPT_POST=>true, CURLOPT_FOLLOWLOCATION=>false,
            CURLOPT_CONNECTTIMEOUT=>5, CURLOPT_TIMEOUT=>15, CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_SSL_VERIFYHOST=>2,
            CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS, CURLOPT_HTTPHEADER=>['Accept: application/json', 'Content-Type: ' . ($form ? 'application/x-www-form-urlencoded' : 'application/json'), 'Origin: https://jks.ooo', 'Referer: https://jks.ooo/request'],
            CURLOPT_USERAGENT=>'JKS-Server-Forms', CURLOPT_POSTFIELDS=>$form ? http_build_query($payload, '', '&', PHP_QUERY_RFC3986) : json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            CURLOPT_WRITEFUNCTION=>static function ($handle, string $chunk) use (&$buffer): int {
                if (strlen($buffer) + strlen($chunk) > 65536) return 0;
                $buffer .= $chunk; return strlen($chunk);
            }]);
        try {
            if (curl_exec($curl) === false) throw new RuntimeException('Upstream unavailable');
            return ['status'=>(int)curl_getinfo($curl, CURLINFO_HTTP_CODE), 'data'=>json_decode($buffer, true)];
        } finally { curl_close($curl); }
    }
    public function verify($token): void {
        if (!is_string($token) || trim($token) === '' || strlen($token) > 8192 || preg_match('/[\x00-\x20\x7f]/', $token)) throw new JksApiError(422, 'captcha_required', 'Подтвердите, что вы не робот.');
        try {
            if (!is_file($this->configPath) || !is_readable($this->configPath)) throw new RuntimeException('Configuration unavailable');
            if (function_exists('opcache_invalidate')) @opcache_invalidate($this->configPath, true);
            $config = (static function ($file) { return require $file; })($this->configPath);
            if (!is_array($config) || ($config['sitekey'] ?? null) !== self::SITEKEY || !is_string($config['secret'] ?? null) || strlen($config['secret']) < 20 || strlen($config['secret']) > 512 || preg_match('/\s|[\x00-\x1f\x7f]/', $config['secret'])) throw new RuntimeException('Configuration invalid');
            $payload = ['secret'=>$config['secret'], 'token'=>$token];
            $ip = $_SERVER['REMOTE_ADDR'] ?? '';
            if (filter_var($ip, FILTER_VALIDATE_IP)) $payload['ip'] = $ip;
            $reply = self::post(self::VALIDATE_URL, $payload, true, $this->transport);
            if (($reply['status'] ?? null) !== 200 || !is_array($reply['data'] ?? null)) throw new RuntimeException('Verification unavailable');
        } catch (Throwable $error) {
            throw new JksApiError(503, 'captcha_unavailable', 'Проверка «Я не робот» временно недоступна. Повторите позже.');
        }
        if (($reply['data']['status'] ?? null) !== 'ok' || ($reply['data']['host'] ?? null) !== 'jks.ooo') throw new JksApiError(403, 'captcha_invalid', 'Проверка «Я не робот» не пройдена или устарела. Пройдите её заново.');
    }
}
