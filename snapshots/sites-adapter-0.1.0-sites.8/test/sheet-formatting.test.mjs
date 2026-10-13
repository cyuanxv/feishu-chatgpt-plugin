import test from 'node:test';import assert from 'node:assert/strict';
import {writeInput,WriteProvider} from '../.test-build/module.mjs';
const ok=data=>Response.json({code:0,data});
test('formatting bounds and column indexing reject destructive or unbounded input',()=>{
 for(const range of ['s!C3:A1','s!A1:ZZ99999','s!A0:B2','s!A1:B1001']) assert.throws(()=>writeInput('merge_sheet_cells',{token:'t',range}));
 for(const color of ['red','#fff','#12345678','url(x)'])assert.throws(()=>writeInput('set_sheet_font_color',{token:'t',range:'s!A1:A1',color}));
 for(const a of [{start_column:0,end_column:1,width_px:100},{start_column:2,end_column:1,width_px:100},{start_column:1,end_column:101,width_px:100},{start_column:1,end_column:1,width_px:0}])assert.throws(()=>writeInput('set_sheet_column_width',{token:'t',sheet_id:'s',...a}));
 assert.equal(writeInput('merge_sheet_cells',{token:'t',range:'s!A1:B1'}).merge_type,'MERGE_ALL');
});
test('font color changes only foreground, width uses 1-based inclusive columns',async()=>{
 const calls=[];const p=new WriteProvider(async(u,i)=>{calls.push([u,i.method,JSON.parse(i.body)]);return ok(u.endsWith('styles_batch_update')?{responses:[{updatedRange:'s!A1:C1',updatedCells:3}]}:{})});
 assert.equal((await p.execute('t','set_sheet_font_color',{token:'book',range:'s!A1:C1',color:'#D93025'},'id')).status,'succeeded');
 assert.deepEqual(calls[0][2],{data:[{ranges:['s!A1:C1'],style:{foreColor:'#D93025'}}]});
 assert.equal(calls[0][1],'PUT');
 assert.equal((await p.execute('t','set_sheet_column_width',{token:'book',sheet_id:'s',start_column:1,end_column:3,width_px:180},'id')).status,'succeeded');
 assert.deepEqual(calls[1][2],{dimension:{sheetId:'s',majorDimension:'COLUMNS',startIndex:1,endIndex:3},dimensionProperties:{fixedSize:180}});
});
test('merge preserves anchors but blocks numbers, false, formulas and rich content elsewhere',async()=>{
 for(const value of [0,false,'=IF(1,"","")',{text:'x'},'keep']){let writes=0;const p=new WriteProvider(async(u,i)=>{if(i.method!=='GET')writes++;return ok({valueRange:{range:'s!A1:B1',values:[['anchor',value]]}})});const r=await p.execute('t','merge_sheet_cells',{token:'book',range:'s!A1:B1',merge_type:'MERGE_ALL'},'id');assert.equal(r.error,'merge_would_discard_content');assert.equal(r.status,'failed');assert.equal(writes,0);}
});
test('row and column merge preflights validate each retained anchor and never overwrite on malformed reads',async()=>{
 for(const [merge_type,values]of [['MERGE_ALL',[['a',null],[null,'']]],['MERGE_ROWS',[['a',null],['b','']]],['MERGE_COLUMNS',[['a','b'],[null,'']]]]){
 const calls=[];const p=new WriteProvider(async(u,i)=>{calls.push([u,i.method,i.body&&JSON.parse(i.body)]);return ok(i.method==='GET'?{valueRange:{range:'s!A1:B2',values}}:{spreadsheetToken:'book'})});
 assert.equal((await p.execute('t','merge_sheet_cells',{token:'book',range:'s!A1:B2',merge_type},'id')).status,'succeeded');assert(calls[0][0].endsWith('?valueRenderOption=Formula'));assert.deepEqual(calls[1][2],{range:'s!A1:B2',mergeType:merge_type});
 }
 let writes=0;const p=new WriteProvider(async(u,i)=>{if(i.method!=='GET')writes++;return ok({valueRange:{range:'wrong',values:[]}})});assert.equal((await p.execute('t','merge_sheet_cells',{token:'book',range:'s!A1:B2',merge_type:'MERGE_ALL'},'id')).error,'merge_preflight_incomplete');assert.equal(writes,0);
});
test('split uses unmerge endpoint; malformed mutation receipts and timeouts stay unknown',async()=>{
 const p=new WriteProvider(async(u,i)=>{assert(u.endsWith('/unmerge_cells'));assert.deepEqual(JSON.parse(i.body),{range:'s!D5:E5'});return ok({spreadsheetToken:'book'})});assert.equal((await p.execute('t','unmerge_sheet_cells',{token:'book',range:'s!D5:E5'},'id')).status,'succeeded');
 for(const f of [async()=>ok({responses:[]}),async()=>{throw Error('timeout')}])assert.equal((await new WriteProvider(f).execute('t','set_sheet_font_color',{token:'book',range:'s!A1:B1',color:'#000000'},'id')).status,'unknown');
});
