<?php
declare(strict_types=1);
require dirname(__DIR__,2).'/public/api/request-core.php';
$_SERVER['HTTPS']='on';
$calls=[];
$transport=static function($url,$payload,$mode) use (&$calls) {
    if ($url===JksCaptcha::VALIDATE_URL) {
        $calls[]=['kind'=>'captcha'];
        return ['status'=>200,'data'=>['status'=>$payload['token']==='valid'?'ok':'failed','host'=>'jks.ooo']];
    }
    if ($url===JksRequestApi::ATTACHMENT_URL) {
        $calls[]=['kind'=>'photos','url'=>$url,'files'=>array_map(static function($p){return ['name'=>$p['name'],'mime'=>$p['mime'],'sha'=>hash_file('sha256',$p['path'])];},$mode),'count'=>$payload['Фотографий']];
        return ['status'=>in_array($_GET['result'] ?? '',['html','thanks'],true)?200:302,'location'=>($_GET['result'] ?? '')==='wrong'?'https://example.invalid':JksRequestApi::ACCEPTED_URL,
            'body'=>($_GET['result'] ?? '')==='thanks'?'<div><h1>Thanks!</h1><p>The form was submitted successfully. Return to original site: <a href="https://jks.ooo/request">Return</a></p></div>':''];
    }
    $calls[]=['kind'=>'text'];return ['status'=>200,'data'=>['success'=>true]];
};
try {
    $api=new JksRequestApi(getenv('JKS_PHP_TEST_DIR'),$transport);
    JksRequestApi::reply(200,$api->dispatch()+['test_calls'=>$calls]);
} catch(JksApiError $e) { JksRequestApi::reply($e->status,['error'=>$e->errorCode,'test_calls'=>$calls]); }
