<?php
declare(strict_types=1);
require dirname(__DIR__) . '/public/api/admin-core.php';

$passed = 0;
function check(bool $condition, string $name): void {
    global $passed;
    if (!$condition) throw new RuntimeException('FAILED: ' . $name);
    $passed++;
}
function rejects(callable $fn, int $status, string $name): void {
    try { $fn(); } catch (JksApiError $error) { check($error->status === $status, $name); return; }
    throw new RuntimeException('FAILED: accepted ' . $name);
}
foreach (JksAdminSchema::WRITE_FILES as $file) {
    JksAdminSchema::json($file, file_get_contents(dirname(__DIR__) . '/src/data/' . $file));
    check(true, 'existing data ' . $file);
}
rejects(static function () { JksAdminSchema::readFile('../.env'); }, 422, 'read traversal');
rejects(static function () { JksAdminSchema::ref('other-branch'); }, 422, 'branch allowlist');
rejects(static function () { JksAdminSchema::password('short'); }, 422, 'short password');
rejects(static function () { JksAdminSchema::password('123456789'); }, 422, 'nine-character password');
check(JksAdminSchema::password('1234567890') === '1234567890', 'ten-character password allowed');
rejects(static function () { JksAdminSchema::password(str_repeat('a', 73)); }, 422, 'bcrypt limit');
check(JksAdminSchema::password('НовыйПароль12345') === 'НовыйПароль12345', 'Unicode password');
rejects(static function () { JksAdminSchema::json('useful.json', '[]'); }, 422, 'object vs array');
rejects(static function () { JksAdminSchema::json('houses.json', '[{"street":"Ёлочная","num":"1"},{"street":"елочная","num":"1"}]'); }, 422, 'normalized duplicate');
rejects(static function () { JksAdminSchema::json('news.json', '[{"id":1,"title":"x","date":"31.02.2026"}]'); }, 422, 'invalid date');
rejects(static function () { JksAdminSchema::json('services.json', '[{"cat":"x","items":[{"name":"x","price":-1}]}]'); }, 422, 'negative price');
rejects(static function () { JksAdminSchema::json('faq.json', '[{"q":"q","a":""}]'); }, 422, 'required answer');
rejects(static function () { JksAdminSchema::json('requests.json', '[]'); }, 422, 'readonly collection');
rejects(static function () { JksAdminSchema::json('useful.json', '{"a":{"title":"T","body":"B","source":"javascript:alert(1)"}}'); }, 422, 'unsafe URL');
$sha = str_repeat('a', 40);
$document = (object)['path'=>'src/data/documents.json','expectedSha'=>$sha,'text'=>'[{"name":"PDF","cat":"Общие","url":"/documents/test.pdf"}]'];
$upload = (object)['path'=>'public/documents/test.pdf','base64'=>base64_encode("%PDF-1.4\n%%EOF")];
check(count(JksAdminSchema::commitFiles([$document, $upload])) === 2, 'linked document upload');
rejects(static function () use ($upload) { JksAdminSchema::commitFiles([$upload]); }, 422, 'unlinked upload');
foreach (['public/documents/a.php.pdf','public/documents/a.phtml.jpg','public/documents/a.phar.png','public/documents/a.inc.pdf','public/api/evil.php','.github/workflows/deploy.yml'] as $path) {
    rejects(static function () use ($path, $document) { JksAdminSchema::commitFiles([$document, (object)['path'=>$path,'base64'=>base64_encode('%PDF-')]]); }, 422, 'unsafe upload path');
}
rejects(static function () use ($document) { JksAdminSchema::commitFiles([$document,(object)['path'=>'public/documents/test.pdf','base64'=>base64_encode('<html>bad</html>')]]); }, 422, 'wrong binary signature');
rejects(static function () use ($document) { JksAdminSchema::commitFiles([$document,$document]); }, 422, 'duplicate commit path');

$calls = [];
$transport = static function ($method,$path,$payload) use (&$calls,$sha) {
    $calls[] = [$method,$path,$payload];
    if (strpos($path,'/git/ref/heads/')!==false) return ['status'=>200,'data'=>['object'=>['sha'=>str_repeat('b',40)]]];
    if (strpos($path,'/contents/src/data/')!==false) return ['status'=>200,'data'=>['sha'=>$sha,'encoding'=>'base64','content'=>base64_encode('[]')]];
    if (strpos($path,'/git/commits/'.str_repeat('b',40))!==false) return ['status'=>200,'data'=>['tree'=>['sha'=>str_repeat('c',40)]]];
    if (substr($path,-10)==='/git/blobs') return ['status'=>201,'data'=>['sha'=>str_repeat('d',40)]];
    if (substr($path,-10)==='/git/trees') return ['status'=>201,'data'=>['sha'=>str_repeat('e',40)]];
    if (substr($path,-12)==='/git/commits') return ['status'=>201,'data'=>['sha'=>str_repeat('f',40)]];
    if ($method==='PATCH') return ['status'=>200,'data'=>['object'=>['sha'=>str_repeat('f',40)]]];
    throw new RuntimeException('Unexpected mock route');
};
$api = new JksAdminApi(__DIR__.'/nonexistent-config.php',$transport);
$file=(object)['path'=>'src/data/houses.json','text'=>'[]','expectedSha'=>$sha];
$result=$api->commit((object)['files'=>[$file],'message'=>'test']);
check($result['sha']===str_repeat('f',40),'commit result');
check(end($calls)[2]['force']===false,'non-force ref update');
$tree=array_values(array_filter($calls,static function($call){return substr($call[1],-10)==='/git/trees';}))[0];
check($tree[2]['base_tree']===str_repeat('c',40),'parent tree not commit SHA');
$calls=[];$file->expectedSha=str_repeat('0',40);
rejects(static function() use ($api,$file){$api->commit((object)['files'=>[$file],'message'=>'test']);},409,'stale SHA');
check(count(array_filter($calls,static function($call){return $call[0]!=='GET';}))===0,'no writes after stale SHA');
$_SERVER['HTTPS']='on';$_SERVER['HTTP_HOST']='jks.ooo';$_SERVER['REQUEST_METHOD']='GET';$_GET=['action'=>'session'];
rejects(static function() use($api){$api->dispatch();},503,'missing config');
echo json_encode(['passed'=>$passed,'network_used'=>false]) . "\n";
