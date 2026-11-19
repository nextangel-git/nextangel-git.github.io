import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const php=process.env.PHP_BIN||'php';
const available=spawnSync(php,['-v'],{windowsHide:true}).status===0;
test('NIC sync schedule keeps Krasnoyarsk monthly slot, retries and bounded SUMMARY history',{skip:!available&&'Set PHP_BIN'},()=>{
  const result=spawnSync(php,['tests/sync-schedule-php.php'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.passed,23);assert.equal(report.network_used,false);
});

test('NIC shutdown diagnostics survive fatal memory exhaustion and omit raw errors',{skip:!available&&'Set PHP_BIN'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'jks-sync-fatal-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  for(const [label,ending] of [['memory','$large=str_repeat("x",32*1024*1024);'],['user','trigger_error("TEST_SECRET_MUST_NOT_LEAK",E_USER_ERROR);'],['exit','exit(3);']]) {
    const destination=path.join(directory,label+'.json');
    const script='require "server/sync/cron.php"; $reserve=str_repeat("R",262144); $active=["kind"=>"mingkh","path"=>$argv[1],"state"=>["last_attempt"=>time(),"dry_run"=>true],"started"=>microtime(true),"stage"=>"collect"]; jksSyncInstallShutdown($active,$reserve); '+ending;
    const child=spawnSync(php,['-d','memory_limit=16M','-d','log_errors=0','-r',script,destination],{windowsHide:true,encoding:'utf8'});
    assert.notEqual(child.status,0);
    const raw=await fs.readFile(destination,'utf8'); const report=JSON.parse(raw);
    assert.equal(report.status,label==='exit'?'interrupted':'failed');
    assert.equal(report.error,label==='exit'?'sync_interrupted_shutdown':'sync_fatal_shutdown');
    assert.equal(report.stage,'collect'); assert.equal(report.active_job,'mingkh');
    assert.equal(report.memory_limit,'16M'); assert.ok(report.php_version);
    assert.ok(report.elapsed_seconds>=0); assert.ok(report.peak_memory_bytes>0);
    assert.ok(!raw.includes('TEST_SECRET')); assert.ok(!raw.includes('filename')); assert.ok(!raw.includes('trace'));
  }
});
