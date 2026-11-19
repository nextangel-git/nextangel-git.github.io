<?php
declare(strict_types=1);
// Local CLI only. Never publish this script, feed secrets only over stdin/env.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/public/api/admin-schema.php';

try {
    $options = getopt('', ['output:', 'stdin']);
    $output = $options['output'] ?? '';
    if (!is_string($output) || !preg_match('~\A(?:[A-Za-z]:[\\\\/]|/)~', $output) || basename($output) !== 'config.php') throw new RuntimeException('Укажите --output с абсолютным путём к config.php вне webroot.');
    if (isset($options['stdin'])) {
        $raw = stream_get_contents(STDIN, 16385);
        if ($raw === false || strlen($raw) > 16384) throw new RuntimeException('Слишком большой входной JSON.');
        $input = json_decode($raw, true); unset($raw);
        if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) throw new RuntimeException('Нужен JSON из stdin: username, name, password, github_token.');
    } else {
        $input = ['username'=>getenv('JKS_ADMIN_USERNAME'), 'name'=>getenv('JKS_ADMIN_NAME'), 'password'=>getenv('JKS_ADMIN_PASSWORD'), 'github_token'=>getenv('JKS_GITHUB_TOKEN')];
    }
    $username = is_string($input['username'] ?? null) ? strtolower(trim($input['username'])) : '';
    if (!preg_match('/\A[a-z0-9_.-]{1,64}\z/D', $username)) throw new RuntimeException('Логин: латиница, цифры, точка, дефис или подчёркивание, до 64 символов.');
    $name = is_string($input['name'] ?? null) && trim($input['name']) !== '' ? trim($input['name']) : $username;
    JksAdminSchema::text($name, 200, true);
    $password = JksAdminSchema::password($input['password'] ?? null);
    $token = $input['github_token'] ?? null;
    if (!is_string($token) || strlen($token) < 20 || strlen($token) > 512 || preg_match('/\s|[\x00-\x1f\x7f]/', $token)) throw new RuntimeException('Нужен токен GitHub без пробелов и переводов строк.');
    $directory = dirname($output);
    $normalize = static function (string $path): string {
        $parts = [];
        foreach (explode('/', str_replace('\\', '/', $path)) as $part) {
            if ($part === '' || $part === '.') continue;
            if ($part === '..') { array_pop($parts); continue; }
            $parts[] = $part;
        }
        return strtolower('/' . implode('/', $parts));
    };
    $webroots = [dirname(__DIR__) . '/public', dirname(__DIR__) . '/dist', '/home/jksooo/jks.ooo/docs'];
    foreach ($webroots as $webroot) { $real = realpath($webroot); if ($real !== false) $webroots[] = $real; }
    $rejectWebroot = static function (string $path) use ($webroots, $normalize): void {
        foreach ($webroots as $webroot) {
            if (strpos($normalize($path) . '/', $normalize($webroot) . '/') === 0) throw new RuntimeException('Конфигурацию запрещено создавать внутри webroot (public, dist или NIC docs).');
        }
    };
    $rejectWebroot($directory);
    // Resolve existing ancestors as well, so symlinks cannot bypass the webroot check.
    $ancestor = $directory;
    while (!is_dir($ancestor) && dirname($ancestor) !== $ancestor) $ancestor = dirname($ancestor);
    $resolvedAncestor = realpath($ancestor);
    if (!$resolvedAncestor) throw new RuntimeException('Не удалось определить родительский каталог.');
    $rejectWebroot($resolvedAncestor . substr($directory, strlen($ancestor)));
    $previousUmask = umask(0077);
    try {
        if (!is_dir($directory) && !mkdir($directory, 0700, true)) throw new RuntimeException('Не удалось создать приватный каталог.');
        $resolved = realpath($directory);
        if (!$resolved) throw new RuntimeException('Не удалось определить приватный каталог.');
        $rejectWebroot($resolved);
        $hash = password_hash($password, PASSWORD_DEFAULT);
        if ($hash === false) throw new RuntimeException('Не удалось создать хеш пароля.');
        $config = ['users'=>[$username=>['password_hash'=>$hash,'name'=>$name,'enabled'=>true]], 'github_token'=>$token];
        $contents = "<?php\n// Private configuration: keep outside the webroot.\nreturn " . var_export($config, true) . ";\n";
        $stream = @fopen($output, 'x');
        if (!$stream) throw new RuntimeException('Файл уже существует или недоступен. Перезапись запрещена.');
        @chmod($output, 0600);
        try {
            $offset = 0;
            while ($offset < strlen($contents)) {
                $written = fwrite($stream, substr($contents, $offset));
                if ($written === false || $written === 0) throw new RuntimeException('Не удалось полностью записать конфигурацию.');
                $offset += $written;
            }
            if (!fflush($stream)) throw new RuntimeException('Не удалось сохранить конфигурацию.');
            if (function_exists('fsync')) fsync($stream);
        } finally { fclose($stream); }
    } finally { umask($previousUmask); }
    unset($input, $password, $token, $contents, $config, $hash);
    echo json_encode(['created'=>true,'config_path'=>$output,'username'=>$username,'uploaded'=>false], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
} catch (Throwable $error) {
    // Validation messages only; never print inputs, hashes or tokens.
    fwrite(STDERR, $error instanceof JksApiError || $error instanceof RuntimeException ? $error->getMessage() . "\n" : "Не удалось создать приватную конфигурацию.\n");
    exit(1);
}
