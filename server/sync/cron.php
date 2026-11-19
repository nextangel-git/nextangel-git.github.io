<?php
declare(strict_types=1);
ini_set('display_errors', '0');
// Install this directory outside docs, at .jks-admin/sync/. Never serve over HTTP.
require_once __DIR__ . '/core.php';
require_once __DIR__ . '/vk.php';
require_once __DIR__ . '/mingkh.php';

function jksSyncWrite(string $path, array $data): void {
    if (is_link($path)) throw new RuntimeException('Symlink state refused');
    $temporary = $path . '.' . bin2hex(random_bytes(8)) . '.tmp';
    try {
        $bytes = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
        if (file_put_contents($temporary, $bytes, LOCK_EX) !== strlen($bytes) || !chmod($temporary, 0600) || !rename($temporary, $path)) throw new RuntimeException('State write failed');
    } finally { if (is_file($temporary)) unlink($temporary); }
}

function jksSyncDue(string $kind, array $state, int $now): bool {
    if ($now - (int)($state['last_attempt'] ?? 0) < 3500) return false;
    $last = (int)($state['last_success'] ?? 0);
    if ($kind === 'vk') return $now - $last >= 3500;
    if (!$last) return true;
    $local = (new DateTimeImmutable('@' . $now))->setTimezone(new DateTimeZone('Asia/Krasnoyarsk'));
    $slot = $local->setDate((int)$local->format('Y'), (int)$local->format('m'), 5)->setTime(10, 17)->getTimestamp();
    return $now >= $slot && $last < $slot;
}

function jksSyncRuntime(string $kind, string $stage, float $started): array {
    return ['active_job'=>$kind, 'stage'=>$stage, 'php_version'=>PHP_VERSION,
        'memory_limit'=>(string)ini_get('memory_limit'), 'elapsed_seconds'=>round(max(0,microtime(true)-$started),3),
        'peak_memory_bytes'=>memory_get_peak_usage(true)];
}

function jksSyncAbort(?array &$active, ?string &$reserve): void {
    if ($active === null) return;
    $reserve=null; // Leave enough memory to persist a small diagnostic after memory exhaustion.
    $last=error_get_last();
    $fatal=$last !== null && in_array($last['type'],[E_ERROR,E_PARSE,E_CORE_ERROR,E_COMPILE_ERROR,E_USER_ERROR,E_RECOVERABLE_ERROR],true);
    $state=[];
    foreach (['last_attempt','last_success','last_preview','dry_run','commit'] as $key) if (array_key_exists($key,$active['state'])) $state[$key]=$active['state'][$key];
    $state+=jksSyncRuntime($active['kind'],$active['stage'],$active['started']);
    $state['status']=$fatal ? 'failed' : 'interrupted';
    $state['error']=$fatal ? 'sync_fatal_shutdown' : 'sync_interrupted_shutdown';
    $state['fatal_type']=$fatal ? (int)$last['type'] : null;
    $state['finished_at']=time();
    // Never copy the raw PHP error message, source filename or trace into status/logs.
    $path=$active['path']; $kind=$active['kind']; $active=null;
    try { jksSyncWrite($path,$state); }
    catch (Throwable $ignored) { fwrite(STDERR,"sync_shutdown_status_write_failed\n"); }
    fwrite(STDERR,$kind.': '.$state['error'].'; stage='.$state['stage']."\n");
}

function jksSyncInstallShutdown(?array &$active, ?string &$reserve): void {
    register_shutdown_function(static function () use (&$active,&$reserve): void { jksSyncAbort($active,$reserve); });
}

// Caller must own cron.lock. A stale running state can only be recovered once the old lock is free.
function jksSyncRecoverInterrupted(string $directory): void {
    foreach (['vk','mingkh'] as $kind) {
        $path=$directory.'/'.$kind.'-status.json';
        if (!is_file($path)) continue;
        $state=json_decode(file_get_contents($path),true,32,JSON_THROW_ON_ERROR);
        if (!is_array($state)) throw new RuntimeException('Invalid previous sync state');
        if (($state['status'] ?? '') !== 'running') continue;
        $state['status']='interrupted'; $state['error']='sync_previous_run_interrupted';
        $state['recovered_at']=time(); $state['finished_at']=time();
        // A killed process cannot report its exact end time; do not invent an exact duration.
        $state['elapsed_upper_bound_seconds']=max(0,time()-(int)($state['last_attempt'] ?? time()));
        jksSyncWrite($path,$state);
        echo $kind.": previous run interrupted; lock is free\n";
    }
}

function jksSyncCanonical($value): string {
    $normalize = static function ($item) use (&$normalize) {
        if (!is_array($item)) return $item;
        if (!array_is_list($item)) ksort($item);
        return array_map($normalize, $item);
    };
    return json_encode($normalize($value), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
}

function jksSyncSummary(string $summary, string $kind, array $changes, int $count, array $report): string {
    $start = '<!-- jks-source-sync:start -->'; $end = '<!-- jks-source-sync:end -->';
    $lines = [];
    $pattern = '~' . preg_quote($start, '~') . '(.*?)' . preg_quote($end, '~') . '~s';
    if (preg_match($pattern, $summary, $match)) {
        foreach (explode("\n", $match[1]) as $line) if (strpos($line, '- ') === 0) $lines[] = $line;
    }
    $time = (new DateTimeImmutable('now', new DateTimeZone('Asia/Krasnoyarsk')))->format('d.m.Y H:i');
    $label = $kind === 'vk' ? 'VK' : 'mingkh';
    $line = '- ' . $time . ' (Красноярск): cron NIC.RU, ' . $label . '; получено записей: ' . $count . '; обновлены ' . implode(', ', array_keys($changes)) . '. Сборку и доставку выполняет GitHub Actions.';
    if (!empty($report['ownershipRisks'])) $line .= ' Смена УК требует ручной сверки: ' . count($report['ownershipRisks']) . '; утверждённый перечень ЖКС не изменён.';
    array_unshift($lines, $line);
    $block = $start . "\n## Журнал автоматического обновления\n\n" . implode("\n", array_slice($lines, 0, 30)) . "\n" . $end;
    return preg_match($pattern, $summary) ? preg_replace_callback($pattern, static function () use ($block) { return $block; }, $summary) : rtrim($summary) . "\n\n" . $block . "\n";
}

function jksSyncRun(string $directory, array $arguments): int {
    $allowed = ['--dry-run', '--force', '--only=vk', '--only=mingkh'];
    foreach ($arguments as $argument) if (!in_array($argument, $allowed, true)) throw new RuntimeException('Unknown argument');
    if (in_array('--only=vk', $arguments, true) && in_array('--only=mingkh', $arguments, true)) throw new RuntimeException('Choose one job');
    umask(0077);
    if (!is_file($directory . '/settings.json')) throw new RuntimeException('Private sync settings missing');
    $settings = json_decode(file_get_contents($directory . '/settings.json'), true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($settings) || !is_bool($settings['dry_run'] ?? null)) throw new RuntimeException('Invalid sync settings');
    $dry = $settings['dry_run'] || in_array('--dry-run', $arguments, true);
    $lock = fopen($directory . '/cron.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { echo "Another sync is running; skipped.\n"; return 0; }
    $active=null; $reserve=str_repeat('R',262144);
    jksSyncInstallShutdown($active,$reserve);
    $stage=static function (string $name) use (&$active): void {
        $active['stage']=$name;
        $active['state']=array_merge($active['state'],jksSyncRuntime($active['kind'],$name,$active['started']));
        jksSyncWrite($active['path'],$active['state']);
    };
    $exit = 0;
    try {
        jksSyncRecoverInterrupted($directory);
        foreach (['vk', 'mingkh'] as $kind) {
            if (($settings[$kind] ?? false) !== true) continue;
            if (in_array('--only=' . ($kind === 'vk' ? 'mingkh' : 'vk'), $arguments, true)) continue;
            $statePath = $directory . '/' . $kind . '-status.json';
            $state = is_file($statePath) ? json_decode(file_get_contents($statePath), true, 32, JSON_THROW_ON_ERROR) : [];
            if (!is_array($state)) throw new RuntimeException('Invalid previous sync state');
            if (($state['status'] ?? '')==='interrupted' && time()-(int)($state['last_attempt'] ?? 0)<3500 && !in_array('--force',$arguments,true)) { echo $kind.": interrupted; waiting for hourly retry\n"; continue; }
            $modeChanged = isset($state['dry_run']) && $state['dry_run'] !== $dry;
            if (!$modeChanged && !in_array('--force', $arguments, true) && !jksSyncDue($kind, $state, time())) { echo $kind . ": not due\n"; continue; }
            $state['last_attempt'] = time(); $state['status'] = 'running'; $state['dry_run'] = $dry;
            $started=microtime(true);
            $state=array_merge($state,jksSyncRuntime($kind,'initializing',$started));
            $active=['kind'=>$kind,'path'=>$statePath,'state'=>&$state,'started'=>$started,'stage'=>'initializing'];
            $stage('initializing');
            try {
                $github = new JksSyncGithub();
                $paths = $kind === 'vk' ? ['src/data/vk_posts.json', 'SUMMARY.md'] : ['src/data/houses_geo.json', 'src/data/competitors.json', 'src/data/houses.json', 'SUMMARY.md'];
                $stage('github_snapshot');
                $snapshot = $github->snapshot($paths);
                $http = new JksSyncHttp();
                $source = $kind === 'vk' ? new JksVkSync([$http, 'fetch']) : new JksMingkhSync([$http, 'fetch']);
                $stage('collect');
                $records = $source->collect();
                $stage('rebuild');
                if ($kind === 'vk') $candidate = ['vk_posts.json' => $records];
                else {
                    $read = static function ($name) use ($snapshot) { return json_decode($snapshot['files']['src/data/' . $name]['content'], true, 64, JSON_THROW_ON_ERROR); };
                    $candidate = $source->rebuild($records, $read('houses_geo.json'), $read('competitors.json'), $read('houses.json'));
                }
                $changes = [];
                $stage('compare');
                foreach ($candidate as $name => $data) {
                    $path = 'src/data/' . $name;
                    $previous = json_decode($snapshot['files'][$path]['content'], true, 64, JSON_THROW_ON_ERROR);
                    if (jksSyncCanonical($previous) !== jksSyncCanonical($data)) $changes[$path] = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
                }
                $report = method_exists($source, 'getReport') ? $source->getReport() : [];
                $state['records'] = count($records); $state['changed_files'] = array_keys($changes); $state['report'] = $report;
                if ($changes) {
                    if ($dry) {
                        $stage('preview_write');
                        jksSyncWrite($directory . '/' . $kind . '-preview.json', ['head'=>$snapshot['head'], 'changes'=>$changes, 'report'=>$report]);
                        $state['status'] = 'preview_ready';
                    } else {
                        $stage('github_commit');
                        $changes['SUMMARY.md'] = jksSyncSummary($snapshot['files']['SUMMARY.md']['content'], $kind, $changes, count($records), $report);
                        $result = $github->commit($snapshot, $changes, 'sync: ' . ($kind === 'vk' ? 'посты VK' : 'реестр mingkh') . ' (cron NIC.RU)');
                        $state['commit'] = $result['commit']; $state['status'] = 'committed';
                    }
                } else $state['status'] = 'unchanged';
                $state[$dry ? 'last_preview' : 'last_success'] = time(); $state['error'] = null;
                if (!$dry) { $stage('snapshot_write'); jksSyncWrite($directory . '/' . $kind . '-snapshot.json', $records); }
                echo $kind . ': ' . $state['status'] . '; records=' . count($records) . '; changed=' . count($changes) . "\n";
            } catch (Throwable $error) {
                $exit = 1; $state['status'] = 'failed'; $state['error'] = get_class($error) . ': ' . $error->getMessage();
                // Transport exceptions contain fixed diagnostics, never credentials or response bodies.
                echo $kind . ': failed; ' . $state['error'] . "\n";
            }
            $state['finished_at'] = time();
            $state=array_merge($state,jksSyncRuntime($kind,$active['stage'],$started));
            jksSyncWrite($statePath, $state);
            $active=null;
        }
    } finally { if ($active!==null) jksSyncAbort($active,$reserve); $reserve=null; flock($lock, LOCK_UN); fclose($lock); }
    return $exit;
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
    try { exit(jksSyncRun(__DIR__, array_slice($argv, 1))); }
    catch (Throwable $error) { fwrite(STDERR, 'Sync stopped: ' . $error->getMessage() . "\n"); exit(1); }
}
