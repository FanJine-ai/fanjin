import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, main } from '../bin/fanjin.mjs';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test('query commands preserve account, filters, and optional project semantics', () => {
  assert.deepEqual(parseArgs(['usage','list','--scope','account','--project','12','--from','100','--to','200']).input, { action: 'usage', scope: 'account', projectId: 12, from: 100, to: 200 });
  assert.equal(parseArgs(['account','ledger']).input.scope,'account');
  assert.equal(parseArgs(['billing','entry','entry-id']).input.action,'ledger-detail');
  assert.equal(parseArgs(['usage','export','--output','usage.csv']).local,'analytics-export');
  assert.throws(() => parseArgs(['usage','list','--output','bad.csv']));
});
test('full export follows cursors and refuses overwriting an existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(),'fanjin-analytics-')), file = join(dir,'usage.json'); const requests=[];
  globalThis.fetch=async (_url, init) => { const input=JSON.parse(init.body); requests.push(input); return new Response(JSON.stringify({apiVersion:'fanjin-tools/v1',ok:true,data: {content:JSON.stringify([{id: input.cursor ? 'second' : 'first'}]),nextCursor: input.cursor ? null : 'page2'}}),{headers:{'content-type':'application/json'}}); };
  let output='', error=''; const io={stdout:{write:s=>output+=s},stderr:{write:s=>error+=s}};
  try {
    const args=['usage','export','--format','json','--output',file]; const env={FANJIN_API_KEY:'local-test-key'};
    assert.equal(await main(args,env,io),0); assert.deepEqual(JSON.parse(await readFile(file,'utf8')),[{id:'first'},{id:'second'}]); assert.equal(requests.length,2); assert.equal(JSON.parse(output).data.complete,true);
    assert.equal(await main(args,env,io),2); assert.match(error,/FILE_EXISTS/); assert.deepEqual(await readdir(dir),['usage.json']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('background commands carry exact filters and require explicit output and request identity', () => {
  const parsed = parseArgs(['usage', 'export-create', '--key', 'request-123', '--execution-status', 'failed', '--failure-category', 'timeout']);
  assert.deepEqual(parsed.input, { idempotencyKey: 'request-123', action: 'export-create', scope: 'workspace', executionStatus: 'failed', failureCategory: 'timeout' });
  assert.equal(parseArgs(['usage', 'export-status', 'job-1']).input.id, 'job-1');
  assert.throws(() => parseArgs(['usage', 'export-create']));
  assert.throws(() => parseArgs(['usage', 'export-download', 'job-1']));
});
test('background artifact download streams every part and discards incomplete output on an authorization failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fanjin-export-')), file = join(dir, 'usage.csv');
  const calls = []; let fail = false;
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(init.body); calls.push(input);
    return new Response(JSON.stringify(fail && input.part === 1 ? { apiVersion: 'fanjin-tools/v1', ok: false, error: { code: 'EXPORT_SCOPE_CHANGED', message: 'permission changed' } } : { apiVersion: 'fanjin-tools/v1', ok: true, data: { format: 'csv', content: input.part ? 'b\r\n' : 'id\r\na\r\n', nextPart: input.part ? null : 1 } }), { status: fail && input.part === 1 ? 403 : 200, headers: { 'content-type': 'application/json' } });
  };
  const io = { stdout: { write() {} }, stderr: { write() {} } }, env = { FANJIN_API_KEY: 'local-test-key' };
  try {
    assert.equal(await main(['usage', 'export-download', 'job-1', '--output', file], env, io), 0);
    assert.equal(await readFile(file, 'utf8'), 'id\r\na\r\nb\r\n'); assert.deepEqual(calls.map(x => x.part), [0, 1]);
    fail = true;
    assert.notEqual(await main(['usage', 'export-download', 'job-2', '--output', join(dir, 'failed.csv')], env, io), 0);
    assert.deepEqual(await readdir(dir), ['usage.csv']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
