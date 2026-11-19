import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url)), php=process.env.PHP_BIN || 'php';
const available=spawnSync(php,['-v'],{windowsHide:true}).status===0;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('real PHP multipart uploads enforce file bytes, count and totals before captcha or mail', {skip:!available && 'Set PHP_BIN',timeout:30000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'jks-photo-test-'));
  await fs.writeFile(path.join(directory,'captcha.php'),"<?php return ['secret'=>'TEST_ONLY_NO_NETWORK_CAPTCHA','sitekey'=>'ysc1_c1z811srDG3allSQnw0xpIy1ubAve2lTWfeKJrLe29c108b2'];");
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const ext=process.platform==='win32'?['-d',`extension_dir=${path.join(path.dirname(php),'ext')}`,'-d','extension=fileinfo']:[];
  const child=spawn(php,[...ext,'-d','upload_max_filesize=6M','-d','post_max_size=16M','-S',`127.0.0.1:${port}`,'tests/fixtures/php-request-router.php'],{cwd:root,env:{...process.env,JKS_PHP_TEST_DIR:directory},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}await fs.rm(directory,{recursive:true,force:true});});
  for(let i=0;!output.includes('Development Server')&&i<100;i++){if(child.exitCode!==null)throw new Error(output);await new Promise(r=>setTimeout(r,20));}
  assert.match(output,/Development Server/);
  const body={fio:'Тест',phone:'+79990000000',house:'ул. Тестовая, 1',flat:'1',topic:'Другое',text:'Изолированный тест, писем нет',pdn:true,company:'',captchaToken:'valid',requestId:'ЖКС-12345678-1234-4123-8123-123456789abc'};
  async function upload(files,options={}) {
    const form=new FormData();form.append('payload',JSON.stringify({...body,requestId:'ЖКС-'+crypto.randomUUID(),photoCount:options.count??files.length,...options.body}));
    for(const [i,f] of files.entries())form.append('photos[]',new Blob([f],{type:'image/png'}),`image-${i}.png`);
    const req=new Request('http://localhost/',{method:'POST',body:form});const bytes=Buffer.from(await req.arrayBuffer());
    return new Promise((resolve,reject)=>{
      const request=http.request({hostname:'127.0.0.1',port,path:'/?result='+(options.result||''),method:'POST',headers:{Host:'jks.ooo',Origin:options.origin||'https://jks.ooo','Content-Type':req.headers.get('content-type'),'Content-Length':bytes.length}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(s)}));});request.on('error',reject);request.end(bytes);
    });
  }
  let r=await upload([png,png]);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.test_calls[0].kind,'captcha');
  assert.equal(r.data.test_calls[1].count,2);assert.equal(r.data.test_calls[1].files[0].name,'photo-1.png');
  assert.equal(r.data.test_calls[1].files[0].sha,createHash('sha256').update(png).digest('hex'),'Uploaded bytes reach the mail transport unchanged');
  const storedId=createHash('sha256').update(r.data.requestId).digest('hex');
  const stored=JSON.parse(await fs.readFile(path.join(directory,'requests',storedId,'request.json'),'utf8'));
  assert.equal(stored.photos.length,2);assert.equal(stored.delivery,'sent');assert.equal(stored.captchaToken,undefined);
  assert.deepEqual(await fs.readFile(path.join(directory,'requests',storedId,'photo-1.png')),png,'Private copy matches original bytes');
  const rejected=[[[png,png],{count:3},422],[[Buffer.from('<script>not a photo</script>')],{},422],[[Buffer.alloc(0)],{},413],[[Buffer.alloc(5_000_001)],{},413],[Array(6).fill(png),{},422],[[png],{origin:'https://evil.invalid'},403]];
  for(const [files,options,status] of rejected){r=await upload(files,options);assert.equal(r.status,status,JSON.stringify(r));assert.equal(r.data.test_calls.length,0);}
  const large=Buffer.alloc(5_000_000);png.copy(large);r=await upload([large,large,png]);assert.equal(r.status,413);assert.equal(r.data.test_calls.length,0);
  r=await upload([png],{body:{captchaToken:'invalid'}});assert.equal(r.status,403);assert.deepEqual(r.data.test_calls,[{kind:'captcha'}]);
  for(const result of ['html','wrong']){r=await upload([png],{result});assert.equal(r.status,200);assert.equal(r.data.saved,true);assert.equal(r.data.emailSent,false,'HTML or unrelated redirect never confirms mail, but record is saved');}
  r=await upload([png],{result:'thanks'});assert.equal(r.status,200,'Verified service success page is accepted without following redirects');
  r=await upload([]);assert.equal(r.status,200);assert.equal(r.data.test_calls[1].kind,'text');
});
