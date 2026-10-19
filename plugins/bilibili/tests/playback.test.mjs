import test from 'node:test';
import assert from 'node:assert/strict';
import {submitOnce,openBilibili} from '../dist/playback.js';
const ticket={stamp:{generation:2,intentVersion:5},cycle:1,owner:4};
const state=phase=>({...ticket,phase,terminalReason:null});
test('uncertain submit queries same id once without reopening',async()=>{
 const calls=[];
 const host={source:{submit:async(intent,id)=>{calls.push(['submit',id,intent]);throw Error('timeout');},operation:async(id)=>{calls.push(['query',id]);return {status:'pending',ticket};}}};
 assert.equal((await submitOnce(host,'https://b23.tv/test',42)).ticket,ticket);
 assert.deepEqual(calls.map(x=>x.slice(0,2)),[['submit',42],['query',42]]);
});
test('ready requires backend source phase rather than submit acceptance',async()=>{
 const statuses=[];let reads=0;
 const host={source:{submit:async()=>({status:'completed',ticket}),state:async()=>{reads++;return state(reads===1?'loading':'ready');}}};
 await openBilibili(host,'https://b23.tv/test',2,new AbortController().signal,async x=>statuses.push(x));
 assert.equal(reads,2);assert.equal(statuses.at(-1),'视频已就绪。');
});
test('cancel closes only original CAS and uses separate operation id',async()=>{
 const c=new AbortController();const submissions=[];
 const host={source:{submit:async(intent,id)=>{submissions.push({intent,id});if(intent.kind==='open')c.abort();return {status:'pending',ticket};}}};
 await assert.rejects(openBilibili(host,'https://b23.tv/test',20,c.signal,async()=>{}));
 assert.deepEqual(submissions.at(-1),{intent:{kind:'close',expected:ticket.stamp},id:21});
});
test('replaced request never closes newer source',async()=>{
 let submissions=0;
 const host={source:{submit:async()=>{submissions++;return {status:'pending',ticket};},state:async()=>({...state('ready'),stamp:{generation:3,intentVersion:6}})}};
 await assert.rejects(openBilibili(host,'https://b23.tv/test',22,new AbortController().signal,async()=>{}),/替换/);
 assert.equal(submissions,1);
});
test('backend media errors remain visible errors',async()=>{
 const host={source:{submit:async()=>({status:'pending',ticket}),state:async()=>({...state('error'),terminalReason:{failed:'CDN denied'}})}};
 await assert.rejects(openBilibili(host,'https://b23.tv/test',24,new AbortController().signal,async()=>{}),/CDN denied/);
});
