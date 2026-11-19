<?php
declare(strict_types=1);
// Private CLI library. Install in .jks-admin/sync, never in docs/public.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

final class JksSyncError extends RuntimeException {}

final class JksSyncHttp {
    const LIMIT = 2097152;
    private $transport;
    private $handles = [];
    private $deadline;
    private $requests = 0;
    public function __construct(?callable $transport = null) {
        $this->transport = $transport; $this->deadline = microtime(true) + 1200;
    }
    public static function allowedUrl(string $url, ?array $post = null): string {
        $p = parse_url($url);
        if (!is_array($p) || ($p['scheme'] ?? '') !== 'https' || isset($p['user']) || isset($p['pass']) || isset($p['fragment']) || (isset($p['port']) && $p['port'] !== 443) || preg_match('/[\x00-\x20\x7f\\\\]/', $url)) throw new JksSyncError('sync_url_forbidden');
        $host = $p['host'] ?? ''; $path = $p['path'] ?? '';
        parse_str($p['query'] ?? '', $query);
        if ($host === 'vk.com' && $path === '/widget_community.php' && ($query['gid'] ?? '') === '189230176' && $post === null && !array_diff(array_keys($query), ['app','width','_ver','gid','mode','url','height']) && (!isset($query['url']) || $query['url'] === 'https://jks.ooo/')) return $host;
        if ($host === 'dom.mingkh.ru' && preg_match('~\A/krasnoyarskiy-kray/sosnovoborsk/(?:[0-9]+/?)?\z~D', $path)) {
            if (array_diff(array_keys($query), ['page']) || (isset($query['page']) && (!is_string($query['page']) || !preg_match('/\A(?:[1-9]|1[0-9]|20)\z/D', $query['page'])))) throw new JksSyncError('sync_url_forbidden');
            if ($post !== null && (array_keys($post) !== ['captcha_answer'] || !is_scalar($post['captcha_answer']) || !preg_match('/\A-?[0-9]{1,8}\z/D', (string)$post['captcha_answer']))) throw new JksSyncError('sync_post_forbidden');
            return $host;
        }
        if ($host === 'mingkh.ru' && in_array($path, ['/krasnoyarskiy-kray/sosnovoborsk/1067760313180/','/krasnoyarskiy-kray/sosnovoborsk/1067760313180/houses/'],true) && !$query) {
            if ($post !== null && (array_keys($post) !== ['captcha_answer'] || !is_scalar($post['captcha_answer']) || !preg_match('/\A-?[0-9]{1,8}\z/D', (string)$post['captcha_answer']))) throw new JksSyncError('sync_post_forbidden');
            return $host;
        }
        throw new JksSyncError('sync_url_forbidden');
    }
    private function once(string $url, ?array $post, string $host): array {
        if (++$this->requests > 300 || microtime(true) >= $this->deadline) throw new JksSyncError('sync_budget_exceeded');
        if ($this->transport !== null) return call_user_func($this->transport, $url, $post);
        if (!function_exists('curl_init')) throw new JksSyncError('sync_curl_required');
        if (!isset($this->handles[$host])) {
            $this->handles[$host] = curl_init();
            // Separate memory-only cookie jars: VK can never receive Mingkh cookies.
            curl_setopt($this->handles[$host], CURLOPT_COOKIEFILE, '');
        }
        $curl = $this->handles[$host]; $body = ''; $headers = [];
        curl_setopt_array($curl, [CURLOPT_URL=>$url, CURLOPT_FOLLOWLOCATION=>false,
            CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_SSL_VERIFYHOST=>2,
            CURLOPT_CONNECTTIMEOUT=>8, CURLOPT_TIMEOUT=>max(1, min(30, (int)ceil($this->deadline - microtime(true)))),
            CURLOPT_ENCODING=>'', CURLOPT_USERAGENT=>'JKS-site-sync/1.0 (+https://jks.ooo)',
            CURLOPT_REFERER=>$post === null ? '' : $url,
            CURLOPT_HTTPHEADER=>$post === null ? ['Accept: text/html'] : ['Accept: text/html','Content-Type: application/x-www-form-urlencoded'],
            CURLOPT_HEADERFUNCTION=>static function ($handle, string $line) use (&$headers): int {
                if (preg_match('/^HTTP\//i', $line)) $headers = [];
                if (strpos($line, ':') !== false) { [$key,$value] = explode(':', $line, 2); $headers[strtolower(trim($key))] = trim($value); }
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION=>static function ($handle, string $chunk) use (&$body): int {
                if (strlen($body) + strlen($chunk) > self::LIMIT) return 0;
                $body .= $chunk; return strlen($chunk);
            }]);
        curl_setopt($curl, defined('CURLOPT_PROTOCOLS_STR') ? constant('CURLOPT_PROTOCOLS_STR') : CURLOPT_PROTOCOLS, defined('CURLOPT_PROTOCOLS_STR') ? 'https' : CURLPROTO_HTTPS);
        if ($post === null) { curl_setopt($curl, CURLOPT_POST, false); curl_setopt($curl, CURLOPT_HTTPGET, true); }
        else { curl_setopt($curl, CURLOPT_POST, true); curl_setopt($curl, CURLOPT_POSTFIELDS, http_build_query($post, '', '&', PHP_QUERY_RFC3986)); }
        if (curl_exec($curl) === false) throw new JksSyncError('sync_transport_failed');
        return ['status'=>(int)curl_getinfo($curl, CURLINFO_HTTP_CODE), 'body'=>$body, 'headers'=>$headers];
    }
    public function fetch(string $url, ?array $post = null): string {
        $host = self::allowedUrl($url, $post); $reply = null;
        for ($attempt = 0; $attempt < ($post === null ? 3 : 1); $attempt++) {
            try { $reply = $this->once($url, $post, $host); }
            catch (Throwable $error) {
                if ($error instanceof JksSyncError && $error->getMessage() === 'sync_budget_exceeded') throw $error;
                if ($post !== null || $attempt === 2) throw new JksSyncError('sync_transport_failed');
                continue;
            }
            $status = $reply['status'] ?? 0;
            if ($post === null && $attempt < 2 && ($status === 408 || $status === 429 || $status >= 500)) continue;
            break;
        }
        if (($reply['status'] ?? 0) !== 200) throw new JksSyncError('sync_http_status');
        $body = $reply['body'] ?? null;
        if (!is_string($body) || strlen($body) > self::LIMIT) throw new JksSyncError('sync_response_size');
        $type = $reply['headers']['content-type'] ?? '';
        $charset = null;
        if (is_string($type) && preg_match('/charset\s*=\s*["\']?([A-Za-z0-9_-]+)/i', $type, $m)) $charset = strtolower($m[1]);
        if ($charset === null && preg_match('/<meta\b[^>]*charset\s*=\s*["\']?([A-Za-z0-9_-]+)/i', substr($body, 0, 8192), $m)) $charset = strtolower($m[1]);
        if (in_array($charset, ['windows-1251','cp1251'], true) || ($host === 'vk.com' && $charset === null && !preg_match('//u', $body))) {
            if (!function_exists('iconv')) throw new JksSyncError('sync_encoding_unavailable');
            $body = @iconv('Windows-1251', 'UTF-8', $body);
        } elseif ($charset !== null && !in_array($charset, ['utf-8','utf8'], true)) throw new JksSyncError('sync_encoding_unsupported');
        if (!is_string($body) || strlen($body) > self::LIMIT || !preg_match('//u', $body)) throw new JksSyncError('sync_invalid_utf8');
        return $body;
    }
    public function __destruct() { if (PHP_VERSION_ID < 80000) foreach ($this->handles as $handle) curl_close($handle); }
}

final class JksSyncGithub {
    const REPO = '/repos/nextangel-git/nextangel-git.github.io';
    const WRITE_PATHS = ['src/data/vk_posts.json','src/data/houses_geo.json','src/data/competitors.json','src/data/houses.json','src/data/mingkh_sync.json','SUMMARY.md'];
    const READ_PATHS = self::WRITE_PATHS;
    const LIMIT = 2097152;
    private $token;
    private $transport;
    private $lastSnapshot;
    public function __construct(?string $token = null, ?callable $transport = null, ?string $configPath = null) {
        $this->transport = $transport;
        if ($token === null) {
            try {
                $file = $configPath ?? dirname(__DIR__) . '/config.php';
                if (!is_file($file) || !is_readable($file)) throw new RuntimeException();
                $config = (static function ($file) { return require $file; })($file);
                $token = is_array($config) ? ($config['github_token'] ?? null) : null;
            } catch (Throwable $error) { throw new JksSyncError('sync_github_config'); }
        }
        if (!is_string($token) || strlen($token) < 20 || strlen($token) > 512 || preg_match('/[\x00-\x20\x7f]/', $token)) throw new JksSyncError('sync_github_config');
        $this->token = $token;
    }
    private static function sha($sha): string {
        if (!is_string($sha) || !preg_match('/\A[a-f0-9]{40}\z/D', $sha)) throw new JksSyncError('sync_github_invalid_response');
        return $sha;
    }
    private function api(string $method, string $suffix, ?array $payload = null, bool $missing = false): ?array {
        $path = self::REPO . $suffix;
        try {
            if ($this->transport !== null) $reply = call_user_func($this->transport, $method, $path, $payload);
            else {
                if (!function_exists('curl_init')) throw new RuntimeException();
                $curl = curl_init('https://api.github.com' . $path); $body = '';
                curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST=>$method, CURLOPT_FOLLOWLOCATION=>false,
                    CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_SSL_VERIFYHOST=>2,
                    CURLOPT_CONNECTTIMEOUT=>8, CURLOPT_TIMEOUT=>40, CURLOPT_USERAGENT=>'JKS-Private-Sync',
                    CURLOPT_HTTPHEADER=>['Authorization: Bearer ' . $this->token, 'Accept: application/vnd.github+json','X-GitHub-Api-Version: 2022-11-28','Content-Type: application/json'],
                    CURLOPT_WRITEFUNCTION=>static function ($handle, string $chunk) use (&$body): int {
                        // GitHub base64 envelope can be larger than the decoded 2 MiB file.
                        if (strlen($body) + strlen($chunk) > 4194304) return 0;
                        $body .= $chunk; return strlen($chunk);
                    }]);
                curl_setopt($curl, defined('CURLOPT_PROTOCOLS_STR') ? constant('CURLOPT_PROTOCOLS_STR') : CURLOPT_PROTOCOLS, defined('CURLOPT_PROTOCOLS_STR') ? 'https' : CURLPROTO_HTTPS);
                if ($payload !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
                try {
                    if (curl_exec($curl) === false) throw new RuntimeException();
                    $reply = ['status'=>(int)curl_getinfo($curl,CURLINFO_HTTP_CODE),'data'=>json_decode($body,true)];
                } finally { if (PHP_VERSION_ID < 80000) curl_close($curl); }
            }
        } catch (Throwable $error) { throw new JksSyncError('sync_github_transport'); }
        $status = $reply['status'] ?? 0;
        if ($status === 404 && $missing) return null;
        if ($status === 409 || $status === 422) throw new JksSyncError('sync_github_conflict');
        if ($status === 401 || $status === 403) throw new JksSyncError('sync_github_access');
        if ($status < 200 || $status >= 300 || !is_array($reply['data'] ?? null)) throw new JksSyncError('sync_github_response');
        return $reply['data'];
    }
    private function head(): string {
        $ref = $this->api('GET', '/git/ref/heads/main');
        return self::sha($ref['object']['sha'] ?? null);
    }
    public function snapshot(array $paths): array {
        $this->lastSnapshot = null;
        if (!$paths || count($paths) !== count(array_unique($paths))) throw new JksSyncError('sync_paths_invalid');
        foreach ($paths as $path) if (!is_string($path) || !in_array($path, self::READ_PATHS, true)) throw new JksSyncError('sync_path_forbidden');
        $head = $this->head(); $commit = $this->api('GET', '/git/commits/' . $head);
        $snapshot = ['head'=>$head,'tree'=>self::sha($commit['tree']['sha'] ?? null),'files'=>[]];
        foreach ($paths as $path) {
            $record = $this->api('GET', '/contents/' . $path . '?ref=' . $head, null, true);
            if ($record === null) { $snapshot['files'][$path] = ['content'=>'','sha'=>null]; continue; }
            $sha = self::sha($record['sha'] ?? null);
            if (($record['encoding'] ?? '') !== 'base64') $record = $this->api('GET', '/git/blobs/' . $sha);
            if (($record['encoding'] ?? '') !== 'base64' || !is_string($record['content'] ?? null)) throw new JksSyncError('sync_github_invalid_content');
            $content = base64_decode(str_replace(["\r","\n"], '', $record['content']), true);
            if ($content === false || strlen($content) > self::LIMIT || !preg_match('//u', $content)) throw new JksSyncError('sync_github_invalid_content');
            $snapshot['files'][$path] = ['content'=>$content,'sha'=>$sha];
        }
        $this->lastSnapshot = $snapshot;
        return $snapshot;
    }
    public function commit(array $snapshot, array $changedFiles, string $message): array {
        if ($this->lastSnapshot === null || $snapshot !== $this->lastSnapshot) throw new JksSyncError('sync_snapshot_invalid');
        if (trim($message) === '' || strlen($message) > 500 || preg_match('/[\x00-\x1f\x7f]/', $message) || !preg_match('//u', $message)) throw new JksSyncError('sync_message_invalid');
        $changes = [];
        foreach ($changedFiles as $path=>$content) {
            if (!in_array($path, self::WRITE_PATHS, true) || !array_key_exists($path, $snapshot['files'])) throw new JksSyncError('sync_path_forbidden');
            if (!is_string($content) || trim($content) === '' || strlen($content) > self::LIMIT || !preg_match('//u', $content)) throw new JksSyncError('sync_content_invalid');
            if ($path !== 'SUMMARY.md') {
                $decoded = json_decode($content);
                if (json_last_error() !== JSON_ERROR_NONE || ($path==='src/data/mingkh_sync.json' ? !is_object($decoded) : !is_array($decoded))) throw new JksSyncError('sync_json_invalid');
            }
            if ($content !== $snapshot['files'][$path]['content']) $changes[$path] = $content;
        }
        if (!$changes) return ['changed'=>false,'commit'=>$snapshot['head']];
        if ($this->head() !== $snapshot['head']) throw new JksSyncError('sync_github_conflict');
        // Once writes start, an ambiguous network failure must not replay this snapshot.
        $this->lastSnapshot = null;
        $tree = [];
        foreach ($changes as $path=>$content) {
            $blob = $this->api('POST', '/git/blobs', ['content'=>$content,'encoding'=>'utf-8']);
            $tree[] = ['path'=>$path,'mode'=>'100644','type'=>'blob','sha'=>self::sha($blob['sha'] ?? null)];
        }
        $createdTree = $this->api('POST','/git/trees',['base_tree'=>$snapshot['tree'],'tree'=>$tree]);
        $created = $this->api('POST','/git/commits',['message'=>$message,'tree'=>self::sha($createdTree['sha'] ?? null),'parents'=>[$snapshot['head']]]);
        $sha = self::sha($created['sha'] ?? null);
        if ($this->head() !== $snapshot['head']) throw new JksSyncError('sync_github_conflict');
        // No retry of writes. force=false also rejects a branch advance during object creation.
        $updated = $this->api('PATCH','/git/refs/heads/main',['sha'=>$sha,'force'=>false]);
        if (self::sha($updated['object']['sha'] ?? null) !== $sha) throw new JksSyncError('sync_github_invalid_response');
        $this->lastSnapshot = null;
        return ['changed'=>true,'commit'=>$sha];
    }
}
