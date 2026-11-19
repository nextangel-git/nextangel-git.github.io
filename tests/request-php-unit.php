<?php
declare(strict_types=1);
require dirname(__DIR__) . '/public/api/request-core.php';
$passed = 0;
function verifyCheck(bool $condition, string $message): void { global $passed; if (!$condition) throw new RuntimeException($message); $passed++; }
function verifyReject(callable $fn, int $status): void {
    try { $fn(); } catch (JksApiError $error) { verifyCheck($error->status === $status, 'Expected HTTP ' . $status . ', got ' . $error->status); return; }
    throw new RuntimeException('Expected rejection ' . $status);
}
$directory = sys_get_temp_dir() . '/jks-request-test-' . bin2hex(random_bytes(10));
mkdir($directory, 0700);
try {
    $config = $directory . '/captcha.php';
    file_put_contents($config, '<?php return ' . var_export(['secret'=>'TEST_ONLY_NO_NETWORK_CAPTCHA', 'sitekey'=>JksCaptcha::SITEKEY], true) . ';');
    $_SERVER['REMOTE_ADDR'] = '192.0.2.1'; $_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.2';
    $calls = []; $captchaReply = ['status'=>200,'data'=>['status'=>'ok','host'=>'jks.ooo']]; $formReply = ['status'=>200,'data'=>['success'=>true]];
    $transport = static function ($url, $payload, $form) use (&$calls, &$captchaReply, &$formReply) {
        $calls[] = [$url,$payload,$form];
        $reply = $url === JksCaptcha::VALIDATE_URL ? $captchaReply : $formReply;
        if ($reply instanceof Throwable) throw $reply;
        return $reply;
    };
    $captcha = new JksCaptcha($config, $transport);
    verifyReject(static function () use ($captcha) { $captcha->verify(''); },422);
    verifyCheck(count($calls) === 0, 'Missing token never reaches network');
    $captcha->verify('test-token');
    verifyCheck($calls[0][1]['ip'] === '192.0.2.1' && $calls[0][2] === true, 'Real IP and urlencoded validation');
    foreach ([[200,['status'=>'failed']], [200,['status'=>'ok','host'=>'evil.invalid']], [200,['status'=>'ok','host'=>'']], [200,['status'=>'ok']], [200,[]]] as $case) {
        $captchaReply = ['status'=>$case[0],'data'=>$case[1]];
        verifyReject(static function () use ($captcha) { $captcha->verify('test-token'); },403);
    }
    foreach ([['status'=>500,'data'=>['status'=>'ok','host'=>'jks.ooo']], ['status'=>200,'data'=>null], new RuntimeException('secret transport details')] as $case) {
        $captchaReply = $case; verifyReject(static function () use ($captcha) { $captcha->verify('test-token'); },503);
    }
    verifyReject(static function () use ($directory,$transport) { (new JksCaptcha($directory.'/missing.php',$transport))->verify('test-token'); },503);
    $captchaReply = ['status'=>200,'data'=>['status'=>'ok','host'=>'jks.ooo']];
    $api = new JksRequestApi($directory,$transport);
    $body = (object)['fio'=>'Иванов Иван','phone'=>'+7 (913) 123-45-67','house'=>'ул. Ленина, 1','flat'=>'12','topic'=>'Сантехника','text'=>'Тестовое описание. Реальное письмо не отправляется.','pdn'=>true,'company'=>'','captchaToken'=>'test-token','requestId'=>'ЖКС-12345678-1234-4123-8123-123456789abc'];
    foreach (['fio','phone','house','flat','topic','text'] as $field) {
        $invalid = clone $body; $invalid->$field = ' '; $calls = [];
        verifyReject(static function () use ($api,$invalid) { $api->submit($invalid); },422);
        verifyCheck(count($calls) === 0, 'Invalid '.$field.' never reaches network');
    }
    foreach (['pdn'=>false, 'company'=>'robot', 'requestId'=>'../../bad', 'phone'=>'123', 'topic'=>'Injected subject', 'extra'=>'evil'] as $field=>$value) {
        $invalid = clone $body; $invalid->$field = $value;
        verifyReject(static function () use ($api,$invalid) { $api->submit($invalid); },422);
    }
    $captchaReply = ['status'=>200,'data'=>['status'=>'failed']]; $calls = [];
    verifyReject(static function () use ($api,$body) { $api->submit($body); },403);
    verifyCheck(count($calls) === 1 && $calls[0][0] === JksCaptcha::VALIDATE_URL, 'Failed captcha never forwards mail');
    $captchaReply = ['status'=>200,'data'=>['status'=>'ok','host'=>'jks.ooo']]; $calls = [];
    $result = $api->submit($body);
    verifyCheck($result === ['success'=>true,'saved'=>true,'emailSent'=>true,'requestId'=>$body->requestId], 'Success contract');
    verifyCheck(count($calls) === 2 && $calls[1][0] === JksCaptcha::FORM_URL && $calls[1][1]['Квартира'] === '12', 'Fixed destination receives required flat');
    verifyCheck(!array_key_exists('captchaToken', $calls[1][1]) && !array_key_exists('secret', $calls[1][1]), 'Captcha secrets not forwarded');
    $store=new JksRequestStore($directory);
    verifyCheck($store->listing()['total']===1 && $store->listing()['data'][0]['delivery']==='sent','Verified request saved privately');
    $calls=[];$api->submit($body);
    verifyCheck(count($calls)===1 && $store->listing()['total']===1,'Same request never duplicates record or email');
    $conflict=clone $body;$conflict->text='Different contents';
    verifyReject(static function() use($api,$conflict){$api->submit($conflict);},409);
    $counter=1;
    foreach ([['status'=>200,'data'=>['success'=>'false']], ['status'=>200,'data'=>[]], ['status'=>503,'data'=>['success'=>true]], new RuntimeException('timeout')] as $case) {
        $body->requestId='ЖКС-12345678-1234-4123-8123-'.sprintf('%012x',$counter++);
        $formReply = $case;$result=$api->submit($body);
        verifyCheck($result['saved'] && !$result['emailSent'],'Mail failure does not lose request');
        verifyCheck($store->record(hash('sha256',$body->requestId))['delivery']==='unconfirmed','Unconfirmed mail marked');
    }
    $body->requestId='ЖКС-12345678-1234-4123-8123-'.sprintf('%012x',$counter++);
    $formReply = ['status'=>200,'data'=>['success'=>'true']]; verifyCheck($api->submit($body)['emailSent'] === true,'String true supported');
    file_put_contents($directory.'/request-limits.json','{}');
    for ($i=0;$i<20;$i++) $api->submit($body);
    $calls = []; verifyReject(static function () use ($api,$body) { $api->submit($body); },429);
    verifyCheck(count($calls) === 0,'Rate rejects before captcha and mail');
    $stored = file_get_contents($directory.'/request-limits.json');
    verifyCheck(strpos($stored,$body->fio) === false && strpos($stored,'192.0.2.1') === false, 'Rate state has no form contents or raw IP');
    $_SERVER = ['HTTPS'=>'on','HTTP_HOST'=>'jks.ooo','REQUEST_METHOD'=>'POST','HTTP_ORIGIN'=>'https://jks.ooo','CONTENT_TYPE'=>'application/json'];
    foreach (['HTTPS'=>'off','HTTP_HOST'=>'evil.invalid','HTTP_ORIGIN'=>'https://evil.invalid'] as $field=>$value) {
        $old=$_SERVER[$field]; $_SERVER[$field]=$value; verifyReject(static function () use ($api) {$api->dispatch();},403); $_SERVER[$field]=$old;
    }
    $_SERVER['CONTENT_LENGTH']=32769; verifyReject(static function () use ($api) {$api->dispatch();},413);
    $success='<div><h1>Thanks!</h1><p>The form was submitted successfully. Return to original site: <a href="https://jks.ooo/request">Return</a></p></div>';
    verifyCheck(JksRequestApi::deliveryAccepted(['status'=>200,'body'=>$success]),'HTML success is recognized');
    foreach (['Thanks!'=>'Activation required','https://jks.ooo/request'=>'https://evil.invalid','<div>'=>'<div><form></form>','The form was submitted successfully.'=>'Delivery failed.'] as $from=>$to) {
        verifyCheck(!JksRequestApi::deliveryAccepted(['status'=>200,'body'=>str_replace($from,$to,$success)]),'Unconfirmed page rejected');
    }
    echo json_encode(['passed'=>$passed,'network_used'=>false]) . "\n";
} finally {
    $items=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($items as $file) { if($file->isDir()) rmdir($file->getPathname());else unlink($file->getPathname()); }
    rmdir($directory);
}
