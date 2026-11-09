import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { getNodeAutoInstrumentations }=require('../fanjin-new/fanjin-api/src/lib/nodeAutoInstrumentations.js');
const fixture=JSON.parse(fs.readFileSync(new URL('./instrumentation-parity-fixtures.json',import.meta.url)));
for(const c of fixture.cases)test(`preserves upstream instrumentation: ${c.name}`,()=>{
 const keys=['OTEL_NODE_ENABLED_INSTRUMENTATIONS','OTEL_NODE_DISABLED_INSTRUMENTATIONS'];const before=keys.map(k=>process.env[k]);
 try{for(const k of keys)delete process.env[k];Object.assign(process.env,c.env);
 assert.deepEqual(getNodeAutoInstrumentations(c.config).map(x=>({name:x.instrumentationName,version:x.instrumentationVersion,config:x.getConfig()})),c.expected);
 }finally{keys.forEach((k,i)=>before[i]===undefined?delete process.env[k]:process.env[k]=before[i]);}
});
test('passes HTTP hooks through unchanged',()=>{const hook=()=>true;const instances=getNodeAutoInstrumentations({'@opentelemetry/instrumentation-http':{enabled:true,ignoreIncomingRequestHook:hook}});assert.equal(instances.find(x=>x.instrumentationName==='@opentelemetry/instrumentation-http').getConfig().ignoreIncomingRequestHook,hook);});
test('unused legacy driver and cloud aggregate are absent',()=>{const pkg=JSON.parse(fs.readFileSync(new URL('../fanjin-new/fanjin-api/package.json',import.meta.url)));assert.equal(pkg.dependencies.sqlite3,undefined);assert.equal(pkg.dependencies['@opentelemetry/auto-instrumentations-node'],undefined);assert.ok(pkg.dependencies['better-sqlite3']);const source=fs.readFileSync(new URL('../fanjin-new/fanjin-api/src/lib/createDatabaseClient.ts',import.meta.url),'utf8');assert.match(source,/client: "better-sqlite3"/);});
