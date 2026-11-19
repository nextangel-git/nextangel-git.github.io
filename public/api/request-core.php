<?php
declare(strict_types=1);
require_once __DIR__ . '/captcha-core.php';

final class JksRequestApi {
    const BODY_LIMIT = 32768;
    const TOPICS = ['Сантехника','Электрика','Отопление','Уборка подъезда / территории','Шум / соседи','Вопрос по квитанции','Заказ платной услуги','Другое'];
    private $privateDir;
    private $captcha;
    private $transport;
    public function __construct(string $privateDir, ?callable $transport = null) {
        $this->privateDir = $privateDir; $this->transport = $transport;
        $this->captcha = new JksCaptcha($privateDir . '/captcha.php', $transport);
    }
    public static function reply(int $status, array $payload): void {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff'); header('X-Frame-Options: DENY');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }
    private static function field($value, int $max, bool $multiline = false): string {
        if (!is_string($value) || !preg_match('//u', $value)) throw new JksApiError(422, 'validation', 'Проверьте обязательные поля обращения.');
        $value = trim($value);
        if ($value === '' || preg_match_all('/./us', $value) > $max || preg_match($multiline ? '/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/' : '/[\x00-\x1f\x7f]/', $value)) throw new JksApiError(422, 'validation', 'Проверьте обязательные поля обращения и длину текста.');
        return $value;
    }
    private function rateLimit(): void {
        $file = @fopen($this->privateDir . '/request-limits.json', 'c+');
        if (!$file) throw new JksApiError(503, 'request_unavailable', 'Отправка обращений временно недоступна.');
        @chmod($this->privateDir . '/request-limits.json', 0600);
        try {
            if (!flock($file, LOCK_EX)) throw new RuntimeException('Lock unavailable');
            $raw = stream_get_contents($file, 1048577);
            if ($raw === false || strlen($raw) > 1048576) throw new RuntimeException('Invalid rate state');
            $state = $raw === '' ? [] : json_decode($raw, true);
            if (!is_array($state)) throw new RuntimeException('Invalid rate state');
            $now = time();
            foreach ($state as $key=>$times) {
                $state[$key] = is_array($times) ? array_values(array_filter($times, static function ($at) use ($now) { return is_int($at) && $at > $now - 900; })) : [];
                if (!$state[$key]) unset($state[$key]);
            }
            $key = hash('sha256', (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'));
            if (count($state[$key] ?? []) >= 20) { header('Retry-After: 900'); throw new JksApiError(429, 'rate_limit', 'Слишком много обращений. Повторите через 15 минут или позвоните в УК.'); }
            if (!isset($state[$key]) && count($state) >= 10000) throw new RuntimeException('Rate capacity');
            $state[$key][] = $now; $json = json_encode($state);
            rewind($file);
            if (!ftruncate($file, 0) || fwrite($file, $json) !== strlen($json) || !fflush($file)) throw new RuntimeException('Rate write failed');
        } catch (JksApiError $error) { throw $error;
        } catch (Throwable $error) { throw new JksApiError(503, 'request_unavailable', 'Отправка обращений временно недоступна.');
        } finally { flock($file, LOCK_UN); fclose($file); }
    }
    public function submit(stdClass $body): array {
        if (array_diff(array_keys(get_object_vars($body)), ['fio','phone','house','flat','topic','text','pdn','company','captchaToken','requestId'])) throw new JksApiError(422, 'validation', 'Некорректные поля обращения.');
        if (($body->company ?? '') !== '') throw new JksApiError(422, 'validation', 'Не удалось отправить обращение. Проверьте поля формы.');
        if (($body->pdn ?? null) !== true) throw new JksApiError(422, 'consent_required', 'Подтвердите согласие на обработку персональных данных.');
        $fio = self::field($body->fio ?? null, 150); $phone = self::field($body->phone ?? null, 30);
        $house = self::field($body->house ?? null, 180); $flat = self::field($body->flat ?? null, 20);
        $topic = self::field($body->topic ?? null, 80); $text = self::field($body->text ?? null, 5000, true);
        $digits = preg_replace('/\D/', '', $phone);
        if (!preg_match('/\A[+0-9() .-]+\z/D', $phone) || strlen($digits) < 10 || strlen($digits) > 15 || !in_array($topic, self::TOPICS, true)) throw new JksApiError(422, 'validation', 'Проверьте телефон и тему обращения.');
        $requestId = $body->requestId ?? null;
        if (!is_string($requestId) || !preg_match('/\AЖКС-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\z/iDu', $requestId)) throw new JksApiError(422, 'validation', 'Некорректный код обращения. Обновите страницу.');
        $this->rateLimit();
        $this->captcha->verify($body->captchaToken ?? null);
        // Only these fixed fields reach the fixed mail recipient; no client mail options are accepted.
        $payload = ['_subject'=>'Заявка ' . $requestId . ' с сайта: ' . $topic, '_template'=>'table', '_captcha'=>'false',
            'Номер заявки'=>$requestId,'ФИО'=>$fio,'Телефон'=>$phone,'Дом'=>$house,'Квартира'=>$flat,'Тема'=>$topic,'Описание'=>$text,'Согласие на обработку персональных данных'=>'Да'];
        try {
            $reply = JksCaptcha::post(JksCaptcha::FORM_URL, $payload, false, $this->transport);
            if (($reply['status'] ?? 0) < 200 || ($reply['status'] ?? 0) >= 300 || !in_array($reply['data']['success'] ?? null, [true, 'true'], true)) throw new RuntimeException('Delivery not confirmed');
        } catch (Throwable $error) { throw new JksApiError(502, 'delivery_unconfirmed', 'Отправка не подтверждена. Повторите проверку «Я не робот» и попробуйте снова либо свяжитесь с УК по телефону или почте.'); }
        return ['success'=>true, 'requestId'=>$requestId];
    }
    public function dispatch(): array {
        if (!in_array($_SERVER['HTTPS'] ?? '', ['on','1'], true) || ($_SERVER['HTTP_HOST'] ?? '') !== 'jks.ooo') throw new JksApiError(403, 'host', 'Форма доступна только на https://jks.ooo.');
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { header('Allow: POST'); throw new JksApiError(405, 'method', 'Нужен POST-запрос.'); }
        if (($_SERVER['HTTP_ORIGIN'] ?? '') !== 'https://jks.ooo' || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') throw new JksApiError(403, 'origin', 'Запрос с другого сайта отклонён.');
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new JksApiError(415, 'content_type', 'Нужен JSON-запрос.');
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > self::BODY_LIMIT) throw new JksApiError(413, 'too_large', 'Слишком большой запрос.');
        $raw = file_get_contents('php://input', false, null, 0, self::BODY_LIMIT + 1);
        if ($raw === false || strlen($raw) > self::BODY_LIMIT) throw new JksApiError(413, 'too_large', 'Слишком большой запрос.');
        $body = json_decode($raw, false, 16); unset($raw);
        if (json_last_error() !== JSON_ERROR_NONE || !$body instanceof stdClass) throw new JksApiError(400, 'invalid_json', 'Некорректный JSON-запрос.');
        return $this->submit($body);
    }
}
