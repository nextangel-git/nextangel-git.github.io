<?php
declare(strict_types=1);

final class JksApiError extends RuntimeException {
    public $status;
    public $errorCode;
    public function __construct(int $status, string $code, string $message) {
        parent::__construct($message);
        $this->status = $status;
        $this->errorCode = $code;
    }
}

final class JksAdminSchema {
    const READ_FILES = ['news.json', 'documents.json', 'houses.json', 'houses_geo.json', 'competitors.json', 'shutdowns.json', 'faq.json', 'useful.json', 'services.json', 'vk_posts.json', 'requests.json'];
    const WRITE_FILES = ['news.json', 'documents.json', 'houses.json', 'houses_geo.json', 'shutdowns.json', 'faq.json', 'useful.json', 'services.json'];
    const JSON_LIMIT = 2097152;
    const UPLOAD_LIMIT = 26214400;

    public static function fail(string $message): void {
        throw new JksApiError(422, 'validation', $message);
    }
    public static function readFile($file): string {
        if (!is_string($file) || !in_array($file, self::READ_FILES, true)) self::fail('Неизвестная коллекция.');
        return $file;
    }
    public static function sha($value): string {
        if (!is_string($value) || !preg_match('/\A[a-f0-9]{40}\z/D', $value)) self::fail('Нужна исходная версия файла.');
        return $value;
    }
    public static function ref($value): string {
        if ($value === null || $value === '' || $value === 'main') return 'main';
        return self::sha($value);
    }
    public static function password($password): string {
        if (!is_string($password) || strlen($password) > 72 || strpos($password, "\0") !== false || !preg_match('//u', $password)) self::fail('Пароль должен содержать не более 72 байт UTF-8.');
        if (preg_match_all('/./us', $password) < 10) self::fail('Пароль должен содержать минимум 10 символов.');
        return $password;
    }
    public static function text($value, int $limit = 20000, bool $required = false): void {
        if (!is_string($value) || strlen($value) > $limit || strpos($value, "\0") !== false || !preg_match('//u', $value) || ($required && trim($value) === '')) self::fail('Некорректное текстовое поле.');
    }
    private static function field(stdClass $row, string $field, int $limit, bool $required = false): void {
        if (!property_exists($row, $field)) {
            if ($required) self::fail('Заполните обязательное поле: ' . $field);
            return;
        }
        self::text($row->$field, $limit, $required);
    }
    private static function url($value, bool $local = false): void {
        self::text($value, 2048);
        if ($value === '') return;
        if ($local && preg_match('~\A/documents/[a-z0-9][a-z0-9.-]{0,220}\.(?:pdf|docx?|xlsx?|jpe?g|png)\z~iD', $value)) return;
        $parts = parse_url($value);
        if (!$parts || !isset($parts['scheme'], $parts['host']) || !in_array(strtolower($parts['scheme']), ['http', 'https'], true) || isset($parts['user']) || isset($parts['pass']) || preg_match('/[\x00-\x20\x7f]/', $value)) self::fail('Допустимы только корректные ссылки HTTP/HTTPS.');
    }
    private static function scalarMetadata($value, int $depth = 0): void {
        if ($depth > 6) self::fail('Слишком глубокая структура записи.');
        if (is_string($value)) self::text($value, 524288);
        elseif (is_float($value) && !is_finite($value)) self::fail('Некорректное число.');
        elseif (is_array($value) || $value instanceof stdClass) {
            if (count((array)$value) > 5000) self::fail('Слишком много полей записи.');
            foreach ($value as $key => $nested) {
                if (in_array((string)$key, ['__proto__', 'constructor', 'prototype'], true)) self::fail('Недопустимое имя поля.');
                self::scalarMetadata($nested, $depth + 1);
            }
        } elseif (!is_int($value) && !is_float($value) && !is_bool($value) && $value !== null) self::fail('Некорректный тип поля.');
    }
    private static function date($value, bool $iso = false, bool $time = false): void {
        self::text($value, 20);
        if ($value === '') return;
        $format = $iso ? '!Y-m-d' : ($time ? '!d.m.Y H:i' : '!d.m.Y');
        $date = DateTimeImmutable::createFromFormat($format, $value);
        $expected = $iso ? 'Y-m-d' : ($time ? 'd.m.Y H:i' : 'd.m.Y');
        if (!$date || $date->format($expected) !== $value) self::fail('Некорректная дата.');
    }
    private static function address(stdClass $row): string {
        self::field($row, 'street', 200, true);
        self::field($row, 'num', 40, true);
        if (isset($row->archived) && !is_bool($row->archived)) self::fail('Признак архива должен быть логическим.');
        $value = trim(preg_replace('/\s+/u', ' ', $row->street . '|' . $row->num));
        if (function_exists('mb_strtolower')) return str_replace('ё', 'е', mb_strtolower($value, 'UTF-8'));
        return strtolower(strtr($value, array_combine(preg_split('//u', 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', -1, PREG_SPLIT_NO_EMPTY), preg_split('//u', 'абвгдеежзийклмнопрстуфхцчшщъыьэюя', -1, PREG_SPLIT_NO_EMPTY))));
    }
    public static function json(string $file, string $text) {
        if (!in_array($file, self::WRITE_FILES, true) || strlen($text) > self::JSON_LIMIT) self::fail('Коллекция недоступна для записи или превышен размер JSON.');
        $data = json_decode($text, false, 32);
        if (json_last_error() !== JSON_ERROR_NONE) self::fail('Некорректный JSON.');
        if ($file === 'useful.json') {
            if (!$data instanceof stdClass || count((array)$data) > 2000) self::fail('Статьи должны быть объектом с ключами.');
            foreach ($data as $slug => $row) {
                if (!preg_match('/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/D', $slug) || strlen($slug) > 120 || in_array($slug, ['constructor', 'prototype'], true) || !$row instanceof stdClass) self::fail('Некорректный ключ статьи.');
                self::field($row, 'title', 300, true); self::field($row, 'body', 524288, true);
                if (isset($row->publishedAt)) { self::field($row, 'publishedAt', 16, true); self::date($row->publishedAt, false, true); }
                if (isset($row->source)) self::url($row->source);
            }
        } else {
            if (!is_array($data) || count($data) > 5000) self::fail('Коллекция должна быть массивом не более 5000 записей.');
            $addresses = []; $newsIds = [];
            foreach ($data as $row) {
                if (!$row instanceof stdClass) self::fail('Запись должна быть объектом.');
                if ($file === 'houses.json' || $file === 'houses_geo.json') {
                    $key = self::address($row);
                    if (isset($addresses[$key])) self::fail('В перечне есть повторяющийся адрес.');
                    $addresses[$key] = true;
                    foreach (['lat' => 90, 'lon' => 180] as $field => $limit) {
                        if (isset($row->$field) && ((!is_int($row->$field) && !is_float($row->$field)) || abs($row->$field) > $limit)) self::fail('Некорректные координаты.');
                    }
                } elseif ($file === 'news.json') {
                    self::field($row, 'title', 300, true); self::field($row, 'date', 20, true); self::date($row->date);
                    if (!isset($row->id) || (!is_int($row->id) && !is_string($row->id)) || !preg_match('/\A[a-zA-Z0-9_-]{1,80}\z/D', (string)$row->id)) self::fail('Нужен стабильный идентификатор новости.');
                    if (isset($newsIds[(string)$row->id])) self::fail('Повторяющийся идентификатор новости.');
                    $newsIds[(string)$row->id] = true;
                    if (isset($row->url)) self::url($row->url);
                    if (isset($row->slug) && (!is_string($row->slug) || !preg_match('/\A[a-zA-Z0-9_-]{1,120}\z/D', $row->slug))) self::fail('Некорректный адрес новости.');
                } elseif ($file === 'documents.json') {
                    self::field($row, 'name', 500, true); self::field($row, 'cat', 200, true); self::field($row, 'url', 2048, true); self::url($row->url, true);
                    if (isset($row->year) && (!is_int($row->year) || $row->year < 1900 || $row->year > 2200)) self::fail('Некорректный год документа.');
                } elseif ($file === 'faq.json') {
                    self::field($row, 'q', 1000, true); self::field($row, 'a', 20000, true);
                } elseif ($file === 'shutdowns.json') {
                    self::field($row, 'what', 500, true); self::field($row, 'where', 2000, true);
                    if (isset($row->active) && !is_bool($row->active)) self::fail('Признак активности должен быть логическим.');
                    foreach (['from', 'to'] as $field) if (isset($row->$field)) self::date($row->$field, false, true);
                    if (isset($row->until)) self::date($row->until, true);
                } elseif ($file === 'services.json') {
                    self::field($row, 'cat', 200, true);
                    if (!isset($row->items) || !is_array($row->items) || count($row->items) > 1000) self::fail('Некорректный список услуг.');
                    foreach ($row->items as $service) {
                        if (!$service instanceof stdClass) self::fail('Некорректная услуга.');
                        self::field($service, 'name', 500, true);
                        if (isset($service->price) && ((!is_int($service->price) && !is_float($service->price)) || !is_finite((float)$service->price) || $service->price < 0 || $service->price > 100000000)) self::fail('Некорректная цена.');
                        if (isset($service->priceConfirmed) && !is_bool($service->priceConfirmed)) self::fail('Подтверждение цены должно быть логическим.');
                        if (isset($service->priceConfirmed) && $service->priceConfirmed && !isset($service->price)) self::fail('Нельзя подтвердить пустую цену.');
                    }
                }
            }
        }
        self::scalarMetadata($data);
        return $data;
    }
    public static function commitFiles($files): array {
        if (!is_array($files) || count($files) < 1 || count($files) > 8) self::fail('Коммит должен содержать от 1 до 8 файлов.');
        $result = []; $paths = []; $total = 0; $documents = [];
        foreach ($files as $file) {
            if (!$file instanceof stdClass || !isset($file->path) || !is_string($file->path) || isset($paths[$file->path])) self::fail('Некорректный или повторяющийся путь.');
            foreach (array_keys((array)$file) as $key) if (!in_array($key, ['path', 'text', 'base64', 'expectedSha'], true)) self::fail('Неизвестное поле файла.');
            $paths[$file->path] = true;
            if (strpos($file->path, 'src/data/') === 0) {
                $name = substr($file->path, 9);
                if (!isset($file->text) || !is_string($file->text) || property_exists($file, 'base64')) self::fail('Для JSON нужен текст.');
                self::sha($file->expectedSha ?? null);
                $data = self::json($name, $file->text);
                if ($name === 'documents.json') foreach ($data as $doc) $documents[$doc->url] = true;
                $total += strlen($file->text);
                $result[] = ['path' => $file->path, 'text' => $file->text, 'expectedSha' => $file->expectedSha];
            } else {
                if (!preg_match('~\Apublic/documents/[a-z0-9][a-z0-9.-]{0,180}\.(pdf|docx?|xlsx?|jpe?g|png)\z~D', $file->path, $match) || !isset($file->base64) || !is_string($file->base64) || property_exists($file, 'text') || property_exists($file, 'expectedSha')) self::fail('Недопустимая загрузка документа.');
                if (preg_match('/\.(?:php[0-9]*|phtml|phar|inc|cgi|pl|py|sh|shtml)(?:\.|$)/i', $file->path)) self::fail('Недопустимое составное расширение файла.');
                if (strlen($file->base64) > 34952536) self::fail('Файл превышает 25 МБ.');
                $bytes = base64_decode($file->base64, true);
                if ($bytes === false || strlen($bytes) < 1 || strlen($bytes) > self::UPLOAD_LIMIT || base64_encode($bytes) !== $file->base64) self::fail('Некорректный файл base64.');
                $extension = $match[1];
                $signature = ($extension === 'pdf' && strpos(substr($bytes, 0, 1024), '%PDF-') !== false)
                    || (in_array($extension, ['doc', 'xls'], true) && substr($bytes, 0, 8) === "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1")
                    || (in_array($extension, ['docx', 'xlsx'], true) && substr($bytes, 0, 4) === "PK\x03\x04")
                    || (in_array($extension, ['jpg', 'jpeg'], true) && substr($bytes, 0, 3) === "\xff\xd8\xff")
                    || ($extension === 'png' && substr($bytes, 0, 8) === "\x89PNG\r\n\x1a\n");
                if (!$signature) self::fail('Содержимое файла не соответствует расширению.');
                $total += strlen($bytes); unset($bytes);
                $result[] = ['path' => $file->path, 'base64' => $file->base64];
            }
        }
        if ($total > self::UPLOAD_LIMIT + self::JSON_LIMIT * 2) self::fail('Превышен суммарный размер коммита.');
        foreach ($result as $file) if (isset($file['base64']) && !isset($documents[substr($file['path'], 6)])) self::fail('Документ должен быть связан с записью в documents.json в том же коммите.');
        return $result;
    }
}
