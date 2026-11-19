import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const php=process.env.PHP_BIN||'php';
const available=spawnSync(php,['-v'],{windowsHide:true}).status===0;
test('NIC sync schedule keeps Krasnoyarsk monthly slot, retries and bounded SUMMARY history',{skip:!available&&'Set PHP_BIN'},()=>{
  const result=spawnSync(php,['tests/sync-schedule-php.php'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.passed,13);assert.equal(report.network_used,false);
});
