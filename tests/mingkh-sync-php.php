<?php
declare(strict_types=1);
require dirname(__DIR__) . '/server/sync/mingkh.php';
$passed=0;
function mkCheck(bool $ok,string $label): void { global $passed; if (!$ok) throw new RuntimeException($label); $passed++; }
function mkReject(callable $call,string $label): void { try {$call();} catch (Throwable $e) {mkCheck(true,$label); return;} throw new RuntimeException('Expected rejection: '.$label); }
function card(int $id, string $override=''): string {
    $uk=$id===1 ? 'УК «Жилкомсервис»' : 'УК «Другая»';
    return '<html><head><meta charset="utf-8"><title>ул. Ленина, '.$id.' — Сосновоборск</title></head><body><h1>ул. Ленина, '.$id.'</h1><p>Дом под управлением '.$uk.' с 01.01.2020</p><table><tr><td>Год постройки</td><td>2000</td></tr><tr><td>Количество этажей</td><td>5</td></tr><tr><td>Количество квартир</td><td>60</td></tr><tr><td>Площадь многоквартирного дома, кв.м</td><td>1&nbsp;234,5</td></tr><tr><td>Износ здания, %</td><td>12,5</td></tr></table>'.$override.'</body></html>';
}
function source(?callable $mutate = null): array {
    $calls=[];
    $fetch=static function(string $url,?array $post=null) use (&$calls,$mutate): string {
        $calls[]=[$url,$post];
        if (strpos($url,'?page=')!==false) {
            $p=(int)substr($url,strpos($url,'?page=')+6); $html='<html><meta charset="utf-8"><h1>Сосновоборск</h1>';
            for($i=($p-1)*17+1;$i<=min($p*17,100);$i++) $html.='<a href="'.JksMingkhSync::CITY.$i.'">ул. Ленина, '.$i.'</a>';
            $html.='<a href="?page=6">6</a></html>';
        } else {$id=(int)basename($url); $html=card($id);}
        return $mutate ? $mutate($url,$post,$html,count($calls)) : $html;
    };
    $sync=new JksMingkhSync($fetch,static function():void{});
    return [$sync,&$calls];
}
[$sync,$calls]=source();
$records=$sync->collect(); mkCheck(count($records)===100,'100 complete source records');
mkCheck($records[0]['area']===1234.5,'NBSP decimal area'); mkCheck($records[0]['wear']===12.5,'Decimal wear preserved');
mkCheck($records[0]['uk']==='УК «Жилкомсервис»','Unicode company parsed');
$malformed=str_replace('</td><td>',' <td> <td>',card(1));
$parsed=JksMingkhSync::parseHouse($malformed,'ул. Ленина, 1','1');
mkCheck($parsed['flats']===60 && $parsed['area']===1234.5,'Empty intermediate source td does not erase values');
$ranged=str_replace(['<td>5</td>','Год постройки'],['<td>11-18</td>','Год ввода в эксплуатацию'],card(1,'<p>17-этажный</p>'));
$parsed=JksMingkhSync::parseHouse($ranged,'ул. Ленина, 1','1');
mkCheck($parsed['floors']===17 && $parsed['year']===null,'Floor range uses agreeing explicit count; commissioning year not construction year');
$disagree=JksMingkhSync::parseHouse(str_replace('17-этажный','20-этажный',$ranged),'ул. Ленина, 1','1');
mkCheck($disagree['floors']===null,'Conflicting floor count stays unknown instead of inventing a single value');
mkReject(static function(){JksMingkhSync::parseHouse('<h1>Сколько будет 2 + 3</h1>','ул. Ленина, 1','1');},'Challenge not a card');
mkReject(static function(){JksMingkhSync::parseHouse('<h1>Service error</h1>','ул. Ленина, 1','1');},'Error not a card');
mkReject(static function(){JksMingkhSync::parseHouse(card(2),'ул. Ленина, 1','1');},'Identity mismatch');
mkReject(static function(){JksMingkhSync::parseHouse(card(10),'ул. Ленина, 1','1');},'House number prefix is not identity');
foreach (['2000'=>'9999','>5<'=>'>999<','>12,5<'=>'>101<','01.01.2020'=>'31.02.2020'] as $from=>$to) {
    mkReject(static function() use($from,$to){JksMingkhSync::parseHouse(str_replace($from,$to,card(1)),'ул. Ленина, 1','1');},'Invalid numeric/date');
}
$repair='<table><tr><th>Вид услуги (работы)</th><th>Год проведения</th></tr><tr><td>Крыша</td><td>2030</td></tr></table>';
mkCheck(JksMingkhSync::parseHouse(card(1,$repair),'ул. Ленина, 1','1')['kapremont'][0]['year']===2030,'Repair labels');
mkReject(static function(){JksMingkhSync::parseHouse(card(1,'<table><tr><th>Работа</th><th>Год проведения</th></tr></table>'),'ул. Ленина, 1','1');},'Changed repair schema');
$challengeState=0;
[$captchaSync,$ignored]=source(static function($url,$post,$html) use (&$challengeState){
    if (substr($url,-2)==='/1') {
        $challengeState++;
        if($post!==null) {mkCheck($post===['captcha_answer'=>'5'],'Arithmetic POST is bounded and exact'); return '<p>Сколько будет 2 + 3</p>';}
        if($challengeState===1) return '<p>Сколько будет 2 + 3</p>';
    }
    return $html;
});
mkCheck(count($captchaSync->collect())===100 && $challengeState===3,'Per-card challenge solved once then verified');
[$blocked,$ignored]=source(static function($url,$post,$html){return substr($url,-2)==='/1' ? '<p>Сколько будет 2 + 3</p>' : $html;});
mkReject(static function()use($blocked){$blocked->collect();},'Persistent challenge aborts');
[$badPage,$ignored]=source(static function($url,$post,$html){return strpos($url,'page=6')!==false ? '<h1>Сосновоборск</h1>' : $html;});
mkReject(static function()use($badPage){$badPage->collect();},'Empty page aborts');
[$tooMany,$ignored]=source(static function($url,$post,$html){return str_replace('?page=6','?page=21',$html);});
mkReject(static function()use($tooMany){$tooMany->collect();},'Pagination capped');
[$expanded,$ignored]=source(static function($url,$post,$html){
    if (strpos($url,'?page=6')!==false) return str_replace('?page=6','?page=7',$html);
    if (strpos($url,'?page=7')!==false) {
        $html='<meta charset="utf-8"><h1>Сосновоборск</h1>';
        for($id=101;$id<=117;$id++) $html.='<a href="'.JksMingkhSync::CITY.$id.'">ул. Ленина, '.$id.'</a>';
    }
    return $html;
});
mkCheck(count($expanded->collect())===117,'Pagination discovers seventh page');
[$collapse,$ignored]=source(static function($url,$post,$html){return preg_replace('/<p>Дом под управлением.*?<\/p>/u','',$html);});
mkReject(static function()use($collapse){$collapse->collect();},'Missing company collapse aborts');
$geo=[['street'=>'Ленина','num'=>'1','lat'=>56.1,'lon'=>93.3,'year'=>1999,'floors'=>5,'flats'=>60,'ukSince'=>'01.01.2010','custom'=>'keep']];
$competitors=[['street'=>'Ленина','num'=>'2','lat'=>56.2,'lon'=>93.4,'uk'=>'УК «Другая»','ukSince'=>'01.01.2010','custom'=>'keep']];
$houses=[['street'=>'Ленина','num'=>'1']];
$portfolio=[['street'=>'Ленина','num'=>'1','sourceId'=>'1','area'=>1300.5,'flats'=>61,'ukSince'=>'01.01.2019']];
$rebuilt=$sync->rebuild($records,$geo,$competitors,$houses,$portfolio);
mkCheck(count($rebuilt['houses_geo.json'])===1 && count($rebuilt['competitors.json'])===99,'One company list controls membership');
mkCheck($rebuilt['houses_geo.json'][0]['lat']===56.1 && $rebuilt['houses_geo.json'][0]['custom']==='keep','Missing source coordinates and custom metadata retained');
mkCheck($rebuilt['houses_geo.json'][0]['area']===1300.5 && $rebuilt['houses_geo.json'][0]['flats']===61,'Totals from the same company listing');
mkCheck(count($sync->getReport()['ownershipRisks'])===0,'Expected company no false risk');
mkCheck(count($sync->getReport()['warnings'])===98,'Unknown competitor coordinates reported');
$changed=$records; $changed[0]['uk']='УК «Новая»'; $changed[0]['ukSince']='01.01.2025'; $changed[0]['year']=null;
$result=$sync->rebuild($changed,$geo,$competitors,$houses,$portfolio);
mkCheck($result['houses_geo.json'][0]['year']===1999,'Missing source field does not erase known year');
mkCheck($result['houses_geo.json'][0]['ukSince']==='01.01.2019','Management date comes from company listing');
mkCheck(count($sync->getReport()['ownershipRisks'])===1,'Conflicting card flagged while company list wins');
$next=[['street'=>'Ленина','num'=>'2','sourceId'=>'2','area'=>1234.5,'flats'=>60,'ukSince'=>'01.01.2020']];
$changed=$records; $changed[1]['lat']=56.21; $changed[1]['lon']=93.41;
$result=$sync->rebuild($changed,$geo,$competitors,$houses,$next);
$active=array_values(array_filter($result['houses.json'],static function($r){return empty($r['archived']);}));
mkCheck(count($active)===1 && $active[0]['num']==='2','New company member added, removed one archived');
$mapped=array_values(array_filter($result['houses_geo.json'],static function($r){return empty($r['archived']);}));
mkCheck(count($mapped)===1 && $mapped[0]['lat']===56.21 && $mapped[0]['flats']===60,'New house gets source coordinates and characteristics');
mkCheck(!array_filter($result['competitors.json'],static function($r){return $r['num']==='2';}),'Transferred house never duplicated among competitors');
mkCheck($sync->getReport()['membership']===['active'=>1,'added'=>1,'removed'=>1],'Membership change reported');
$changed=$records; $changed[99]=$changed[0];
mkReject(static function()use($sync,$changed,$geo,$competitors,$houses,$portfolio){$sync->rebuild($changed,$geo,$competitors,$houses,$portfolio);},'Duplicate source aborts');
$changed=$records; $changed[1]['addr']='ул. Ленина, 999';
mkReject(static function()use($sync,$changed,$geo,$competitors,$houses,$portfolio){$sync->rebuild($changed,$geo,$competitors,$houses,$portfolio);},'Disappeared existing address aborts');
mkReject(static function()use($sync,$records,$geo,$competitors,$houses,$portfolio){$sync->rebuild(array_slice($records,0,99),$geo,$competitors,$houses,$portfolio);},'Short dataset aborts');
$unknown=[['street'=>'Ленина','num'=>'99','sourceId'=>'99','area'=>1234,'flats'=>10]];
mkReject(static function()use($sync,$records,$geo,$competitors,$houses,$unknown){$sync->rebuild($records,$geo,$competitors,$houses,$unknown);},'No verified coordinates for new own house aborts');
$parsed=JksMingkhSync::parseHouse(card(1,'<input id="mapcenterlat" value="56.1234"><input id="mapcenterlng" value="93.3456">'),'ул. Ленина, 1','1');
mkCheck($parsed['lat']===56.1234 && $parsed['lon']===93.3456,'Coordinates parsed from source map');
mkReject(static function(){JksMingkhSync::parseHouse(card(1,'<input id="mapcenterlat" value="60.1234">'),'ул. Ленина, 1','1');},'Wrong-city coordinates rejected');
$company='<p>7703617600 1067760313180 Сосновоборск</p><dl><dd>1 <a href="'.JksMingkhSync::CITY.'1067760313180/houses">список</a></dd></dl>';
$list='<h1>Жилкомсервис — Сосновоборск</h1><table><tbody><tr><td>1</td><td><a href="'.JksMingkhSync::BASE.JksMingkhSync::CITY.'1">ул. Ленина, 1, Сосновоборск</a></td><td>01.01.2020</td><td>5</td><td>60</td><td>2000</td><td>1234.5</td></tr></tbody></table>';
$parsed=JksMingkhSync::parsePortfolio($company,$list);
mkCheck(count($parsed)===1 && $parsed[0]['flats']===60,'Full company list parsed');
mkReject(static function()use($company,$list){JksMingkhSync::parsePortfolio(str_replace('<dd>1','<dd>2',$company),$list);},'Incomplete company listing aborts');
mkReject(static function()use($company,$list){JksMingkhSync::parsePortfolio(str_replace('7703617600','7703617601',$company),$list);},'Wrong company identity aborts');
mkReject(static function()use($company,$list){JksMingkhSync::parsePortfolio($company,str_replace('<td>1234.5</td>','<td></td>',$list));},'Missing area aborts instead of zero total');
echo json_encode(['passed'=>$passed,'network_used'=>false]) . "\n";
