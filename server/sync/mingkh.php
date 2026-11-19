<?php
declare(strict_types=1);

// CLI core: callers own HTTP cookies/timeouts and atomic GitHub publication.
final class JksMingkhSync {
    const BASE = 'https://dom.mingkh.ru';
    const CITY = '/krasnoyarskiy-kray/sosnovoborsk/';
    const EXTRA = ['serie','condition','wear','kadastr','landArea','livingArea','commonArea','nonlivingArea','balconies','heating','hotwater','gas','sewage','electricInputs','kapremont'];
    private $fetch;
    private $pause;
    private $requests = 0;
    private $report = ['warnings'=>[], 'ownershipRisks'=>[]];
    public function __construct(callable $fetch, ?callable $pause = null) {
        if (PHP_SAPI !== 'cli') throw new RuntimeException('CLI only');
        $this->fetch = $fetch;
        $this->pause = $pause ?? static function (): void { usleep(600000); };
    }
    public function getReport(): array { return $this->report; }
    private static function text(string $value): string {
        return trim(preg_replace('/\s+/u', ' ', html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8')) ?? '');
    }
    private static function lower(string $value): string {
        return strtolower(strtr($value, array_combine(preg_split('//u','АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',-1,PREG_SPLIT_NO_EMPTY), preg_split('//u','абвгдеёжзийклмнопрстуфхцчшщъыьэюя',-1,PREG_SPLIT_NO_EMPTY))));
    }
    private static function address(string $value): array {
        $value = self::text($value);
        if (!preg_match('/\A(?:ул\.|улица|пр-кт|пр-т|проспект)\s+(.+?),\s*(?:д\.?\s*)?([^,]{1,40})\z/u', $value, $m)) throw new RuntimeException('Unsupported house address');
        $street = $m[1]; $num = $m[2];
        if (self::lower($street) === 'мира') $street = 'пр-т Мира';
        if (self::lower($street) === '9-й пятилетки') $street = '9-й Пятилетки';
        return [$street, $num];
    }
    private static function key(string $street, string $num): string {
        $street = preg_replace('/\A(?:ул\.|улица)\s*/u', '', self::lower(self::text($street)));
        $street = preg_replace('/\A(?:пр-кт|пр-т|проспект)\s*/u', '', $street);
        return str_replace('ё','е',$street) . '|' . self::lower(self::text($num));
    }
    private static function ownUk(?string $uk): bool {
        return $uk !== null && preg_match('/\A(?:ук|ооо|управляющая компания|\s|[«»"“”])+жилкомсервис[»"“”\s]*\z/u',self::lower($uk)) === 1;
    }
    private static function document(string $html): array {
        if ($html === '' || strlen($html) > 2097152 || !preg_match('//u', $html)) throw new RuntimeException('Invalid or oversized source HTML');
        if (!class_exists('DOMDocument')) throw new RuntimeException('PHP DOM extension required');
        $previous = libxml_use_internal_errors(true);
        try {
            $dom = new DOMDocument();
            $dom->resolveExternals = false; $dom->substituteEntities = false;
            if (!$dom->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING)) throw new RuntimeException('Source HTML parse failed');
            $xpath = new DOMXPath($dom);
            foreach ($xpath->query('//script|//style|//noscript') as $node) $node->parentNode->removeChild($node);
            $pieces=[]; foreach ($xpath->query('//text()') as $node) $pieces[]=$node->nodeValue;
            return [$dom,$xpath,self::text(implode(' ',$pieces))];
        } finally { libxml_clear_errors(); libxml_use_internal_errors($previous); }
    }
    private function request(string $url, ?array $post = null): string {
        if (!preg_match('~\Ahttps://dom\.mingkh\.ru/krasnoyarskiy-kray/sosnovoborsk/(?:[0-9]+|\?page=[0-9]+)\z~D', $url)) throw new RuntimeException('Source URL rejected');
        if (++$this->requests > 1000) throw new RuntimeException('Source request budget exceeded');
        call_user_func($this->pause);
        $html = call_user_func($this->fetch, $url, $post);
        if (!is_string($html) || strlen($html) > 2097152) throw new RuntimeException('Invalid source response');
        return $html;
    }
    private function page(string $url): string {
        $html = $this->request($url);
        [,,$text] = self::document($html);
        if (preg_match('/Сколько будет\s*(\d{1,5})\s*([+\-*xх×])\s*(\d{1,5})/u', $text, $m)) {
            $a=(int)$m[1]; $b=(int)$m[3]; $answer=$m[2]==='+' ? $a+$b : ($m[2]==='-' ? $a-$b : $a*$b);
            $posted = $this->request($url,['captcha_answer'=>(string)$answer]);
            // The provider's POST response may still contain the same form; cookies apply on GET.
            self::document($posted);
            $html = $this->request($url); [,,$text] = self::document($html);
        }
        if (preg_match('/Сколько будет|captcha_answer|хотим убедиться|подтвердите.{0,30}не робот/iu', $text . ' ' . $html)) throw new RuntimeException('Source challenge not completed');
        return $html;
    }
    private static function number(?string $value, float $min, float $max, bool $integer = false) {
        if ($value === null || trim($value) === '' || preg_match('/\A(?:нет данных|не указано|—|-)\z/iu',trim($value))) return null;
        $clean = preg_replace('/[\s\x{00a0}\x{202f}]/u','',$value);
        $clean = str_replace(',','.',$clean);
        if (!preg_match('/\A[0-9]+(?:\.[0-9]+)?\z/D',$clean)) throw new RuntimeException('Malformed numeric source field');
        $number=(float)$clean;
        if (!is_finite($number) || $number<$min || $number>$max || ($integer && floor($number)!==$number)) throw new RuntimeException('Numeric source field out of range');
        return $integer ? (int)$number : $number;
    }
    private static function date(?string $date): ?string {
        if ($date === null || $date === '' || $date === '01.01.1970') return null;
        if (!preg_match('/\A(\d{2})\.(\d{2})\.(\d{4})\z/D',$date,$m) || !checkdate((int)$m[2],(int)$m[1],(int)$m[3]) || (int)$m[3]<1900 || (int)$m[3]>(int)date('Y')+1) throw new RuntimeException('Invalid management date');
        return $date;
    }
    public static function parseHouse(string $html, string $address, string $id): array {
        [, $xpath, $text] = self::document($html);
        [$street,$num] = self::address($address); $identity=false;
        foreach ($xpath->query('//h1|//h2|//title') as $node) {
            if (preg_match('~'.preg_quote(self::lower($address),'~').'(?![\p{L}\p{N}/-])~u',self::lower(self::text($node->textContent)))) $identity=true;
        }
        if (!$identity || !preg_match('/Год постройки|Количество квартир|Жилых помещений|построен в/u',$text)) throw new RuntimeException('House identity or data markers missing');
        $labels=[];
        foreach ($xpath->query('//tr') as $row) {
            $cells=$xpath->query('./th|./td',$row);
            if ($cells->length>=2) {
                // The live source contains malformed rows with an extra empty <td>.
                // Do not let that empty cell suppress a valid later value or text fallback.
                for ($index=1;$index<$cells->length;$index++) {
                    $value=self::text($cells->item($index)->textContent);
                    if ($value!=='') { $labels[self::text($cells->item(0)->textContent)]=$value; break; }
                }
            }
        }
        $grab = static function (string $pattern) use ($text): ?string { return preg_match($pattern,$text,$m) ? self::text($m[1]) : null; };
        $field = static function (array $names, string $fallback) use ($labels,$grab): ?string {
            foreach ($names as $name) if (array_key_exists($name,$labels)) return $labels[$name];
            return $grab($fallback);
        };
        $uk=null; $since=null;
        if (preg_match('/(?:под управлением|Управляющая компания)\s+(.{2,180}?)\s+с\s+(\d{2}\.\d{2}\.\d{4})/u',$text,$m)) { $uk=self::text($m[1]); $since=self::date($m[2]); }
        elseif (isset($labels['Управляющая компания']) && !preg_match('/нет данных|не указано/iu',$labels['Управляющая компания'])) $uk=$labels['Управляющая компания'];
        $record=['addr'=>$address,'sourceId'=>$id,'sourceUrl'=>self::BASE.self::CITY.$id,'uk'=>$uk,'ukSince'=>$since];
        $numeric=[
            'year'=>[['Год постройки'],'/(?:Год постройки\s+|построен в\s+)(\d{4})/u',1700,(int)date('Y')+2,true],
            'floors'=>[['Количество этажей'],'/(?:Количество этажей\s+)(\d+(?:\s*-\s*\d+)?)/u',1,100,true],
            'flats'=>[['Количество квартир','Жилых помещений'],'/(?:Количество квартир|Жилых помещений)\s+(\d+)/u',0,10000,true],
            'entrances'=>[['Количество подъездов'],'/Количество подъездов\s+(\d+)/u',0,200,true],
            'area'=>[['Площадь многоквартирного дома, кв.м','Площадь многоквартирного дома, кв. м'],'/Площадь многоквартирного дома, кв\.?\s*м\s*([\d\s.,]+)/u',0,10000000,false],
            'wear'=>[['Износ здания, %'],'/Износ здания, %\s+([\d.,]+)/u',0,100,false],
            'landArea'=>[['Площадь зем. участка общего имущества м2','Площадь зем. участка общего имущества м 2'],'/Площадь зем\. участка общего имущества м\s*2\s+([\d\s.,]+)/u',0,10000000,false],
            'livingArea'=>[['Площадь жилых помещений м2','Площадь жилых помещений м 2'],'/Площадь жилых помещений м\s*2\s+([\d\s.,]+)/u',0,10000000,false],
            'commonArea'=>[['Площадь помещений общего имущества м2','Площадь помещений общего имущества м 2'],'/Площадь помещений общего имущества м\s*2\s+([\d\s.,]+)/u',0,10000000,false],
            'nonlivingArea'=>[['Площадь нежилых помещений м2','Площадь нежилых помещений м 2'],'/Площадь нежилых помещений м\s*2\s+([\d\s.,]+)/u',0,10000000,false],
            'balconies'=>[['Количество балконов'],'/Количество балконов\s+(\d+)/u',0,10000,true],
            'electricInputs'=>[['Количество вводов в дом, ед.'],'/Количество вводов в дом, ед\.\s+(\d+)/u',0,100,true],
        ];
        $floorRange=false;
        foreach ($numeric as $key=>$rule) {
            $value=$field($rule[0],$rule[1]);
            if ($key==='floors' && $value!==null && preg_match('/\A(\d+)\s*-\s*(\d+)\z/D',$value,$range)) {
                $floorRange=true;
                $low=self::number($range[1],1,100,true); $high=self::number($range[2],1,100,true);
                if ($low>$high) throw new RuntimeException('Invalid floor range');
                // A range is not a single floor count. Use the source's explicit prose
                // only if it agrees with the range; otherwise preserve the old value.
                $explicit=self::number($grab('/(\d+)-этажный/u'),1,100,true);
                $record[$key]=$explicit!==null && $explicit>=$low && $explicit<=$high ? $explicit : null;
                continue;
            }
            $record[$key]=self::number($value,$rule[2],$rule[3],$rule[4]);
        }
        if ($record['floors']===null && !$floorRange) $record['floors']=self::number($grab('/(\d+)-этажный/u'),1,100,true);
        $strings=[
            'serie'=>[['Серия, тип постройки здания','Серия, тип постройки'],'/Серия, тип постройки(?: здания)?\s+(.+?)\s+(?:Статус объекта|Тип перекрытий|Материал несущих)/u'],
            'condition'=>[['Состояние дома'],'/Состояние дома\s+(\S+)/u'],
            'kadastr'=>[['Кадастровый номер'],'/Кадастровый номер\s+([\d:]+)/u'],
            'heating'=>[['Теплоснабжение'],'/Теплоснабжение\s+(.+?)\s+Холодное водоснабжение/u'],
            'hotwater'=>[['Горячее водоснабжение'],'/Горячее водоснабжение\s+(.+?)\s+Теплоснабжение/u'],
            'gas'=>[['Газоснабжение'],'/Газоснабжение\s+(.+?)\s+Горячее водоснабжение/u'],
            'sewage'=>[['Водоотведение'],'/Водоотведение\s+(.+?)\s+Газоснабжение/u'],
        ];
        foreach ($strings as $key=>$rule) {
            $value=$field($rule[0],$rule[1]);
            if ($value!==null && (strlen($value)>1200 || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f]/',$value))) throw new RuntimeException('Invalid source text');
            $record[$key]=$value;
        }
        $repairs=[];
        foreach ($xpath->query('//table') as $table) {
            $heads=[]; foreach ($xpath->query('.//th',$table) as $cell) $heads[]=self::text($cell->textContent);
            $workIndex=array_search('Вид услуги (работы)',$heads,true); $yearIndex=array_search('Год проведения',$heads,true);
            if ($yearIndex===false) continue;
            if ($workIndex===false) throw new RuntimeException('Unknown repair table columns');
            foreach ($xpath->query('.//tr',$table) as $row) {
                $cells=$xpath->query('./td',$row); if ($cells->length===0) continue;
                if ($cells->length<=max($workIndex,$yearIndex)) throw new RuntimeException('Incomplete repair row');
                $year=self::number(self::text($cells->item($yearIndex)->textContent),1900,2200,true);
                $work=self::text($cells->item($workIndex)->textContent);
                if ($year!==null && $work!=='') $repairs[]=['work'=>$work,'year'=>$year];
            }
        }
        usort($repairs,static function($a,$b){return $a['year']<=>$b['year'];}); $record['kapremont']=$repairs ?: null;
        if (count(array_filter([$record['year'],$record['floors'],$record['flats'],$record['area'],$record['uk']],static function($v){return $v!==null;}))<3) throw new RuntimeException('House core fields incomplete');
        return $record;
    }
    public function collect(): array {
        $this->requests=0; $links=[]; $maxPage=6;
        for ($page=1;$page<=$maxPage;$page++) {
            [, $xpath, $text]=self::document($this->page(self::BASE.self::CITY.'?page='.$page));
            if (strpos($text,'Сосновоборск')===false) throw new RuntimeException('Wrong city listing');
            $pageLinks=0;
            foreach ($xpath->query('//a[@href]') as $anchor) {
                $href=$anchor->getAttribute('href');
                if (strpos($href,self::BASE)===0) $href=substr($href,strlen(self::BASE));
                if (preg_match('~\A(?:'.preg_quote(self::CITY,'~').')?\?page=(\d+)\z~D',$href,$m)) {
                    $next=(int)$m[1]; if ($next<1 || $next>20) throw new RuntimeException('Pagination limit exceeded');
                    $maxPage=max($maxPage,$next);
                }
                if (!preg_match('~\A'.preg_quote(self::CITY,'~').'([0-9]+)\z~D',$href,$m)) continue;
                $address=self::text($anchor->textContent); self::address($address);
                if (isset($links[$m[1]]) && $links[$m[1]]!==$address) throw new RuntimeException('Conflicting house identity');
                $links[$m[1]]=$address; $pageLinks++;
                if (count($links)>500) throw new RuntimeException('House count limit exceeded');
            }
            if ($pageLinks===0) throw new RuntimeException('Empty listing page');
        }
        if (count($links)<100) throw new RuntimeException('Fewer than 100 houses');
        $records=[]; $addresses=[]; $missingUk=0;
        foreach ($links as $id=>$address) {
            [$street,$num]=self::address($address); $key=self::key($street,$num);
            if (isset($addresses[$key])) throw new RuntimeException('Duplicate normalized address'); $addresses[$key]=true;
            try { $record=self::parseHouse($this->page(self::BASE.self::CITY.$id),$address,(string)$id); }
            catch (Throwable $error) { throw new RuntimeException('House sourceId='.(string)$id.': '.$error->getMessage(),0,$error); }
            if ($record['uk']===null) $missingUk++;
            $records[]=$record;
        }
        if ($missingUk>max(3,(int)floor(count($records)*0.05))) throw new RuntimeException('Management data completeness collapsed');
        return $records;
    }
    public function rebuild(array $records, array $housesGeo, array $competitors, array $houses): array {
        $this->report=['warnings'=>[], 'ownershipRisks'=>[]];
        if (count($records)<100 || count($records)>500 || !$housesGeo || !$houses) throw new RuntimeException('Dataset size invalid');
        $byAddress=[]; $missingUk=0;
        foreach ($records as $record) {
            [$street,$num]=self::address($record['addr'] ?? ''); $key=self::key($street,$num);
            if (isset($byAddress[$key])) throw new RuntimeException('Duplicate normalized source address');
            foreach (['year'=>[1700,(int)date('Y')+2,true],'floors'=>[1,100,true],'flats'=>[0,10000,true],'area'=>[0,10000000,false],'entrances'=>[0,200,true],'wear'=>[0,100,false]] as $field=>$rule) {
                if (isset($record[$field])) $record[$field]=self::number((string)$record[$field],$rule[0],$rule[1],$rule[2]);
            }
            $record['ukSince']=self::date($record['ukSince'] ?? null);
            if (isset($record['uk']) && (!is_string($record['uk']) || trim($record['uk'])==='' || strlen($record['uk'])>600)) throw new RuntimeException('Invalid management company');
            if (!isset($record['uk'])) $missingUk++;
            $byAddress[$key]=[$record,$street,$num];
        }
        if ($missingUk>max(3,(int)floor(count($records)*0.05))) throw new RuntimeException('Management data completeness collapsed');
        $own=[]; foreach ($houses as $house) if (empty($house['archived'])) $own[self::key($house['street'],$house['num'])]=true;
        $old=[]; $coordinates=[];
        foreach ($competitors as $house) { $key=self::key($house['street'],$house['num']); $old[$key]=$house; $coordinates[$key]=[$house['lat'] ?? null,$house['lon'] ?? null]; }
        foreach ($housesGeo as $house) { $key=self::key($house['street'],$house['num']); $coordinates[$key]=[$house['lat'] ?? null,$house['lon'] ?? null]; }
        foreach (array_keys($coordinates) as $key) if (!isset($byAddress[$key])) throw new RuntimeException('Previously known address disappeared; manual review required');
        $resultGeo=$housesGeo;
        foreach ($resultGeo as &$house) {
            $key=self::key($house['street'],$house['num']); if (!isset($byAddress[$key])) continue;
            $record=$byAddress[$key][0];
            foreach (array_merge(['year','floors','flats','area','entrances','ukSince'],self::EXTRA) as $field) {
                if ($field==='ukSince' && isset($own[$key],$record['uk']) && !self::ownUk($record['uk'])) continue;
                if (isset($record[$field]) && $record[$field]!=='' && $record[$field]!==[]) $house[$field]=$record[$field];
                elseif (isset($house[$field])) $this->report['warnings'][]=['type'=>'preserved_missing_field','street'=>$house['street'],'num'=>$house['num'],'field'=>$field];
            }
        }
        unset($house);
        $resultCompetitors=[];
        foreach ($byAddress as $key=>$source) {
            [$record,$street,$num]=$source;
            if (isset($own[$key])) {
                if (isset($record['uk']) && !self::ownUk($record['uk'])) $this->report['ownershipRisks'][]=['street'=>$street,'num'=>$num,'sourceUk'=>$record['uk'],'sourceSince'=>$record['ukSince']];
                continue;
            }
            if (self::ownUk($record['uk'] ?? null)) {
                $this->report['ownershipRisks'][]=['street'=>$street,'num'=>$num,'sourceUk'=>$record['uk'],'sourceSince'=>$record['ukSince'],'type'=>'source_own_not_in_membership'];
                // Preserve an existing competitor until the membership discrepancy is reviewed.
                if (isset($old[$key])) $resultCompetitors[]=$old[$key];
                continue;
            }
            $entry=$old[$key] ?? ['street'=>$street,'num'=>$num];
            $entry['uk']=$record['uk'] ?? ($entry['uk'] ?? 'нет данных об УК');
            if ($record['ukSince']!==null) $entry['ukSince']=$record['ukSince'];
            elseif (!array_key_exists('ukSince',$entry)) $entry['ukSince']=null;
            [$entry['lat'],$entry['lon']]=$coordinates[$key] ?? [null,null];
            if ($entry['lat']===null || $entry['lon']===null) $this->report['warnings'][]=['type'=>'coordinates_missing','street'=>$street,'num'=>$num];
            $resultCompetitors[]=$entry;
        }
        if (!$resultCompetitors) throw new RuntimeException('Empty competitor dataset rejected');
        usort($resultCompetitors,static function($a,$b){return strcmp(self::key($a['street'],$a['num']),self::key($b['street'],$b['num']));});
        return ['houses_geo.json'=>$resultGeo,'competitors.json'=>$resultCompetitors];
    }
}
