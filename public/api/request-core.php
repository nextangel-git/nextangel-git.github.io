<?php
declare(strict_types=1);
require_once __DIR__ . '/captcha-core.php';
require_once __DIR__ . '/request-store.php';

final class JksRequestApi {
    const BODY_LIMIT = 32768;
    const PHOTO_COUNT = 5;
    const PHOTO_LIMIT = 5000000;
    const PHOTOS_LIMIT = 10000000;
    const MULTIPART_LIMIT = self::PHOTOS_LIMIT + self::BODY_LIMIT + 65536;
    const ATTACHMENT_URL = 'https://formsubmit.co/uk@jks.ooo';
    const ACCEPTED_URL = 'https://jks.ooo/request?service=accepted';
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
    private static function photos(array $files, int $expected): array {
        if ($expected<0 || $expected>self::PHOTO_COUNT || array_diff(array_keys($files),['photos'])) throw new JksApiError(422,'photos_count','Можно прикрепить не более 5 фотографий.');
        if (!$files && $expected===0) return [];
        $upload=$files['photos'] ?? null;
        if (!is_array($upload)) throw new JksApiError(422,'photos_missing','Фотографии не загрузились. Выберите их заново.');
        foreach (['name','tmp_name','size','error'] as $field) {
            if (!isset($upload[$field]) || !is_array($upload[$field]) || !array_is_list($upload[$field]) || count($upload[$field])!==$expected) throw new JksApiError(422,'photos_missing','Не все фотографии загрузились. Выберите их заново.');
        }
        $result=[]; $total=0;
        foreach ($upload['error'] as $i=>$error) {
            if (in_array($error,[UPLOAD_ERR_INI_SIZE,UPLOAD_ERR_FORM_SIZE],true)) throw new JksApiError(413,'photo_size','Каждая фотография должна быть не больше 5 МБ.');
            if ($error!==UPLOAD_ERR_OK || !is_string($upload['tmp_name'][$i]) || !is_uploaded_file($upload['tmp_name'][$i])) throw new JksApiError(422,'photo_upload','Фотография загрузилась не полностью. Выберите её заново.');
            $path=$upload['tmp_name'][$i]; $size=filesize($path);
            if ($size===false || $size<1 || $size>self::PHOTO_LIMIT) throw new JksApiError(413,'photo_size','Каждая фотография должна быть от 1 байта до 5 МБ.');
            $total+=$size;
            if ($total>self::PHOTOS_LIMIT) throw new JksApiError(413,'photos_size','Общий размер фотографий не должен превышать 10 МБ.');
            if (!class_exists('finfo')) throw new JksApiError(503,'photos_unavailable','Загрузка фотографий временно недоступна.');
            $mime=(new finfo(FILEINFO_MIME_TYPE))->file($path);
            $extensions=['image/jpeg'=>'jpg','image/png'=>'png','image/webp'=>'webp'];
            $info=@getimagesize($path);
            if (!isset($extensions[$mime]) || !$info || ($info['mime'] ?? '')!==$mime || $info[0]<1 || $info[1]<1) throw new JksApiError(422,'photo_type','Допустимы только фотографии JPG, PNG и WebP. Файл повреждён или имеет другой формат.');
            // Original names and client MIME types never become mail headers or server paths.
            $result[]=['path'=>$path,'mime'=>$mime,'name'=>'photo-'.($i+1).'.'.$extensions[$mime]];
        }
        return $result;
    }
    private function sendPhotos(array $payload, array $photos): void {
        $payload['_next']=self::ACCEPTED_URL;
        $payload['_url']='https://jks.ooo/request';
        $payload['Фотографий']=count($photos);
        // File uploads use FormSubmit's documented multipart endpoint, not its JSON AJAX endpoint.
        if ($this->transport!==null) $reply=call_user_func($this->transport,self::ATTACHMENT_URL,$payload,$photos);
        else {
            if (!function_exists('curl_init') || !class_exists('CURLFile')) throw new RuntimeException('Transport unavailable');
            foreach ($photos as $i=>$photo) $payload['attachment'.($i+1)]=new CURLFile($photo['path'],$photo['mime'],$photo['name']);
            $curl=curl_init(self::ATTACHMENT_URL); $location=''; $buffer='';
            curl_setopt_array($curl,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$payload,CURLOPT_FOLLOWLOCATION=>false,
                CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
                CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>30,CURLOPT_USERAGENT=>'JKS-Server-Forms',
                CURLOPT_HTTPHEADER=>['Origin: https://jks.ooo','Referer: https://jks.ooo/request','Expect:'],
                CURLOPT_HEADERFUNCTION=>static function($c,string $line) use (&$location): int {
                    if (preg_match('/^HTTP\//i',$line)) $location='';
                    if (stripos($line,'Location:')===0) $location=trim(substr($line,9));
                    return strlen($line);
                },
                CURLOPT_WRITEFUNCTION=>static function($c,string $chunk) use (&$buffer): int { if (strlen($buffer)+strlen($chunk)>65536) return 0; $buffer.=$chunk; return strlen($chunk); }]);
            try {
                if (curl_exec($curl)===false) throw new RuntimeException('Delivery unavailable');
                $reply=['status'=>(int)curl_getinfo($curl,CURLINFO_HTTP_CODE),'location'=>$location,'body'=>$buffer];
            } finally { if (PHP_VERSION_ID < 80000) curl_close($curl); }
        }
        if (!self::deliveryAccepted($reply)) throw new RuntimeException('Attachment delivery not confirmed');
    }
    public static function deliveryAccepted(array $reply): bool {
        if (in_array($reply['status'] ?? 0,[302,303],true) && ($reply['location'] ?? '')===self::ACCEPTED_URL) return true;
        // FormSubmit also serves its success page as HTTP 200 instead of following _next.
        // A generic HTTP 200, an activation page or an echoed message is not confirmation.
        $html=$reply['body'] ?? null;
        if (($reply['status'] ?? 0)!==200 || !is_string($html) || strlen($html)>65536 || !class_exists('DOMDocument')) return false;
        $previous=libxml_use_internal_errors(true);
        try {
            $dom=new DOMDocument();$dom->resolveExternals=false;$dom->substituteEntities=false;
            if (!$dom->loadHTML($html,LIBXML_NONET|LIBXML_NOERROR|LIBXML_NOWARNING)) return false;
            $xpath=new DOMXPath($dom);
            $headings=$xpath->query('//h1');
            if ($headings->length!==1 || trim($headings->item(0)->textContent)!=='Thanks!' || $xpath->query('//form')->length) return false;
            $paragraph=$xpath->query('following-sibling::p[1]',$headings->item(0))->item(0);
            if (!$paragraph || strpos(trim($paragraph->textContent),'The form was submitted successfully. Return to original site:')!==0) return false;
            return $xpath->query('./a[@href="https://jks.ooo/request"]',$paragraph)->length===1;
        } finally { libxml_clear_errors();libxml_use_internal_errors($previous); }
    }
    public function submit(stdClass $body, array $files = []): array {
        if (array_diff(array_keys(get_object_vars($body)), ['fio','phone','house','flat','topic','text','pdn','company','captchaToken','requestId','photoCount'])) throw new JksApiError(422, 'validation', 'Некорректные поля обращения.');
        if (($body->company ?? '') !== '') throw new JksApiError(422, 'validation', 'Не удалось отправить обращение. Проверьте поля формы.');
        if (($body->pdn ?? null) !== true) throw new JksApiError(422, 'consent_required', 'Подтвердите согласие на обработку персональных данных.');
        $fio = self::field($body->fio ?? null, 150); $phone = self::field($body->phone ?? null, 30);
        $house = self::field($body->house ?? null, 180); $flat = self::field($body->flat ?? null, 20);
        $topic = self::field($body->topic ?? null, 80); $text = self::field($body->text ?? null, 5000, true);
        $digits = preg_replace('/\D/', '', $phone);
        if (!preg_match('/\A[+0-9() .-]+\z/D', $phone) || strlen($digits) < 10 || strlen($digits) > 15 || !in_array($topic, self::TOPICS, true)) throw new JksApiError(422, 'validation', 'Проверьте телефон и тему обращения.');
        $requestId = $body->requestId ?? null;
        if (!is_string($requestId) || !preg_match('/\AЖКС-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\z/iDu', $requestId)) throw new JksApiError(422, 'validation', 'Некорректный код обращения. Обновите страницу.');
        $photoCount=$body->photoCount ?? 0;
        if (!is_int($photoCount)) throw new JksApiError(422,'photos_count','Некорректное количество фотографий.');
        $photos=self::photos($files,$photoCount);
        $this->rateLimit();
        $this->captcha->verify($body->captchaToken ?? null);
        // Save before sending mail: an upstream outage must not lose a verified request.
        $store=new JksRequestStore($this->privateDir);
        $saved=$store->save(compact('requestId','fio','phone','house','flat','topic','text'),$photos);
        if (!$saved['created']) return ['success'=>true,'saved'=>true,'emailSent'=>in_array($saved['record']['delivery'],['sent','confirmed_by_owner'],true),'requestId'=>$requestId];
        // Only these fixed fields reach the fixed mail recipient; no client mail options are accepted.
        $payload = ['_subject'=>'Заявка ' . $requestId . ' с сайта: ' . $topic, '_template'=>'table', '_captcha'=>'false',
            'Номер заявки'=>$requestId,'ФИО'=>$fio,'Телефон'=>$phone,'Дом'=>$house,'Квартира'=>$flat,'Тема'=>$topic,'Описание'=>$text,'Согласие на обработку персональных данных'=>'Да'];
        $emailSent=false;
        try {
            if ($photos) $this->sendPhotos($payload,$photos);
            else {
                $reply = JksCaptcha::post(JksCaptcha::FORM_URL, $payload, false, $this->transport);
                if (($reply['status'] ?? 0) < 200 || ($reply['status'] ?? 0) >= 300 || !in_array($reply['data']['success'] ?? null, [true, 'true'], true)) throw new RuntimeException('Delivery not confirmed');
            }
            $emailSent=true;
        } catch (Throwable $error) { /* The saved request remains available to authenticated administrators. */ }
        try { $store->delivery($saved['record']['id'],$emailSent?'sent':'unconfirmed'); }
        catch(Throwable $error) { error_log('JKS request delivery status update failed'); }
        return ['success'=>true,'saved'=>true,'emailSent'=>$emailSent,'requestId'=>$requestId];
    }
    public function dispatch(): array {
        if (!in_array($_SERVER['HTTPS'] ?? '', ['on','1'], true) || ($_SERVER['HTTP_HOST'] ?? '') !== 'jks.ooo') throw new JksApiError(403, 'host', 'Форма доступна только на https://jks.ooo.');
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { header('Allow: POST'); throw new JksApiError(405, 'method', 'Нужен POST-запрос.'); }
        if (($_SERVER['HTTP_ORIGIN'] ?? '') !== 'https://jks.ooo' || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') throw new JksApiError(403, 'origin', 'Запрос с другого сайта отклонён.');
        $type=strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
        if ($type==='multipart/form-data') {
            if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0)>self::MULTIPART_LIMIT) throw new JksApiError(413,'too_large','Общий размер фотографий не должен превышать 10 МБ.');
            if (array_keys($_POST)!==['payload'] || !is_string($_POST['payload']) || strlen($_POST['payload'])>self::BODY_LIMIT) throw new JksApiError(422,'photos_upload','Данные или фотографии не загрузились. Проверьте размеры файлов и повторите.');
            $body=json_decode($_POST['payload'],false,16);
            if (json_last_error()!==JSON_ERROR_NONE || !$body instanceof stdClass) throw new JksApiError(400,'invalid_json','Некорректные данные обращения.');
            return $this->submit($body,$_FILES);
        }
        if ($type !== 'application/json') throw new JksApiError(415, 'content_type', 'Нужен JSON или multipart-запрос.');
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > self::BODY_LIMIT) throw new JksApiError(413, 'too_large', 'Слишком большой запрос.');
        $raw = file_get_contents('php://input', false, null, 0, self::BODY_LIMIT + 1);
        if ($raw === false || strlen($raw) > self::BODY_LIMIT) throw new JksApiError(413, 'too_large', 'Слишком большой запрос.');
        $body = json_decode($raw, false, 16); unset($raw);
        if (json_last_error() !== JSON_ERROR_NONE || !$body instanceof stdClass) throw new JksApiError(400, 'invalid_json', 'Некорректный JSON-запрос.');
        return $this->submit($body);
    }
}
