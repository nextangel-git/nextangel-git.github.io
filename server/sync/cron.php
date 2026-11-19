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
    $exit = 0;
    try {
        foreach (['vk', 'mingkh'] as $kind) {
            if (($settings[$kind] ?? false) !== true) continue;
            if (in_array('--only=' . ($kind === 'vk' ? 'mingkh' : 'vk'), $arguments, true)) continue;
            $statePath = $directory . '/' . $kind . '-status.json';
            $state = is_file($statePath) ? json_decode(file_get_contents($statePath), true, 32, JSON_THROW_ON_ERROR) : [];
            if (!is_array($state)) throw new RuntimeException('Invalid previous sync state');
            $modeChanged = isset($state['dry_run']) && $state['dry_run'] !== $dry;
            if (!$modeChanged && !in_array('--force', $arguments, true) && !jksSyncDue($kind, $state, time())) { echo $kind . ": not due\n"; continue; }
            $state['last_attempt'] = time(); $state['status'] = 'running'; $state['dry_run'] = $dry;
            jksSyncWrite($statePath, $state);
            try {
                $github = new JksSyncGithub();
                $paths = $kind === 'vk' ? ['src/data/vk_posts.json', 'SUMMARY.md'] : ['src/data/houses_geo.json', 'src/data/competitors.json', 'src/data/houses.json', 'SUMMARY.md'];
                $snapshot = $github->snapshot($paths);
                $http = new JksSyncHttp();
                $source = $kind === 'vk' ? new JksVkSync([$http, 'fetch']) : new JksMingkhSync([$http, 'fetch']);
                $records = $source->collect();
                if ($kind === 'vk') $candidate = ['vk_posts.json' => $records];
                else {
                    $read = static function ($name) use ($snapshot) { return json_decode($snapshot['files']['src/data/' . $name]['content'], true, 64, JSON_THROW_ON_ERROR); };
                    $candidate = $source->rebuild($records, $read('houses_geo.json'), $read('competitors.json'), $read('houses.json'));
                }
                $changes = [];
                foreach ($candidate as $name => $data) {
                    $path = 'src/data/' . $name;
                    $previous = json_decode($snapshot['files'][$path]['content'], true, 64, JSON_THROW_ON_ERROR);
                    if (jksSyncCanonical($previous) !== jksSyncCanonical($data)) $changes[$path] = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
                }
                $report = method_exists($source, 'getReport') ? $source->getReport() : [];
                $state['records'] = count($records); $state['changed_files'] = array_keys($changes); $state['report'] = $report;
                if ($changes) {
                    if ($dry) {
                        jksSyncWrite($directory . '/' . $kind . '-preview.json', ['head'=>$snapshot['head'], 'changes'=>$changes, 'report'=>$report]);
                        $state['status'] = 'preview_ready';
                    } else {
                        $changes['SUMMARY.md'] = jksSyncSummary($snapshot['files']['SUMMARY.md']['content'], $kind, $changes, count($records), $report);
                        $result = $github->commit($snapshot, $changes, 'sync: ' . ($kind === 'vk' ? 'посты VK' : 'реестр mingkh') . ' (cron NIC.RU)');
                        $state['commit'] = $result['commit']; $state['status'] = 'committed';
                    }
                } else $state['status'] = 'unchanged';
                $state[$dry ? 'last_preview' : 'last_success'] = time(); $state['error'] = null;
                if (!$dry) jksSyncWrite($directory . '/' . $kind . '-snapshot.json', $records);
                echo $kind . ': ' . $state['status'] . '; records=' . count($records) . '; changed=' . count($changes) . "\n";
            } catch (Throwable $error) {
                $exit = 1; $state['status'] = 'failed'; $state['error'] = get_class($error) . ': ' . $error->getMessage();
                // Transport exceptions contain fixed diagnostics, never credentials or response bodies.
                echo $kind . ': failed; ' . $state['error'] . "\n";
            }
            $state['finished_at'] = time();
            jksSyncWrite($statePath, $state);
        }
    } finally { flock($lock, LOCK_UN); fclose($lock); }
    return $exit;
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
    try { exit(jksSyncRun(__DIR__, array_slice($argv, 1))); }
    catch (Throwable $error) { fwrite(STDERR, 'Sync stopped: ' . $error->getMessage() . "\n"); exit(1); }
}
