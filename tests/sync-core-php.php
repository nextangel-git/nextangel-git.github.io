<?php
declare(strict_types=1);
require dirname(__DIR__) . '/server/sync/core.php';
$passed = 0;
function checkSync(bool $condition, string $message): void { global $passed; if (!$condition) throw new RuntimeException($message); $passed++; }
function rejectsSync(callable $run, string $code): void {
    try { $run(); } catch (JksSyncError $error) { checkSync($error->getMessage() === $code, 'Expected '.$code.', got '.$error->getMessage()); return; }
    throw new RuntimeException('Expected '.$code);
}
$vk = 'https://vk.com/widget_community.php?gid=189230176';
$mingkh = 'https://dom.mingkh.ru/krasnoyarskiy-kray/sosnovoborsk/?page=1';
$calls = 0;
$http = new JksSyncHttp(static function ($url, $post) use (&$calls) { $calls++; return ['status'=>200,'body'=>'<html>Привет</html>','headers'=>['content-type'=>'text/html; charset=UTF-8']]; });
checkSync($http->fetch($vk) === '<html>Привет</html>', 'UTF8');
checkSync($http->fetch($mingkh, ['captcha_answer'=>'5']) === '<html>Привет</html>', 'Allowed POST');
foreach (['http://vk.com/widget_community.php?gid=189230176','https://vk.com.evil.invalid/widget_community.php?gid=189230176','https://user@vk.com/widget_community.php?gid=189230176','https://vk.com:444/widget_community.php?gid=189230176','https://vk.com/widget_community.php?gid=1','https://dom.mingkh.ru/other','https://dom.mingkh.ru/krasnoyarskiy-kray/sosnovoborsk/?page=21','https://dom.mingkh.ru/krasnoyarskiy-kray/sosnovoborsk/../1','https://dom.mingkh.ru/krasnoyarskiy-kray/sosnovoborsk/%2e%2e/1'] as $url) rejectsSync(static function () use ($http,$url) { $http->fetch($url); }, 'sync_url_forbidden');
rejectsSync(static function () use ($http,$vk) { $http->fetch($vk, ['captcha_answer'=>1]); }, 'sync_url_forbidden');
rejectsSync(static function () use ($http,$mingkh) { $http->fetch($mingkh, ['captcha_answer'=>1,'extra'=>2]); }, 'sync_post_forbidden');
checkSync($calls === 2, 'Forbidden URLs never reach transport');
checkSync($http->fetch('https://mingkh.ru/krasnoyarskiy-kray/sosnovoborsk/1067760313180/houses/')==='<html>Привет</html>','Company listing allowed');
rejectsSync(static function()use($http){$http->fetch('https://mingkh.ru/krasnoyarskiy-kray/sosnovoborsk/1111111111111/houses');},'sync_url_forbidden');
rejectsSync(static function()use($http){$http->fetch('https://mingkh.ru/krasnoyarskiy-kray/sosnovoborsk/1067760313180/houses?anything=1');},'sync_url_forbidden');

$encoded = iconv('UTF-8','Windows-1251','<html>Новость УК</html>');
foreach (['text/html; charset=windows-1251','text/html'] as $type) {
    $http = new JksSyncHttp(static function () use ($encoded,$type) { return ['status'=>200,'body'=>$encoded,'headers'=>['content-type'=>$type]]; });
    checkSync($http->fetch($vk) === '<html>Новость УК</html>', 'VK cp1251 to UTF8');
}
$attempts = 0;
$http = new JksSyncHttp(static function () use (&$attempts) { return ++$attempts < 3 ? ['status'=>503] : ['status'=>200,'body'=>'ok']; });
checkSync($http->fetch($mingkh) === 'ok' && $attempts === 3, 'Two safe GET retries');
$attempts = 0;
$http = new JksSyncHttp(static function () use (&$attempts) { $attempts++; return ['status'=>503]; });
rejectsSync(static function () use ($http,$mingkh) { $http->fetch($mingkh,['captcha_answer'=>1]); }, 'sync_http_status');
checkSync($attempts === 1, 'POST never retries');
foreach ([302,401,403,404] as $status) {
    $attempts=0; $http = new JksSyncHttp(static function () use ($status,&$attempts) { $attempts++; return ['status'=>$status,'headers'=>['location'=>'https://evil.invalid']]; });
    rejectsSync(static function () use ($http,$mingkh) { $http->fetch($mingkh); }, 'sync_http_status');
    checkSync($attempts === 1, 'No redirect or permanent-error retry');
}
$http = new JksSyncHttp(static function () { return ['status'=>200,'body'=>str_repeat('x',JksSyncHttp::LIMIT+1)]; });
rejectsSync(static function () use ($http,$mingkh) { $http->fetch($mingkh); }, 'sync_response_size');
$http = new JksSyncHttp(static function () { throw new RuntimeException('PRIVATE_TRANSPORT_DETAILS'); });
rejectsSync(static function () use ($http,$mingkh) { $http->fetch($mingkh); }, 'sync_transport_failed');
$http = new JksSyncHttp(static function () { return ['status'=>200,'body'=>'ok']; });
for ($i=0;$i<300;$i++) $http->fetch($mingkh);
rejectsSync(static function () use ($http,$mingkh) { $http->fetch($mingkh); }, 'sync_budget_exceeded');
$http = new JksSyncHttp(static function () { throw new RuntimeException('Must not execute'); });
$deadline = new ReflectionProperty($http,'deadline'); if (PHP_VERSION_ID < 80100) $deadline->setAccessible(true); $deadline->setValue($http,microtime(true)-1);
rejectsSync(static function () use ($http,$mingkh) { $http->fetch($mingkh); }, 'sync_budget_exceeded');

$head=str_repeat('a',40); $baseTree=str_repeat('b',40); $blobSha=str_repeat('c',40); $newTree=str_repeat('d',40); $newCommit=str_repeat('e',40);
$currentHead=$head; $events=[]; $failStatus=null; $conflictPatch=false;
$transport = static function ($method,$path,$payload) use (&$currentHead,&$events,&$failStatus,&$conflictPatch,$head,$baseTree,$blobSha,$newTree,$newCommit) {
    $events[]=[$method,$path,$payload];
    checkSync(strpos($path,JksSyncGithub::REPO.'/')===0,'Fixed repository');
    if ($failStatus !== null) return ['status'=>$failStatus,'data'=>['message'=>'secret details']];
    if ($method==='GET' && substr($path,-strlen('/git/ref/heads/main'))==='/git/ref/heads/main') return ['status'=>200,'data'=>['object'=>['sha'=>$currentHead]]];
    if ($method==='GET' && strpos($path,'/git/commits/')!==false) return ['status'=>200,'data'=>['tree'=>['sha'=>$baseTree]]];
    if ($method==='GET' && strpos($path,'/contents/')!==false) {
        checkSync(substr($path,-strlen('?ref='.$head))==='?ref='.$head,'Every content read pinned to immutable HEAD');
        $content = strpos($path,'SUMMARY.md')!==false ? "# Summary\n" : '[]';
        return ['status'=>200,'data'=>['sha'=>$blobSha,'encoding'=>'base64','content'=>base64_encode($content)]];
    }
    if ($method==='POST' && substr($path,-10)==='/git/blobs') return ['status'=>201,'data'=>['sha'=>$blobSha]];
    if ($method==='POST' && substr($path,-10)==='/git/trees') { checkSync($payload['base_tree']===$baseTree,'Preserve base tree'); return ['status'=>201,'data'=>['sha'=>$newTree]]; }
    if ($method==='POST' && substr($path,-12)==='/git/commits') { checkSync($payload['parents']===[$head] && $payload['tree']===$newTree,'Single immutable parent'); return ['status'=>201,'data'=>['sha'=>$newCommit]]; }
    if ($method==='PATCH') { checkSync($payload===['sha'=>$newCommit,'force'=>false],'Never force branch update'); return $conflictPatch ? ['status'=>422,'data'=>[]] : ['status'=>200,'data'=>['object'=>['sha'=>$newCommit]]]; }
    throw new RuntimeException('Unexpected mock request');
};
$github = new JksSyncGithub('TEST_ONLY_TOKEN_NOT_A_SECRET',$transport);
foreach (['../config.php','src/data/users.json','public/api/admin.php'] as $forbidden) rejectsSync(static function () use ($github,$forbidden) {$github->snapshot([$forbidden]);}, 'sync_path_forbidden');
checkSync($events===[], 'Reject paths before GitHub');
$snapshot=$github->snapshot(['src/data/vk_posts.json','SUMMARY.md','src/data/houses.json']);
$events=[];
checkSync($github->commit($snapshot,['src/data/vk_posts.json'=>'[]'],'sync: no change')===['changed'=>false,'commit'=>$head], 'Nochange result');
checkSync($events===[], 'Nochange performs no network calls/writes');
rejectsSync(static function () use ($github,$snapshot) {$github->commit($snapshot,['src/data/unauthorized.json'=>'[{"num":1}]'],'bad');},'sync_path_forbidden');
rejectsSync(static function () use ($github,$snapshot) {$github->commit($snapshot,['src/data/vk_posts.json'=>'{"wrong":"shape"}'],'bad');},'sync_json_invalid');
$tampered=$snapshot; $tampered['tree']=str_repeat('f',40);
rejectsSync(static function () use ($github,$tampered) {$github->commit($tampered,[],'tampered');},'sync_snapshot_invalid');
$currentHead=str_repeat('f',40);
rejectsSync(static function () use ($github,$snapshot) {$github->commit($snapshot,['src/data/vk_posts.json'=>'[{"id":"real-id"}]'],'sync');},'sync_github_conflict');
checkSync(count(array_filter($events,static function ($e) {return $e[0]!=='GET';}))===0,'Advanced HEAD stops before writes');
$currentHead=$head; $events=[];
$result=$github->commit($snapshot,['src/data/vk_posts.json'=>'[{"id":"real-id"}]','SUMMARY.md'=>"# Summary\nUpdated\n"],'sync: VK');
checkSync($result===['changed'=>true,'commit'=>$newCommit],'Atomic commit result');
$writes=array_values(array_filter($events,static function ($e) {return $e[0]!=='GET';}));
checkSync(count($writes)===5 && $writes[4][0]==='PATCH','Two blobs, one tree, one commit, one reference update');
$snapshot=$github->snapshot(['src/data/vk_posts.json']); $conflictPatch=true; $events=[];
rejectsSync(static function () use ($github,$snapshot) {$github->commit($snapshot,['src/data/vk_posts.json'=>'[1]'],'sync race');},'sync_github_conflict');
checkSync(count(array_filter($events,static function ($e) {return $e[0]==='PATCH';}))===1,'Concurrent update fails without write retry');
rejectsSync(static function () use ($github,$snapshot) {$github->commit($snapshot,['src/data/vk_posts.json'=>'[1]'],'retry');},'sync_snapshot_invalid');
$conflictPatch=false; $currentHead=$head; $events=[];
$racing = new JksSyncGithub('TEST_ONLY_TOKEN_NOT_A_SECRET',static function ($method,$path,$payload) use ($transport,&$currentHead) {
    $reply=$transport($method,$path,$payload);
    if ($method==='POST' && substr($path,-12)==='/git/commits') $currentHead=str_repeat('f',40);
    return $reply;
});
$snapshot=$racing->snapshot(['src/data/vk_posts.json']); $events=[];
rejectsSync(static function () use ($racing,$snapshot) {$racing->commit($snapshot,['src/data/vk_posts.json'=>'[1]'],'race while creating objects');},'sync_github_conflict');
checkSync(count(array_filter($events,static function ($e) {return $e[0]==='PATCH';}))===0,'Recheck HEAD after object creation before moving branch');
$currentHead=$head;
foreach ([401=>'sync_github_access',403=>'sync_github_access',409=>'sync_github_conflict',422=>'sync_github_conflict',500=>'sync_github_response',302=>'sync_github_response'] as $status=>$code) {
    $failStatus=$status; rejectsSync(static function () use ($github) {$github->snapshot(['SUMMARY.md']);},$code);
}
$broken = new JksSyncGithub('TEST_ONLY_TOKEN_NOT_A_SECRET',static function () {throw new RuntimeException('SECRET_TOKEN');});
rejectsSync(static function () use ($broken) {$broken->snapshot(['SUMMARY.md']);},'sync_github_transport');
rejectsSync(static function () {new JksSyncGithub(null,null,__DIR__.'/nonexistent-config.php');},'sync_github_config');
echo json_encode(['passed'=>$passed,'network_used'=>false]) . "\n";
