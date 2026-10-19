import test from 'node:test';
import assert from 'node:assert/strict';
import {activate} from '../dist/main.js';
test('public resolver registration and teardown are owned by plugin lifetime',async()=>{
 let declaration;let disposed=0;let registered;let removals=0;
 const host={sourceResolvers:{register:async(d,handler)=>{declaration=d;assert.equal(typeof handler,'function');return {dispose:async()=>{disposed++;}};}},ui:{onCallback:()=>()=>removals++,close:async()=>{}},commands:{onExecute:()=>()=>removals++,register:async(...args)=>{registered=args;},update:async()=>{}}};
 const deactivate=await activate(host);
 assert.deepEqual(declaration,{id:'bilibili',schemes:['http','https'],hosts:['bilibili.com','www.bilibili.com','m.bilibili.com','b23.tv']});
 assert.deepEqual(registered[2].path,['文件','网络媒体','Bilibili 视频…']);
 await deactivate();assert.equal(disposed,1);assert.equal(removals,2);
});
