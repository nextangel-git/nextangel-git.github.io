<?php
declare(strict_types=1);
require_once __DIR__ . '/admin-schema.php';

final class JksAdminApi {
    const ORIGIN = 'https://jks.ooo';
    const REPO = '/repos/nextangel-git/nextangel-git.github.io';
    const BRANCH = 'main';
    const IDLE_SECONDS = 1800;
    const SESSION_SECONDS = 28800;
    const BODY_LIMIT = 39845888;
    const COMMIT_MEMORY_BYTES = 268435456;
    private $configPath;
    private $privateDir;
    private $config;
    private $transport;

    // The production entry point fixes configPath outside webroot and never injects transport.
    public function __construct(string $configPath, ?callable $transport = null) {
        $this->configPath = $configPath;
        $this->privateDir = dirname($configPath);
        $this->transport = $transport;
    }
    public static function reply(int $status, array $payload): void {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store, private');
        header('Pragma: no-cache');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: same-origin');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }
    public static function prepareCommitMemory(): void {
        // A 25 MiB upload also occupies base64, parsed JSON and a GitHub request body.
        $sufficient = static function (): bool {
            $value = trim((string)ini_get('memory_limit'));
            if ($value === '-1') return true;
            if (!preg_match('/\A([0-9]+)\s*([KMG]?)\z/iD', $value, $match)) return false;
            $multipliers = [''=>1, 'K'=>1024, 'M'=>1048576, 'G'=>1073741824];
            return (float)$match[1] * $multipliers[strtoupper($match[2])] >= self::COMMIT_MEMORY_BYTES;
        };
        if ($sufficient()) return;
        if (function_exists('ini_set')) @ini_set('memory_limit', '256M');
        if (!$sufficient()) throw new JksApiError(503, 'upload_memory_limit', 'Для сохранения и загрузки документов серверу нужен лимит памяти PHP не менее 256 МБ. Обратитесь к администратору сайта.');
    }
    private function unavailable(): void {
        throw new JksApiError(503, 'not_configured', 'Админка ещё не настроена. Обратитесь к администратору сайта.');
    }
    private function loadConfig(): array {
        if (!is_file($this->configPath) || !is_readable($this->configPath)) $this->unavailable();
        if (function_exists('opcache_invalidate')) @opcache_invalidate($this->configPath, true);
        $config = (static function ($path) { return require $path; })($this->configPath);
        if (!is_array($config) || !isset($config['users'], $config['github_token']) || !is_array($config['users']) || !$config['users'] || !is_string($config['github_token']) || strlen($config['github_token']) < 10 || preg_match('/[\r\n\x00]/', $config['github_token'])) $this->unavailable();
        foreach ($config['users'] as $username => $user) {
            if (!is_string($username) || !preg_match('/\A[a-z0-9_.-]{1,64}\z/D', $username) || !is_array($user) || !isset($user['password_hash']) || !is_string($user['password_hash']) || strlen($user['password_hash']) < 40) $this->unavailable();
            if ((password_get_info($user['password_hash'])['algoName'] ?? 'unknown') === 'unknown') $this->unavailable();
            if (isset($user['name']) && (!is_string($user['name']) || strlen($user['name']) > 200)) $this->unavailable();
        }
        return $config;
    }
    private function startSession(): void {
        if (session_status() === PHP_SESSION_ACTIVE) return;
        $sessions = $this->privateDir . '/sessions';
        if (!is_dir($sessions) && !@mkdir($sessions, 0700, true)) $this->unavailable();
        if (!is_writable($sessions)) $this->unavailable();
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_trans_sid', '0');
        ini_set('session.gc_maxlifetime', (string)self::SESSION_SECONDS);
        session_save_path($sessions);
        session_name('__Host-jks_admin');
        session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
        if (!session_start()) $this->unavailable();
        if (!isset($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    private function rotate(bool $authenticated = false, string $username = ''): void {
        $_SESSION = [];
        if (!session_regenerate_id(true)) throw new JksApiError(503, 'session_unavailable', 'Не удалось обновить сессию. Повторите вход.');
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        if ($authenticated) {
            $_SESSION['username'] = $username;
            $_SESSION['auth_version'] = hash('sha256', $this->config['users'][$username]['password_hash']);
            $_SESSION['created_at'] = time();
            $_SESSION['last_seen'] = time();
        }
    }
    private function authenticated(): bool {
        if (!isset($_SESSION['username'])) return false;
        $username = $_SESSION['username'];
        $user = $this->config['users'][$username] ?? null;
        $valid = is_array($user) && ($user['enabled'] ?? true) === true
            && isset($_SESSION['auth_version'], $_SESSION['created_at'], $_SESSION['last_seen'])
            && hash_equals(hash('sha256', $user['password_hash']), (string)$_SESSION['auth_version'])
            && time() - (int)$_SESSION['created_at'] < self::SESSION_SECONDS
            && time() - (int)$_SESSION['last_seen'] < self::IDLE_SECONDS;
        if (!$valid) { $this->rotate(); return false; }
        $_SESSION['last_seen'] = time();
        return true;
    }
    private function sessionPayload(bool $authenticated): array {
        $username = $authenticated ? $_SESSION['username'] : null;
        return ['authenticated' => $authenticated, 'user' => $authenticated ? ['username' => $username, 'name' => $this->config['users'][$username]['name'] ?? $username] : null, 'csrf' => $_SESSION['csrf']];
    }
    private function postGuard(): void {
        if (($_SERVER['HTTP_ORIGIN'] ?? '') !== self::ORIGIN || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? 'same-origin') === 'cross-site') throw new JksApiError(403, 'origin', 'Запрос с другого сайта отклонён.');
        $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!is_string($token) || !hash_equals($_SESSION['csrf'], $token)) throw new JksApiError(403, 'csrf', 'Сессия формы устарела. Обновите страницу.');
    }
    private function body(int $limit = 16384): stdClass {
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new JksApiError(415, 'content_type', 'Нужен JSON-запрос.');
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) throw new JksApiError(413, 'too_large', 'Превышен размер запроса.');
        $stream = fopen('php://input', 'rb');
        $raw = stream_get_contents($stream, $limit + 1); fclose($stream);
        if ($raw === false || strlen($raw) > $limit) throw new JksApiError(413, 'too_large', 'Превышен размер запроса.');
        $body = json_decode($raw, false, 32); unset($raw);
        if (json_last_error() !== JSON_ERROR_NONE || !$body instanceof stdClass) throw new JksApiError(400, 'invalid_json', 'Некорректный JSON-запрос.');
        return $body;
    }
    private function rateLimit(string $username): void {
        $file = @fopen($this->privateDir . '/login-limits.json', 'c+');
        if (!$file || !flock($file, LOCK_EX)) $this->unavailable();
        try {
            $raw = stream_get_contents($file);
            $state = $raw === '' ? [] : json_decode($raw, true);
            if (!is_array($state)) $this->unavailable();
            $now = time();
            foreach ($state as $key => $times) {
                if (!is_array($times)) { unset($state[$key]); continue; }
                $state[$key] = array_values(array_filter($times, static function ($at) use ($now) { return is_int($at) && $at > $now - 900; }));
                if (!$state[$key]) unset($state[$key]);
            }
            $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown'; // Never trust client-supplied X-Forwarded-For.
            $keys = [hash('sha256', 'ip:' . $ip) => 10, hash('sha256', 'user:' . $username) => 10];
            foreach ($keys as $key => $limit) {
                if (count($state[$key] ?? []) >= $limit) { header('Retry-After: 900'); throw new JksApiError(429, 'rate_limit', 'Слишком много попыток. Повторите через 15 минут.'); }
                if (!isset($state[$key]) && count($state) >= 10000) $this->unavailable();
            }
            foreach ($keys as $key => $limit) $state[$key][] = $now;
            rewind($file); ftruncate($file, 0);
            if (fwrite($file, json_encode($state)) === false || !fflush($file)) $this->unavailable();
        } finally { flock($file, LOCK_UN); fclose($file); }
    }
    private function login(stdClass $body): array {
        $username = isset($body->username) && is_string($body->username) ? strtolower(trim($body->username)) : '';
        if (!preg_match('/\A[a-z0-9_.-]{1,64}\z/D', $username)) $username = '';
        $this->rateLimit($username);
        $password = isset($body->password) && is_string($body->password) ? $body->password : '';
        $user = $this->config['users'][$username] ?? null;
        $firstUser = reset($this->config['users']);
        $hash = $user['password_hash'] ?? $firstUser['password_hash'];
        // Verify a real hash even for an unknown username, without revealing which field failed.
        $ok = strlen($password) <= 72 && strpos($password, "\0") === false && password_verify($password, $hash);
        if (!$ok || !$user || ($user['enabled'] ?? true) !== true) throw new JksApiError(401, 'invalid_credentials', 'Неверный логин или пароль.');
        $this->rotate(true, $username);
        return $this->sessionPayload(true);
    }
    private function changePassword(stdClass $body): array {
        $username = $_SESSION['username'];
        $current = isset($body->currentPassword) && is_string($body->currentPassword) ? $body->currentPassword : '';
        $this->rateLimit($username);
        if (strlen($current) > 72 || !password_verify($current, $this->config['users'][$username]['password_hash'])) throw new JksApiError(403, 'current_password', 'Текущий пароль неверен.');
        $password = JksAdminSchema::password($body->newPassword ?? null);
        if (hash_equals($current, $password)) JksAdminSchema::fail('Новый пароль должен отличаться от текущего.');
        $lock = @fopen($this->privateDir . '/config.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX)) $this->unavailable();
        $temporary = null;
        try {
            $fresh = $this->loadConfig();
            if (!isset($fresh['users'][$username]) || !hash_equals($fresh['users'][$username]['password_hash'], $this->config['users'][$username]['password_hash'])) throw new JksApiError(409, 'password_changed', 'Пароль уже изменён. Выполните вход заново.');
            $hash = password_hash($password, PASSWORD_DEFAULT);
            if ($hash === false) $this->unavailable();
            $fresh['users'][$username]['password_hash'] = $hash;
            $temporary = tempnam($this->privateDir, '.config-');
            if ($temporary === false || file_put_contents($temporary, "<?php\nreturn " . var_export($fresh, true) . ";\n", LOCK_EX) === false) $this->unavailable();
            @chmod($temporary, 0600);
            if (!rename($temporary, $this->configPath)) $this->unavailable();
            $temporary = null;
            if (function_exists('opcache_invalidate')) @opcache_invalidate($this->configPath, true);
            $this->config = $fresh;
        } finally {
            if ($temporary !== null && is_file($temporary)) @unlink($temporary);
            flock($lock, LOCK_UN); fclose($lock);
        }
        $this->rotate(true, $username);
        return $this->sessionPayload(true);
    }
    private function github(string $method, string $path, ?array $payload = null, bool $allowMissing = false): ?array {
        if (strpos($path, self::REPO . '/') !== 0) throw new JksApiError(500, 'internal', 'Ошибка адреса репозитория.');
        if ($this->transport !== null) {
            $response = call_user_func($this->transport, $method, $path, $payload);
            $status = $response['status']; $data = $response['data'];
        } else {
            if (!function_exists('curl_init')) throw new JksApiError(503, 'github_unavailable', 'На сервере недоступно соединение с репозиторием. Обратитесь к администратору.');
            $curl = curl_init('https://api.github.com' . $path);
            $buffer = ''; $tooLarge = false;
            curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 90, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $this->config['github_token'],
                    'Accept: application/vnd.github+json', 'X-GitHub-Api-Version: 2022-11-28', 'User-Agent: JKS-Server-Admin', 'Content-Type: application/json'],
                CURLOPT_WRITEFUNCTION => static function ($handle, $chunk) use (&$buffer, &$tooLarge) {
                    if (strlen($buffer) + strlen($chunk) > 8388608) { $tooLarge = true; return 0; }
                    $buffer .= $chunk; return strlen($chunk);
                }]);
            if ($payload !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            $ok = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE); curl_close($curl);
            if ($ok === false || $tooLarge) throw new JksApiError(502, 'github_unavailable', 'Не удалось связаться с репозиторием. Повторите позже.');
            $data = $buffer === '' ? [] : json_decode($buffer, true);
            if (!is_array($data)) throw new JksApiError(502, 'github_response', 'Репозиторий вернул некорректный ответ.');
        }
        if ($status === 404 && $allowMissing) return null;
        if ($status === 409 || $status === 422) throw new JksApiError(409, 'conflict', 'Данные изменились в репозитории. Обновите страницу и повторите правку.');
        if ($status === 401 || $status === 403) throw new JksApiError(503, 'repository_access', 'Серверу недоступна запись в репозиторий. Обратитесь к администратору.');
        if ($status < 200 || $status >= 300) throw new JksApiError(502, 'github_unavailable', 'Не удалось выполнить операцию в репозитории. Повторите позже.');
        return $data;
    }
    public function read(string $file, string $ref = 'main'): array {
        $file = JksAdminSchema::readFile($file); $ref = JksAdminSchema::ref($ref);
        $record = $this->github('GET', self::REPO . '/contents/src/data/' . $file . '?ref=' . rawurlencode($ref));
        $sha = JksAdminSchema::sha($record['sha'] ?? null);
        if (($record['encoding'] ?? '') !== 'base64' || !isset($record['content'])) $record = $this->github('GET', self::REPO . '/git/blobs/' . $sha);
        $text = base64_decode(str_replace(["\n", "\r"], '', $record['content'] ?? ''), true);
        if ($text === false || strlen($text) > JksAdminSchema::JSON_LIMIT) throw new JksApiError(502, 'invalid_collection', 'Коллекция слишком велика или повреждена.');
        $data = json_decode($text, false, 32);
        if (json_last_error() !== JSON_ERROR_NONE) throw new JksApiError(502, 'invalid_collection', 'Коллекция содержит некорректный JSON.');
        return ['data' => $data, 'sha' => $sha];
    }
    public function commit(stdClass $body): array {
        $files = JksAdminSchema::commitFiles($body->files ?? null);
        $message = $body->message ?? '';
        JksAdminSchema::text($message, 300, true);
        if (preg_match('/[\r\n]/', $message)) JksAdminSchema::fail('Сообщение коммита должно быть одной строкой.');
        $ref = $this->github('GET', self::REPO . '/git/ref/heads/' . self::BRANCH);
        $head = JksAdminSchema::sha($ref['object']['sha'] ?? null);
        foreach ($files as $file) {
            if (isset($file['expectedSha'])) {
                $current = $this->read(substr($file['path'], 9), $head);
                if (!hash_equals($current['sha'], $file['expectedSha'])) throw new JksApiError(409, 'conflict', 'Данные изменились в репозитории. Обновите страницу и повторите правку.');
            } else {
                $existing = $this->github('GET', self::REPO . '/contents/' . $file['path'] . '?ref=' . $head, null, true);
                if ($existing !== null) throw new JksApiError(409, 'file_exists', 'Файл с таким именем уже существует. Выберите новое имя.');
            }
        }
        $parent = $this->github('GET', self::REPO . '/git/commits/' . $head);
        $treeSha = JksAdminSchema::sha($parent['tree']['sha'] ?? null);
        $tree = [];
        foreach ($files as $file) {
            $blob = $this->github('POST', self::REPO . '/git/blobs', isset($file['base64']) ? ['content' => $file['base64'], 'encoding' => 'base64'] : ['content' => $file['text'], 'encoding' => 'utf-8']);
            $tree[] = ['path' => $file['path'], 'mode' => '100644', 'type' => 'blob', 'sha' => JksAdminSchema::sha($blob['sha'] ?? null)];
        }
        $newTree = $this->github('POST', self::REPO . '/git/trees', ['base_tree' => $treeSha, 'tree' => $tree]);
        $newCommit = $this->github('POST', self::REPO . '/git/commits', ['message' => $message, 'tree' => JksAdminSchema::sha($newTree['sha'] ?? null), 'parents' => [$head]]);
        $sha = JksAdminSchema::sha($newCommit['sha'] ?? null);
        $this->github('PATCH', self::REPO . '/git/refs/heads/' . self::BRANCH, ['sha' => $sha, 'force' => false]);
        return ['commit' => $sha, 'sha' => $sha];
    }
    public function dispatch(): array {
        if (($_SERVER['HTTPS'] ?? '') !== 'on' && ($_SERVER['HTTPS'] ?? '') !== '1') throw new JksApiError(403, 'https_required', 'Для входа нужен HTTPS.');
        if (strtolower($_SERVER['HTTP_HOST'] ?? '') !== 'jks.ooo') throw new JksApiError(403, 'host', 'Админка доступна только на jks.ooo.');
        $this->config = $this->loadConfig();
        $this->startSession();
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        $action = $_GET['action'] ?? 'session';
        if (!is_string($action)) throw new JksApiError(400, 'action', 'Неизвестная операция.');
        $expectedMethod = in_array($action, ['session', 'read'], true) ? 'GET' : 'POST';
        if (!in_array($action, ['session', 'login', 'logout', 'password', 'read', 'commit'], true)) throw new JksApiError(404, 'action', 'Неизвестная операция.');
        if ($method !== $expectedMethod) { header('Allow: ' . $expectedMethod); throw new JksApiError(405, 'method', 'Недопустимый метод запроса.'); }
        $authenticated = $this->authenticated();
        if ($action === 'session') return $this->sessionPayload($authenticated);
        if ($action !== 'login' && !$authenticated) throw new JksApiError(401, 'authentication_required', 'Сессия завершена. Выполните вход.');
        if ($method === 'POST') $this->postGuard();
        if ($action === 'login') return $this->login($this->body());
        if ($action === 'logout') { $this->rotate(); return $this->sessionPayload(false); }
        if ($action === 'password') return $this->changePassword($this->body());
        // Release the session lock for potentially slow GitHub requests.
        session_write_close();
        if ($action === 'read') return $this->read(JksAdminSchema::readFile($_GET['file'] ?? null), JksAdminSchema::ref($_GET['ref'] ?? null));
        self::prepareCommitMemory();
        return $this->commit($this->body(self::BODY_LIMIT));
    }
}
