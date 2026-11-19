<?php
declare(strict_types=1);
require dirname(__DIR__) . '/server/sync/cron.php';
$passed=0;
function scheduleCheck(bool $condition): void { global $passed; if (!$condition) throw new RuntimeException('Schedule regression'); $passed++; }
function jksScheduleTime(string $date): int { return (new DateTimeImmutable($date,new DateTimeZone('Asia/Krasnoyarsk')))->getTimestamp(); }
$last=jksScheduleTime('2026-10-05 10:17:00');
scheduleCheck(jksSyncCanonical(['area'=>null])!==jksSyncCanonical(['area'=>0]));
scheduleCheck(jksSyncCanonical(['area'=>'3'])!==jksSyncCanonical(['area'=>3]));
scheduleCheck(jksSyncCanonical(['a'=>3,'b'=>false])===jksSyncCanonical(['b'=>false,'a'=>3.0]));
scheduleCheck(!jksSyncDue('mingkh',['last_success'=>$last],jksScheduleTime('2026-11-05 10:16:59')));
scheduleCheck(jksSyncDue('mingkh',['last_success'=>$last],jksScheduleTime('2026-11-05 10:17:00')));
scheduleCheck(!jksSyncDue('mingkh',['last_success'=>jksScheduleTime('2026-11-05 10:17:01')],jksScheduleTime('2026-11-19 10:17:00')));
scheduleCheck(jksSyncDue('mingkh',[],jksScheduleTime('2026-11-19 10:17:00')));
scheduleCheck(!jksSyncDue('vk',['last_attempt'=>5000],5100));
scheduleCheck(jksSyncDue('vk',['last_success'=>5000,'last_attempt'=>5000],8600));
scheduleCheck(jksSyncDue('vk',['last_success'=>5000,'last_attempt'=>5000],8500));
scheduleCheck(!jksSyncDue('vk',['last_success'=>5000,'last_attempt'=>5000],8499));
$summary="# Site\n\n## Manual notes\nKeep this.\n";
for($i=0;$i<35;$i++) $summary=jksSyncSummary($summary,'vk',['src/data/vk_posts.json'=>'[]'],10,[]);
scheduleCheck(strpos($summary,'Keep this.')!==false);
scheduleCheck(substr_count($summary,'<!-- jks-source-sync:start -->')===1);
scheduleCheck(substr_count($summary,'cron NIC.RU, VK;')===30);
scheduleCheck(strpos(jksSyncSummary($summary,'mingkh',['src/data/houses_geo.json'=>'[]'],147,['ownershipRisks'=>[['street'=>'A']]]),'Расхождения перечня УК и отдельных карточек МинЖКХ: 1')!==false);
$directory=sys_get_temp_dir().'/jks-sync-runtime-'.bin2hex(random_bytes(8)); mkdir($directory,0700);
try {
    jksSyncWrite($directory.'/settings.json',['dry_run'=>true,'vk'=>true,'mingkh'=>false]);
    $initial=['status'=>'running','last_attempt'=>time()-20,'last_success'=>123,'dry_run'=>false,'stage'=>'collect'];
    jksSyncWrite($directory.'/vk-status.json',$initial);
    $held=fopen($directory.'/cron.lock','c'); flock($held,LOCK_EX);
    ob_start(); $result=jksSyncRun($directory,[]); $output=ob_get_clean();
    scheduleCheck($result===0 && strpos($output,'Another sync')!==false);
    scheduleCheck(json_decode(file_get_contents($directory.'/vk-status.json'),true)['status']==='running');
    flock($held,LOCK_UN); fclose($held);
    ob_start(); $result=jksSyncRun($directory,[]); $output=ob_get_clean();
    $recovered=json_decode(file_get_contents($directory.'/vk-status.json'),true);
    scheduleCheck($recovered['status']==='interrupted' && $recovered['error']==='sync_previous_run_interrupted');
    scheduleCheck($recovered['last_attempt']===$initial['last_attempt'] && $recovered['last_success']===123);
    scheduleCheck(strpos($output,'waiting for hourly retry')!==false && $recovered['stage']==='collect');
    scheduleCheck(isset($recovered['elapsed_upper_bound_seconds']) && !isset($recovered['elapsed_seconds']));
    $runtime=jksSyncRuntime('vk','collect',microtime(true)-2);
    scheduleCheck($runtime['php_version']===PHP_VERSION && $runtime['memory_limit']===(string)ini_get('memory_limit'));
    scheduleCheck($runtime['elapsed_seconds']>=2 && $runtime['peak_memory_bytes']>0);
} finally { foreach(glob($directory.'/*') as $file) unlink($file); rmdir($directory); }
echo json_encode(['passed'=>$passed,'network_used'=>false]);
