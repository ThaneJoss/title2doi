import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCSL,rankCandidates,patchedCSL,makeZoteroScript,zoteroApply,csvReport,queryURL,cleanDOI,doiURL,titleSimilarity} from '../core.mjs';

const original={id:'https://www.zotero.org/users/123/items/ABCD1234',type:'article-journal',title:'A careful study of cells and signals',author:[{family:'García',given:'Ana'}],issued:{'date-parts':[[2020]]},'container-title':'Cell Research',note:'Keep this note',DOI:''};
const work={DOI:'10.1234/cells.001',title:[original.title],author:[{family:'Garcia',given:'Ana'}],issued:{'date-parts':[[2020]]},type:'journal-article','container-title':['Cell Research']};
const row=()=>parseCSL(JSON.stringify([original]))[0];
const confirmed=()=>{const r=row();const ranked=rankCandidates(r,[work]);return {...r,status:'high',candidates:ranked.candidates,chosen:ranked.candidates[0],confirmed:true};};

test('CSL export accepts BOM and singles; existing DOI is preserved, missing title is reported',()=>{
  const parsed=parseCSL('\uFEFF'+JSON.stringify([original,{...original,DOI:'https://doi.org/10.1000/existing'},{type:'book'}]));
  assert.deepEqual(parsed.map(r=>r.status),['ready','existing','invalid']);
  const missingTitles=parseCSL(JSON.stringify([{type:'book',title:null},{type:'book',title:''}]));
  assert.deepEqual(missingTitles.map(r=>({title:r.title,status:r.status})),[{title:'',status:'invalid'},{title:'',status:'invalid'}]);
  assert.equal(parseCSL(JSON.stringify(original)).length,1);
  assert.throws(()=>parseCSL('TY - JOUR'),/CSL JSON/);
  assert.throws(()=>parseCSL('[{}]'),/type/);
  assert.throws(()=>parseCSL('[]'),/没有文献/);
  assert.throws(()=>parseCSL(JSON.stringify([{...original,author:'name'}])),/author/);
  assert.throws(()=>parseCSL(JSON.stringify([{...original,DOI:123}])),/DOI/);
});

test('matching requires title, first author, year, publication type, and a clear margin',()=>{
  assert.equal(rankCandidates(row(),[work]).high,true);
  for(const change of [{author:[{family:'Jones'}]},{issued:{'date-parts':[[2021]]}},{type:'posted-content'},{title:['An unrelated paper about mathematics']}]) assert.equal(rankCandidates(row(),[{...work,...change}]).high,false);
  assert.equal(rankCandidates({...row(),author:''},[work]).high,false);
  assert.equal(rankCandidates({...row(),year:''},[work]).high,false);
  assert.equal(rankCandidates(row(),[work,{...work,DOI:'10.1234/cells.other'}]).high,false);
  assert.equal(rankCandidates({...row(),title:'Editorial'},[{...work,title:['Editorial']}]).high,false);
  assert.equal(rankCandidates(row(),[work,{...work,DOI:work.DOI.toUpperCase()}]).candidates.length,1);
  assert.equal(titleSimilarity('中文文献的标点，测试。','中文文献的标点, 测试'),1);
});

test('only confirmed empty DOI values are exported; other metadata and rows stay intact',()=>{
  const a=confirmed(), b={...row(),existing:'10.2000/original',raw:{...original,DOI:'10.2000/original'},confirmed:true,chosen:a.chosen},c={...row(),chosen:a.chosen};
  const result=patchedCSL([a,b,c]);
  assert.equal(result[0].DOI,work.DOI);assert.equal(result[0].note,original.note);
  assert.equal(result[1].DOI,'10.2000/original');assert.equal(result[2].DOI,'');assert.equal(a.raw.DOI,'');
  const url=new URL(queryURL(a,'a+tag@example.org'));assert.equal(url.searchParams.get('mailto'),'a+tag@example.org');assert.equal(url.searchParams.get('rows'),'5');assert.ok(!url.href.includes('Keep'));
  assert.equal(cleanDOI('https://doi.org/10.1000%2Fabc'),'10.1000/abc');
  assert.equal(cleanDOI('javascript:alert(1)'), '');
});

test('DOI links normalize supported inputs without changing imported metadata',()=>{
  for(const value of ['10.1000/example',' DOI: 10.1000/example ','https://doi.org/10.1000/example','http://dx.doi.org/10.1000/example','https://doi.org/10.1000%2Fexample']){
    const parsed=parseCSL(JSON.stringify({...original,DOI:value}));
    assert.equal(doiURL(parsed[0].existing),'https://doi.org/10.1000/example');
    assert.equal(parsed[0].status,'existing');
    assert.equal(patchedCSL(parsed)[0].DOI,value);
  }
  assert.equal(doiURL('10.1000/part?version#section'),'https://doi.org/10.1000/part%3Fversion%23section');
  for(const value of ['',null,'not-a-doi','https://example.org/10.1000/example','javascript:alert(1)']) assert.equal(doiURL(value),'');
});

test('DOI normalization decodes resolver URLs once and preserves literal percent characters',()=>{
  for(const suffix of ['a%20b','a%2Fb','a%25b','a%252Fb','100%','中文']){
    const doi='10.1000/'+suffix;
    const url='https://doi.org/10.1000/'+encodeURIComponent(suffix);
    for(const value of [doi,'doi: '+doi,url,url.replace('https://doi.org/','http://dx.doi.org/')]){
      assert.equal(cleanDOI(value),doi);
      assert.equal(cleanDOI(cleanDOI(value)),doi);
      assert.equal(doiURL(value),url);
      const parsed=parseCSL(JSON.stringify({...original,DOI:value}));
      assert.equal(patchedCSL(parsed)[0].DOI,value);
    }
  }
  assert.equal(cleanDOI('https://doi.org/10.1000/a%2Fb'),'10.1000/a/b');
  assert.equal(doiURL('https://doi.org/10.1000/a%2Fb'),'https://doi.org/10.1000/a/b');
  assert.equal(cleanDOI('https://doi.org/10.1000/invalid%ZZ'),'');
});

test('ranked DOI candidates retain their identity in links and exported metadata',()=>{
  for(const doi of ['10.1000/a%20b','10.1000/a%2Fb','10.1000/a%252Fb']){
    const candidate=rankCandidates(row(),[{...work,DOI:doi}]).candidates[0];
    assert.equal(candidate.doi,doi);
    assert.equal(doiURL(candidate.doi),'https://doi.org/'+encodeURIComponent(doi).replace(/%2F/gi,'/'));
    assert.equal(patchedCSL([{...row(),chosen:candidate,confirmed:true}])[0].DOI,doi);
  }
});

function fakeItem(changes={}){
  const fields={title:original.title,date:'2020-02-01',DOI:'',extra:'',...changes.fields};
  const item={id:1,key:'ABCD1234',itemTypeID:22,isRegularItem:()=>true,getField:key=>fields[key]||'',getCreators:()=>[{lastName:'García',firstName:'Ana'}],setField:(key,value)=>{fields[key]=value;},save:async()=>{item.saved++;},saved:0,fields,...changes};
  return item;
}
function mockZotero(items){let transactions=0;return {getActiveZoteroPane:()=>({getSelectedItems:()=>items}),ItemFields:{getID:()=>1,isValidForType:(_field,type)=>type!==999},DB:{executeTransaction:async fn=>{transactions++;await fn();}},get transactionCount(){return transactions;}};}
const payload=()=>[{title:original.title,author:'García',year:'2020',key:'ABCD1234',doi:work.DOI}];

test('Zotero preview produces a plan and never writes',async()=>{
  const item=fakeItem(),Z=mockZotero([item]);const result=await zoteroApply(payload(),false,Z,()=>{throw Error('preview must not confirm');});
  assert.match(result,/可补全 1/);assert.equal(item.fields.DOI,'');assert.equal(item.saved,0);assert.equal(Z.transactionCount,0);
});
test('Zotero apply updates the selected original in one transaction, only after confirmation',async()=>{
  const item=fakeItem(),Z=mockZotero([item]);
  await zoteroApply(payload(),true,Z,()=>false);assert.equal(item.saved,0);
  const report=await zoteroApply(payload(),true,Z,()=>true);
  assert.match(report,/已补全 1/);assert.equal(item.saved,1);assert.equal(item.fields.DOI,work.DOI);assert.equal(Z.transactionCount,1);assert.equal(item.fields.title,original.title);
});
test('Zotero protects existing DOI and DOI in Extra, unsupported types, and attachments',async()=>{
  for(const item of [fakeItem({fields:{...fakeItem().fields,DOI:'10.9999/protected'}}),fakeItem({fields:{...fakeItem().fields,extra:'DOI: 10.9999/extra'}}),fakeItem({itemTypeID:999}),fakeItem({isRegularItem:()=>false})]){
    await zoteroApply(payload(),true,mockZotero([item]),()=>true);assert.equal(item.saved,0);
  }
});
test('Zotero requires stable key and title, or unique exact title + author + year',async()=>{
  for(const item of [fakeItem({key:'DIFFEREN'}),fakeItem({fields:{...fakeItem().fields,title:'Another title'}})]){await zoteroApply(payload(),true,mockZotero([item]),()=>true);assert.equal(item.saved,0);}
  const noKey=[{...payload()[0],key:''}], good=fakeItem();
  await zoteroApply(noKey,true,mockZotero([good]),()=>true);assert.equal(good.saved,1);
  for(const [change,item] of [[{year:''},fakeItem()],[{author:''},fakeItem()],[{year:'2021'},fakeItem()],[{author:'Different'},fakeItem()]]){
    await zoteroApply([{...noKey[0],...change}],true,mockZotero([item]),()=>true);assert.equal(item.saved,0);
  }
  const duplicates=[fakeItem(),fakeItem({id:2})];const result=await zoteroApply(noKey,true,mockZotero(duplicates),()=>true);
  assert.match(result,/重复条目/);assert.ok(duplicates.every(i=>i.saved===0));
});
test('duplicate input does not overwrite an item twice, repeated runs are idempotent',async()=>{
  const item=fakeItem(),Z=mockZotero([item]);
  const result=await zoteroApply([...payload(),...payload()],true,Z,()=>true);assert.equal(item.saved,1);assert.match(result,/重复条目/);
  await zoteroApply(payload(),true,Z,()=>true);assert.equal(item.saved,1);
});
test('copied JavaScript compiles and runs as an asynchronous Zotero script',async()=>{
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const item=fakeItem(),script=makeZoteroScript([confirmed()],true);
  const fn=new AsyncFunction('Zotero','confirm',script);
  assert.match(await fn(mockZotero([item]),()=>true),/已补全 1/);
  const r=confirmed();r.raw.title='Text "); throw Error("injection"); //';
  assert.doesNotThrow(()=>new AsyncFunction('Zotero','confirm',makeZoteroScript([r],false)));
});
test('CSV escapes quotes, preserves line breaks and neutralizes formula prefixes',()=>{
  const a=confirmed();a.title='=HYPERLINK("bad")\nnew line';const csv=csvReport([a]);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"\'=HYPERLINK(""bad"")\nnew line"'));assert.ok(csv.includes('10.1234/cells.001'));
});
