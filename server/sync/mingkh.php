<?php
declare(strict_types=1);

// CLI core: callers own HTTP cookies/timeouts and atomic GitHub publication.
final class JksMingkhSync {
    const BASE = 'https://dom.mingkh.ru';
    const CITY = '/krasnoyarskiy-kray/sosnovoborsk/';
    const COMPANY = 'https://mingkh.ru/krasnoyarskiy-kray/sosnovoborsk/1067760313180/';
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
        if ($url!==self::COMPANY && $url!==self::COMPANY.'houses/' && !preg_match('~\Ahttps://dom\.mingkh\.ru/krasnoyarskiy-kray/sosnovoborsk/(?:[0-9]+|\?page=[0-9]+)\z~D', $url)) throw new RuntimeException('Source URL rejected');
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
        if ($date === null || $date === '' || $date === '01.01.1970' || $date === '—' || $date === '-') return null;
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
        // Coordinates of the house's own map, not the company office or a geocoder guess.
        foreach (['lat'=>['mapcenterlat',55.9,56.4],'lon'=>['mapcenterlng',93.1,93.6]] as $coordinateField=>$rule) {
            $node=$xpath->query('//input[@id="'.$rule[0].'"]')->item(0);
            $raw=$node ? $node->getAttribute('value') : '';
            $record[$coordinateField]=($raw==='' || $raw==='0') ? null : self::number($raw,$rule[1],$rule[2]);
        }
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
    public function collectPortfolio(): array {
        return self::parsePortfolio($this->page(self::COMPANY),$this->page(self::COMPANY.'houses/'));
    }
    public static function parsePortfolio(string $companyHtml, string $listHtml): array {
        [, $company, $text]=self::document($companyHtml);
        if (strpos($text,'7703617600')===false || strpos($text,'1067760313180')===false || strpos($text,'Сосновоборск')===false) throw new RuntimeException('Company identity missing');
        $count=null;
        foreach ($company->query('//dd[a[@href="'.self::CITY.'1067760313180/houses"]]') as $node) {
            if (preg_match('/\A([0-9]+)\s/u',self::text($node->textContent),$m)) $count=(int)$m[1];
        }
        if ($count===null || $count<1 || $count>500) throw new RuntimeException('Company house count missing');
        [, $list, $listText]=self::document($listHtml);
        if (strpos($listText,'Жилкомсервис')===false || strpos($listText,'Сосновоборск')===false) throw new RuntimeException('Wrong company listing');
        $rows=[]; $ids=[]; $addresses=[];
        foreach ($list->query('//tbody/tr') as $row) {
            $cells=$list->query('./td',$row); $anchor=$list->query('./td/a[@href]',$row)->item(0);
            if (!$anchor) continue;
            $url=$anchor->getAttribute('href');
            if (!preg_match('~\A'.preg_quote(self::BASE.self::CITY,'~').'([0-9]+)\z~D',$url,$m) || $cells->length!==7) throw new RuntimeException('Company listing schema changed');
            $address=preg_replace('/,\s*Сосновоборск\z/u','',self::text($anchor->textContent));
            [$street,$num]=self::address($address); $key=self::key($street,$num);
            if (isset($ids[$m[1]]) || isset($addresses[$key])) throw new RuntimeException('Duplicate company house');
            $ids[$m[1]]=true; $addresses[$key]=true;
            $entry=['addr'=>$address,'sourceId'=>$m[1],'street'=>$street,'num'=>$num,'ukSince'=>self::date(self::text($cells->item(2)->textContent))];
            foreach (['flats'=>[4,0,10000,true],'area'=>[6,1,10000000,false]] as $field=>$rule) {
                $entry[$field]=self::number(self::text($cells->item($rule[0])->textContent),$rule[1],$rule[2],$rule[3]);
                if ($entry[$field]===null) throw new RuntimeException('Incomplete company totals');
            }
            $rows[]=$entry;
        }
        if (count($rows)!==$count) throw new RuntimeException('Company count and complete listing disagree');
        return $rows;
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
    public function rebuild(array $records, array $housesGeo, array $competitors, array $houses, array $portfolio): array {
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
        if (!$portfolio || count($portfolio)>count($records)) throw new RuntimeException('Invalid company portfolio');
        $own=[];
        foreach ($portfolio as $entry) {
            $key=self::key($entry['street'],$entry['num']);
            if (isset($own[$key]) || !isset($byAddress[$key]) || (string)$byAddress[$key][0]['sourceId']!==(string)$entry['sourceId']) throw new RuntimeException('Company and city house identities disagree');
            foreach (['area'=>[1,10000000,false],'flats'=>[0,10000,true]] as $field=>$rule) {
                if (!isset($entry[$field])) throw new RuntimeException('Incomplete company totals');
                $entry[$field]=self::number((string)$entry[$field],$rule[0],$rule[1],$rule[2]);
            }
            $entry['ukSince']=self::date($entry['ukSince'] ?? null);
            $own[$key]=$entry;
        }
        $old=[]; $geo=[]; $membership=[]; $active=[];
        foreach ($competitors as $h) $old[self::key($h['street'],$h['num'])]=$h;
        foreach ($housesGeo as $h) $geo[self::key($h['street'],$h['num'])]=$h;
        foreach ($houses as $h) {
            $key=self::key($h['street'],$h['num']); $membership[$key]=$h;
            if (empty($h['archived'])) $active[$key]=true;
        }
        foreach (array_unique(array_merge(array_keys($old),array_keys($active))) as $key) {
            if (!isset($byAddress[$key])) throw new RuntimeException('Previously known address disappeared; incomplete city dataset');
        }
        $this->report['membership']=['active'=>count($own),'added'=>count(array_diff_key($own,$active)),'removed'=>count(array_diff_key($active,$own))];
        $resultHouses=[]; $resultGeo=[]; $resultCompetitors=[];
        foreach ($byAddress as $key=>$source) {
            [$record,$street,$num]=$source;
            $coordinates=[$record['lat'] ?? $geo[$key]['lat'] ?? $old[$key]['lat'] ?? null,$record['lon'] ?? $geo[$key]['lon'] ?? $old[$key]['lon'] ?? null];
            foreach ($coordinates as $i=>$coordinate) if ($coordinate!==null) self::number((string)$coordinate,$i===0?55.9:93.1,$i===0?56.4:93.6);
            if (isset($own[$key])) {
                $member=$membership[$key] ?? ['street'=>$street,'num'=>$num];
                unset($member['archived'],$member['archiveReason']);
                $member['src']='МинЖКХ: перечень УК'; $resultHouses[]=$member;
                $house=$geo[$key] ?? ['street'=>$street,'num'=>$num];
                unset($house['archived'],$house['archiveReason']);
                $house['src']='МинЖКХ: перечень УК и карточка дома';
                foreach (array_merge(['year','floors','flats','area','entrances','ukSince'],self::EXTRA) as $field) {
                    if (isset($record[$field]) && $record[$field]!=='' && $record[$field]!==[]) $house[$field]=$record[$field];
                    elseif (isset($house[$field])) $this->report['warnings'][]=['type'=>'preserved_missing_field','street'=>$street,'num'=>$num,'field'=>$field];
                }
                // Membership and totals use the same company list; individual cards can lag behind it.
                foreach (['area','flats','ukSince'] as $field) $house[$field]=$own[$key][$field];
                [$house['lat'],$house['lon']]=$coordinates;
                if ($house['lat']===null || $house['lon']===null) throw new RuntimeException('Active house has no verified map coordinates');
                $house['sourceUrl']=$record['sourceUrl'];
                $resultGeo[]=$house;
                if (isset($record['uk']) && !self::ownUk($record['uk'])) $this->report['ownershipRisks'][]=['street'=>$street,'num'=>$num,'sourceUk'=>$record['uk'],'type'=>'company_list_card_disagree'];
            } else {
                $entry=$old[$key] ?? ['street'=>$street,'num'=>$num];
                unset($entry['archived']);
                $entry['uk']=$record['uk'] ?? ($entry['uk'] ?? 'нет данных об УК');
                $entry['ukSince']=$record['ukSince'] ?? ($entry['ukSince'] ?? null);
                [$entry['lat'],$entry['lon']]=$coordinates;
                if ($entry['lat']===null || $entry['lon']===null) $this->report['warnings'][]=['type'=>'coordinates_missing','street'=>$street,'num'=>$num];
                if (self::ownUk($entry['uk'])) {
                    $this->report['ownershipRisks'][]=['street'=>$street,'num'=>$num,'sourceUk'=>$entry['uk'],'type'=>'card_absent_from_company_list'];
                    $entry['uk']='УК уточняется';
                }
                $resultCompetitors[]=$entry;
            }
        }
        // Preserve removed houses and their custom fields in the archive; exclude them everywhere public.
        foreach ($membership as $key=>$h) if (!isset($own[$key])) {
            $h['archived']=true; $h['archiveReason']='Отсутствует в полном перечне УК на МинЖКХ'; $resultHouses[]=$h;
        }
        foreach ($geo as $key=>$h) if (!isset($own[$key])) {
            $h['archived']=true; $h['archiveReason']='Отсутствует в полном перечне УК на МинЖКХ'; $resultGeo[]=$h;
        }
        $sort=static function($a,$b){return strnatcmp(self::key($a['street'],$a['num']),self::key($b['street'],$b['num']));};
        usort($resultHouses,$sort); usort($resultGeo,$sort); usort($resultCompetitors,$sort);
        $meta=['checkedAt'=>(new DateTimeImmutable('now',new DateTimeZone('Asia/Krasnoyarsk')))->format('Y-m-d'),'companyUrl'=>self::COMPANY,'sourceHouseCount'=>count($own)];
        return ['houses.json'=>$resultHouses,'houses_geo.json'=>$resultGeo,'competitors.json'=>$resultCompetitors,'mingkh_sync.json'=>$meta];
    }
}
