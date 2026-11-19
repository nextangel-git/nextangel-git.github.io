<?php
declare(strict_types=1);
require_once __DIR__.'/admin-schema.php';

// Only metadata/code is public. All records and images live outside the document root.
final class JksRequestStore {
    private $directory;
    public function __construct(string $privateDir) {
        $this->directory=$privateDir.'/requests';
        if (is_link($privateDir) || is_link($this->directory)) throw new RuntimeException('Unsafe request storage');
        if (!is_dir($this->directory) && !@mkdir($this->directory,0700) && !is_dir($this->directory)) throw new RuntimeException('Request storage unavailable');
    }
    private function folder(string $id): string {
        if (!preg_match('/\A[a-f0-9]{64}\z/D',$id)) throw new JksApiError(404,'request_missing','Заявка не найдена.');
        $folder=$this->directory.'/'.$id;
        if (is_link($folder)) throw new RuntimeException('Unsafe request folder');
        return $folder;
    }
    private static function write(string $folder,array $record): void {
        $path=$folder.'/request.json';
        if (is_link($path)) throw new RuntimeException('Unsafe record');
        $temp=$folder.'/.record-'.bin2hex(random_bytes(8));
        $bytes=json_encode($record,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
        try {
            if (file_put_contents($temp,$bytes,LOCK_EX)!==strlen($bytes) || !chmod($temp,0600) || !rename($temp,$path)) throw new RuntimeException('Request write failed');
        } finally { if (is_file($temp)) unlink($temp); }
    }
    public function record(string $id): array {
        $path=$this->folder($id).'/request.json';
        if (!is_file($path) || is_link($path)) throw new JksApiError(404,'request_missing','Заявка не найдена.');
        $raw=file_get_contents($path,false,null,0,65537);
        if ($raw===false || strlen($raw)>65536) throw new RuntimeException('Invalid request');
        $record=json_decode($raw,true,32,JSON_THROW_ON_ERROR);
        if (!is_array($record) || ($record['id'] ?? '')!==$id) throw new RuntimeException('Invalid request record');
        return $record;
    }
    public function save(array $fields,array $photos): array {
        $id=hash('sha256',$fields['requestId']);$folder=$this->folder($id);
        $fingerprint=hash('sha256',json_encode($fields,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR).implode('',array_map(static function($p){return hash_file('sha256',$p['path']);},$photos)));
        $lock=fopen($this->directory.'/.lock','c');
        if (!$lock || !flock($lock,LOCK_EX)) throw new RuntimeException('Request lock failed');
        @chmod($this->directory.'/.lock',0600);
        try {
            if (is_file($folder.'/request.json')) {
                $record=$this->record($id);
                if (!hash_equals($record['fingerprint'],$fingerprint)) throw new JksApiError(409,'request_conflict','Этот код уже занят другим обращением. Обновите страницу.');
                return ['created'=>false,'record'=>$record];
            }
            if (is_dir($folder)) throw new RuntimeException('Incomplete request storage');
            if (!mkdir($folder,0700)) throw new RuntimeException('Request folder unavailable');
            $attachments=[];
            try {
                foreach ($photos as $p) {
                    if (!preg_match('/\Aphoto-[1-5]\.(?:jpg|png|webp)\z/D',$p['name'])) throw new RuntimeException('Invalid attachment name');
                    $target=$folder.'/'.$p['name'];
                    if (!copy($p['path'],$target) || !chmod($target,0600)) throw new RuntimeException('Attachment save failed');
                    $attachments[]=['name'=>$p['name'],'mime'=>$p['mime'],'size'=>filesize($target)];
                }
                $record=$fields+['id'=>$id,'createdAt'=>(new DateTimeImmutable('now',new DateTimeZone('Asia/Krasnoyarsk')))->format(DATE_ATOM),'delivery'=>'sending','photos'=>$attachments,'fingerprint'=>$fingerprint];
                self::write($folder,$record);
            } catch(Throwable $e) {
                // Only this freshly-created private directory, never an existing request.
                foreach (glob($folder.'/*') as $path) if (is_file($path)) unlink($path);
                @rmdir($folder);throw $e;
            }
            return ['created'=>true,'record'=>$record];
        } finally { flock($lock,LOCK_UN);fclose($lock); }
    }
    public function delivery(string $id,string $status): void {
        if (!in_array($status,['sent','unconfirmed','confirmed_by_owner'],true)) throw new RuntimeException('Invalid delivery status');
        $lock=fopen($this->directory.'/.lock','c');
        if (!$lock || !flock($lock,LOCK_EX)) throw new RuntimeException('Request lock failed');
        try { $record=$this->record($id);$record['delivery']=$status;self::write($this->folder($id),$record); }
        finally { flock($lock,LOCK_UN);fclose($lock); }
    }
    public function listing(int $page=1): array {
        $paths=glob($this->directory.'/*/request.json') ?: [];
        usort($paths,static function($a,$b){return filemtime($b)<=>filemtime($a) ?: strcmp($b,$a);});
        $total=count($paths);$pages=max(1,(int)ceil($total/50));$page=max(1,min($page,$pages));$data=[];
        foreach (array_slice($paths,($page-1)*50,50) as $path) {
            $record=$this->record(basename(dirname($path)));unset($record['fingerprint']);$data[]=$record;
        }
        return ['data'=>$data,'total'=>$total,'page'=>$page,'pages'=>$pages,'sha'=>null];
    }
    public function photo(string $id,string $name): array {
        $record=$this->record($id);
        foreach ($record['photos'] as $p) if ($p['name']===$name && preg_match('/\Aphoto-[1-5]\.(?:jpg|png|webp)\z/D',$name)) {
            $path=$this->folder($id).'/'.$name;
            if (is_file($path) && !is_link($path)) return $p+['path'=>$path];
        }
        throw new JksApiError(404,'photo_missing','Фотография не найдена.');
    }
}
