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
$summary="# Site\n\n## Manual notes\nKeep this.\n";
for($i=0;$i<35;$i++) $summary=jksSyncSummary($summary,'vk',['src/data/vk_posts.json'=>'[]'],10,[]);
scheduleCheck(strpos($summary,'Keep this.')!==false);
scheduleCheck(substr_count($summary,'<!-- jks-source-sync:start -->')===1);
scheduleCheck(substr_count($summary,'cron NIC.RU, VK;')===30);
scheduleCheck(strpos(jksSyncSummary($summary,'mingkh',['src/data/houses_geo.json'=>'[]'],147,['ownershipRisks'=>[['street'=>'A']]]),'Смена УК требует ручной сверки: 1')!==false);
echo json_encode(['passed'=>$passed,'network_used'=>false]);
