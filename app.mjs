import {parseCSL,rankCandidates,queryURL,confirmedRows,patchedCSL,csvReport,makeZoteroScript,escapeHTML as esc,doiURL,authorText,norm} from './core.mjs';

const $=id=>document.getElementById(id);
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const STORE_KEY='doi-desk-session-v1';
const PAGE_SIZE=25;
let rows=[], sourceName='', active=false, controller=null, filter='all', page=1, candidateIndex=null, currentScriptMode=false;
let toastTimer, storageWarned=false, runTotal=0, runDone=0;
const cache=new Map();
const statusNames={ready:'待查询',querying:'查询中',existing:'已有 DOI',invalid:'缺少标题',high:'高匹配',review:'待核对',none:'未找到',error:'查询失败'};

function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4200);}
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=!message;}
function persist(){
  try{localStorage.setItem(STORE_KEY,JSON.stringify({version:1,sourceName,items:rows.map(row=>({raw:row.raw,status:row.status,candidates:row.candidates,chosen:row.chosen,confirmed:row.confirmed,error:row.error}))}));$('storage-status').textContent='进度自动保存在此浏览器';}
  catch { $('storage-status').textContent='本地存储不可用，请及时导出核对表';if(!storageWarned){storageWarned=true;toast('浏览器无法保存进度，请保持页面打开并及时导出核对表。',true);} }
}
function restore(){
  try{
    const saved=JSON.parse(localStorage.getItem(STORE_KEY)||'null');
    if(!saved || saved.version!==1 || !Array.isArray(saved.items) || !saved.items.length) return;
    rows=parseCSL(JSON.stringify(saved.items.map(x=>x.raw)));
    rows.forEach((row,i)=>{
      const previous=saved.items[i];
      if(row.status==='existing'||row.status==='invalid') return;
      if(['high','review','none','error','ready'].includes(previous.status)) row.status=previous.status;
      row.candidates=Array.isArray(previous.candidates)?previous.candidates:[];
      row.chosen=previous.chosen&&row.candidates.find(c=>c.doi===previous.chosen.doi)||null;
      row.confirmed=!!previous.confirmed&&!!row.chosen;
      row.error=String(previous.error||'');
    });
    sourceName=String(saved.sourceName||'上次导入');
    notice(`已恢复上次的 ${rows.length} 条文献及核对进度，可继续查询或批量回填。`);
  }catch{notice('上次的本地记录无法恢复，请重新导入 CSL JSON。',true);}
}

function setInputTab(name){
  for(const kind of ['file','paste']){
    $(kind+'-tab').classList.toggle('selected',kind===name);
    $(kind+'-tab').setAttribute('aria-selected',String(kind===name));
    $(kind+'-panel').hidden=kind!==name;
  }
  if(name==='paste') $('paste-input').focus();
}

function importText(text,name){
  if(active) return toast('请先暂停查询，再导入新文献。',true);
  let parsed;
  try{parsed=parseCSL(text);}catch(e){notice(e.message,true);return;}
  if(rows.length && !confirm('导入新文件会替换当前工作台中的文献与核对进度。需要保留结果时，请先导出核对表。继续导入？')) return;
  rows=parsed;sourceName=name;filter='all';page=1;runTotal=0;runDone=0;
  $('search').value='';$('progress-box').hidden=true;
  const existing=rows.filter(r=>r.existing).length, invalid=rows.filter(r=>r.status==='invalid').length;
  notice(`已导入 ${rows.length} 条文献，${rows.length-existing} 条缺少 DOI。${existing?`已跳过 ${existing} 条已有 DOI 的文献。`:''}${invalid?`${invalid} 条缺少可查询标题，请补充后重新导入。`:''}`);
  persist();render();toast('导入成功，可以开始批量查询。');
}
async function readFile(file){
  if(!file) return;
  if(file.size>15*1024*1024) return notice('文件超过 15 MB，请分批导出文献。',true);
  try{importText(await file.text(),file.name);}catch{notice('文件读取失败，请重新选择 .json 文件。',true);}
  $('file-input').value='';
}

function visibleRows(){
  const search=norm($('search').value);
  return rows.filter(row=>{
    const matches=filter==='all'||(filter==='high'&&row.status==='high'&&!row.confirmed)||(filter==='review'&&row.status==='review'&&!row.confirmed)||(filter==='confirmed'&&row.confirmed)||(filter==='unresolved'&&['ready','querying','none','error','invalid'].includes(row.status));
    const haystack=[row.title,row.author,row.year,row.existing,row.chosen?.doi,row.candidates[0]?.doi].join(' ');
    return matches&&(!search||norm(haystack).includes(search));
  });
}

function render(){
  const confirmed=confirmedRows(rows), high=rows.filter(r=>r.status==='high'&&!r.confirmed).length, review=rows.filter(r=>r.status==='review'&&!r.confirmed).length;
  $('stat-total').textContent=rows.length;$('stat-missing').textContent=rows.filter(r=>!r.existing).length;$('stat-high').textContent=high;$('stat-review').textContent=review;
  $('nav-count').textContent=rows.length;$('result-count').textContent=rows.length+' 条文献';$('confirmed-count').textContent=confirmed.length;
  $('confirm-high').disabled=!high;$('export-button').disabled=!confirmed.length;
  $('download-report').disabled=!rows.length;$('clear-button').disabled=active||!rows.length;
  $('start-button').hidden=active;$('pause-button').hidden=!active;
  const ready=rows.filter(r=>r.status==='ready').length, failed=rows.filter(r=>r.status==='error').length;
  $('start-button').disabled=(!ready&&!failed)||active;
  $('start-button').querySelector('span').textContent=ready?(rows.some(r=>['high','review','none'].includes(r.status))?'继续批量查询':'开始批量查询'):failed?'重试失败条目':'查询已完成';
  if(!rows.length) $('start-button').querySelector('span').textContent='开始批量查询';
  for(const id of ['sample-button','dropzone','parse-paste','email','file-input']) $(id).disabled=active;
  $('import-info').textContent=sourceName?`${sourceName} · ${rows.length} 条`:'还没有准备好文件？';
  $('import-info').title=sourceName;
  $('step-import').classList.toggle('current',!rows.length);
  $('step-query').classList.toggle('current',!!rows.length&&!confirmed.length);
  $('step-export').classList.toggle('current',!!confirmed.length);
  document.querySelectorAll('#filters button').forEach(button=>{button.classList.toggle('active',button.dataset.filter===filter);button.setAttribute('aria-pressed',String(button.dataset.filter===filter));});
  const filtered=visibleRows(),pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));page=Math.min(page,pages);
  const current=filtered.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE);
  $('result-rows').innerHTML=current.map(row=>{
    const candidate=row.chosen||row.candidates[0],doi=row.existing||candidate?.doi;
    const status=row.confirmed?'confirmed':row.status;
    const selectable=!!row.chosen&&!row.existing;
    const details=[authorText(row.raw),row.year,row.raw['container-title']].filter(Boolean).map(esc).join(' · ');
    const action=['high','review'].includes(row.status)||row.candidates.length?`<button class="table-action" data-review="${row.index}">核对</button>`:row.status==='error'?`<button class="table-action" data-retry="${row.index}" ${active?'disabled':''}>重试</button>`:'<span class="missing-text">—</span>';
    return `<tr><td><input type="checkbox" data-confirm="${row.index}" aria-label="确认匹配：${esc(row.title)}" ${row.confirmed?'checked':''} ${selectable?'':'disabled'} title="${selectable?'勾选后包含在批量回填中':'请先核对并选择候选'}"></td><td><div class="paper-title">${esc(row.title||'（缺少标题）')}</div><div class="paper-meta">${details||'无作者或年份信息'}</div>${row.status==='invalid'?'<div class="error-text">请补充标题后重新导出</div>':''}</td><td><span class="tag ${status}">${row.status==='querying'?'<span class="spinner"></span>':''}${row.confirmed?icon('check'):''}${row.confirmed?'已确认':statusNames[row.status]}</span>${candidate&&!row.existing?`<span class="score-text">匹配分数 ${candidate.score} / 100</span>`:''}</td><td>${doi?`<a class="doi-link" href="${esc(doiURL(doi))}" target="_blank" rel="noopener noreferrer">${esc(doi)}</a>${!row.confirmed&&!row.existing?'<span class="score-text">候选 · 核对后确认</span>':''}`:`<span class="missing-text">${row.status==='none'?'暂无匹配 DOI':row.status==='querying'?'正在检索…':'—'}</span>`}${row.status==='error'?`<div class="error-text">${esc(row.error)}</div>`:''}</td><td>${action}</td></tr>`;
  }).join('');
  $('empty-state').hidden=!!filtered.length;
  if(!filtered.length){$('empty-state').querySelector('h3').textContent=rows.length?'当前筛选下没有文献':'下一篇被找到的，就是你的文献';$('empty-state').querySelector('p').textContent=rows.length?'切换筛选条件，或尝试其他关键词。':'先导入 CSL JSON 文件，匹配结果会显示在这里。';}
  $('table-footer').hidden=!filtered.length;
  $('page-info').textContent=`${(page-1)*PAGE_SIZE+1}–${Math.min(page*PAGE_SIZE,filtered.length)} / ${filtered.length} 条 · 第 ${page} / ${pages} 页`;
  $('previous-page').disabled=page<=1;$('next-page').disabled=page>=pages;
}

function showProgress(message){
  $('progress-box').hidden=false;$('progress-text').textContent=message;
  $('progress-numbers').textContent=`${runDone} / ${runTotal}`;
  $('progress').max=runTotal||1;$('progress').value=runDone;
}
function abortError(){return new DOMException('已暂停','AbortError');}
function delay(ms,signal){return new Promise((resolve,reject)=>{
  if(signal?.aborted) return reject(abortError());
  const stop=()=>{clearTimeout(timer);reject(abortError());};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
  signal?.addEventListener('abort',stop,{once:true});
});}

async function crossref(row,email,signal){
  const url=queryURL(row,email),key=queryURL(row,'');
  if(cache.has(key)) return cache.get(key);
  for(let attempt=0;attempt<3;attempt++){
    if(signal.aborted) throw abortError();
    const timeoutController=new AbortController();
    const cancel=()=>timeoutController.abort();signal.addEventListener('abort',cancel,{once:true});
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;timeoutController.abort();},30000);
    let response, data;
    try{
      response=await fetch(url,{signal:timeoutController.signal,headers:{Accept:'application/json'},credentials:'omit',referrerPolicy:'no-referrer'});
      if(response.ok) data=await response.json();
    }catch(error){
      if(signal.aborted) throw abortError();
      if(attempt===2) throw new Error(timedOut?'请求超时，请重试':'无法连接 Crossref，请检查网络后重试');
      showProgress(`连接暂时失败，正在等待后重试（${attempt+1}/2）…`);
      await delay(2000*(attempt+1),signal);continue;
    }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
    if(response.ok){
      if(!data?.message || !Array.isArray(data.message.items)) throw new Error('Crossref 返回了无法识别的数据，请重试');
      cache.set(key,data.message.items);return data.message.items;
    }
    if((response.status===429||response.status>=500)&&attempt<2){
      const retry=response.headers.get('Retry-After');
      const retryMs=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now()):0;
      const wait=Math.max(5000*2**attempt,Number.isFinite(retryMs)?retryMs:0);
      showProgress(`Crossref ${response.status===429?'请求限流':'暂时不可用'}，等待 ${Math.ceil(wait/1000)} 秒后重试…`);
      await delay(wait,signal);continue;
    }
    throw new Error(response.status===429?'Crossref 请求限流，请稍后重试':response.status===403?'Crossref 拒绝请求，请稍后重试':`Crossref 服务错误（HTTP ${response.status}）`);
  }
}

async function startQuery(onlyIndex=null){
  if(active) return;
  const email=$('email').value.trim();
  if(email&&!$('email').checkValidity()){$('settings-panel').hidden=false;$('email').reportValidity();return;}
  const queue=rows.filter(row=>onlyIndex===null?['ready','error'].includes(row.status):row.index===onlyIndex&&row.status==='error');
  if(!queue.length) return;
  active=true;controller=new AbortController();runTotal=queue.length;runDone=0;notice('');render();
  let errorStreak=0,pausedByError=false;
  try{
    for(const row of queue){
      if(controller.signal.aborted) break;
      row.status='querying';render();showProgress(`正在查询：${row.title}`);
      try{
        const works=await crossref(row,email,controller.signal);
        const ranked=rankCandidates(row,works);
        row.candidates=ranked.candidates;row.chosen=ranked.high?ranked.candidates[0]:null;row.confirmed=false;row.error='';
        row.status=!ranked.candidates.length?'none':ranked.high?'high':'review';
        errorStreak=0;
      }catch(e){
        if(e.name==='AbortError'){row.status='ready';break;}
        row.status='error';row.error=e.message;errorStreak++;
      }
      runDone++;persist();render();showProgress(`已查询 ${runDone} 条，候选结果可随时核对`);
      if(errorStreak>=3){pausedByError=true;break;}
      if(runDone<queue.length) await delay(1200,controller.signal);
    }
  }catch(e){if(e.name!=='AbortError') notice('查询中断：'+e.message,true);}
  finally{
    const paused=controller.signal.aborted||pausedByError;
    active=false;controller=null;persist();render();
    showProgress(paused?`已暂停 · 保留已完成的 ${runDone} 条查询`:`本批查询完成 · ${runDone} 条`);
    if(pausedByError) notice('连续 3 条查询失败，已自动暂停。请检查到 api.crossref.org 的网络连接后继续；失败条目可重试。',true);
    else if(!paused) notice(`查询完成。${rows.filter(r=>r.status==='high'&&!r.confirmed).length} 条高匹配可整批确认，${rows.filter(r=>r.status==='review'&&!r.confirmed).length} 条需要核对。${rows.some(r=>r.status==='error')?'存在查询失败的条目，可点击重试。':''}`);
    toast(paused?'已暂停，进度已保留。':'查询完成，请核对并确认结果。');
  }
}

function openCandidates(index){
  const row=rows[index];if(!row) return;candidateIndex=index;
  $('candidate-original').innerHTML=`<div class="small-label">ZOTERO 原文献</div><h3>${esc(row.title)}</h3><p>${esc(authorText(row.raw)||'作者缺失')} · ${esc(row.year||'年份缺失')}${row.raw['container-title']?' · '+esc(row.raw['container-title']):''}</p>`;
  $('candidate-list').innerHTML=row.candidates.map((candidate,i)=>`<article class="candidate-card ${row.confirmed&&row.chosen?.doi===candidate.doi?'chosen':''}"><div class="candidate-card-top"><h3>${esc(candidate.title)}</h3><div class="match-score">${candidate.score}<small> / 100</small></div></div><p class="candidate-meta">${esc(candidate.authors||'作者未提供')} · ${esc(candidate.year||'年份未提供')}<br>${esc(candidate.journal||'来源未提供')} · ${esc(candidate.type)}</p><div class="candidate-evidence">${candidate.reasons.map(reason=>`<span class="${/不同|相差/.test(reason)?'conflict':''}">${esc(reason)}</span>`).join('')}</div><div class="candidate-bottom"><a class="doi-link" href="${esc(doiURL(candidate.doi))}" target="_blank" rel="noopener noreferrer">${esc(candidate.doi)} ↗</a><button class="button small ${row.chosen?.doi===candidate.doi&&row.confirmed?'secondary':''}" data-choose="${i}">${row.chosen?.doi===candidate.doi&&row.confirmed?'已确认使用':'确认使用'}</button></div></article>`).join('');
  $('candidate-dialog').showModal();
}
function setScript(mode){currentScriptMode=mode;$('script-output').value=makeZoteroScript(rows,mode);}
function openExport(){
  const count=confirmedRows(rows).length;if(!count) return;
  $('export-count').textContent=count;setScript(false);$('export-dialog').showModal();
}
async function copy(text,button){
  try{
    if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area=document.createElement('textarea');area.value=text;area.className='clipboard-fallback';
      const parent=document.querySelector('dialog[open]')||document.body;parent.append(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok) throw new Error('copy');
    }
    toast('已复制，可粘贴到 Zotero。');
    if(button){const original=button.innerHTML;button.textContent='✓ 已复制';setTimeout(()=>button.innerHTML=original,2000);}
  }catch{
    if(!$('export-dialog').open) openExport();
    $('script-output').value=text;
    document.querySelector('.script-details').open=true;$('script-output').focus();$('script-output').select();
    toast('自动复制不可用，已选中内容，请按 Ctrl/Cmd+C 复制。',true);
  }
}
function download(name,content,type){
  const url=URL.createObjectURL(new Blob([content],{type})), a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const report=()=>download('doi-review.csv',csvReport(rows),'text/csv;charset=utf-8');

$('file-tab').addEventListener('click',()=>setInputTab('file'));
$('paste-tab').addEventListener('click',()=>setInputTab('paste'));
document.querySelector('.input-tabs').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const to=$('file-tab').getAttribute('aria-selected')==='true'?'paste':'file';setInputTab(to);$(to+'-tab').focus();}});
$('dropzone').addEventListener('click',()=>$('file-input').click());
$('file-input').addEventListener('change',event=>readFile(event.target.files[0]));
for(const type of ['dragenter','dragover']) $('dropzone').addEventListener(type,event=>{event.preventDefault();if(!active)$('dropzone').classList.add('dragover');});
for(const type of ['dragleave','drop']) $('dropzone').addEventListener(type,event=>{event.preventDefault();$('dropzone').classList.remove('dragover');});
$('dropzone').addEventListener('drop',event=>{if(!active)readFile(event.dataTransfer.files[0]);});
window.addEventListener('dragover',event=>event.preventDefault());window.addEventListener('drop',event=>event.preventDefault());
$('parse-paste').addEventListener('click',()=>importText($('paste-input').value,'粘贴的 CSL JSON'));
$('sample-button').addEventListener('click',()=>importText(JSON.stringify([
  {id:'example-resnet',type:'paper-conference',title:'Deep Residual Learning for Image Recognition',author:[{family:'He',given:'Kaiming'},{family:'Zhang',given:'Xiangyu'},{family:'Ren',given:'Shaoqing'},{family:'Sun',given:'Jian'}],issued:{'date-parts':[[2016]]},'container-title':'2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)'},
  {id:'example-alphago',type:'article-journal',title:'Mastering the game of Go with deep neural networks and tree search',author:[{family:'Silver',given:'David'},{family:'Huang',given:'Aja'}],issued:{'date-parts':[[2016]]},'container-title':'Nature'},
  {id:'example-transformer',type:'article-journal',title:'The molecular structure of nucleic acids',author:[{family:'Watson',given:'James'}],issued:{'date-parts':[[1953]]}},
  {id:'example-deep',type:'article-journal',title:'Deep learning',DOI:'10.1038/nature14539',author:[{family:'LeCun',given:'Yann'},{family:'Bengio',given:'Yoshua'},{family:'Hinton',given:'Geoffrey'}],issued:{'date-parts':[[2015]]},'container-title':'Nature'}
]),'示例文献（真实查询）'));
$('settings-button').addEventListener('click',()=>{$('settings-panel').hidden=!$('settings-panel').hidden;$('settings-button').setAttribute('aria-expanded',String(!$('settings-panel').hidden));});
$('start-button').addEventListener('click',()=>startQuery());
$('pause-button').addEventListener('click',()=>controller?.abort());
$('filters').addEventListener('click',event=>{const button=event.target.closest('[data-filter]');if(button){filter=button.dataset.filter;page=1;render();}});
$('search').addEventListener('input',()=>{page=1;render();});
$('previous-page').addEventListener('click',()=>{page--;render();});$('next-page').addEventListener('click',()=>{page++;render();});
$('result-rows').addEventListener('change',event=>{const input=event.target.closest('[data-confirm]');if(!input)return;const row=rows[Number(input.dataset.confirm)];if(row.chosen&&!row.existing){row.confirmed=input.checked;persist();render();}});
$('result-rows').addEventListener('click',event=>{const review=event.target.closest('[data-review]'),retry=event.target.closest('[data-retry]');if(review)openCandidates(Number(review.dataset.review));if(retry)startQuery(Number(retry.dataset.retry));});
$('candidate-list').addEventListener('click',event=>{const button=event.target.closest('[data-choose]');if(!button)return;const row=rows[candidateIndex];row.chosen=row.candidates[Number(button.dataset.choose)];row.confirmed=true;persist();render();$('candidate-dialog').close();toast('已确认，该文献将包含在批量回填中。');});
$('reject-candidates').addEventListener('click',()=>{const row=rows[candidateIndex];row.chosen=null;row.confirmed=false;row.status='none';persist();render();$('candidate-dialog').close();toast('已排除，回填时会跳过此文献。');});
$('confirm-high').addEventListener('click',()=>{const candidates=rows.filter(r=>r.status==='high'&&!r.confirmed);if(!candidates.length)return;if(!confirm(`确认采用 ${candidates.length} 条高匹配候选？\n\n这些记录的标题、第一作者、年份和文献类型通过了比对，但仍可能存在版本差异。确认后将包含在回填脚本中。`))return;candidates.forEach(r=>r.confirmed=true);persist();render();toast(`已整批确认 ${candidates.length} 条结果。`);});
$('export-button').addEventListener('click',openExport);
for(const [id,apply] of [['copy-preview',false],['copy-apply',true]])$(id).addEventListener('click',()=>{setScript(apply);copy($('script-output').value,$(id));});
$('show-preview').addEventListener('click',()=>setScript(false));$('show-apply').addEventListener('click',()=>setScript(true));
$('download-script').addEventListener('click',()=>download(currentScriptMode?'zotero-fill-doi.js':'zotero-preview-doi.js',$('script-output').value,'text/javascript;charset=utf-8'));
$('download-json').addEventListener('click',()=>download('zotero-with-doi.json',JSON.stringify(patchedCSL(rows),null,2),'application/json'));
$('copy-json').addEventListener('click',()=>copy(JSON.stringify(patchedCSL(rows),null,2),$('copy-json')));
$('download-report').addEventListener('click',report);$('export-csv').addEventListener('click',report);
for(const id of ['help-nav','help-top'])$(id).addEventListener('click',()=>$('help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
$('clear-button').addEventListener('click',()=>{if(active)return;if(!confirm('清空当前浏览器中的文献与核对进度？Zotero 中的文献不受影响。'))return;rows=[];sourceName='';filter='all';page=1;cache.clear();try{localStorage.removeItem(STORE_KEY);}catch{}$('paste-input').value='';$('search').value='';$('email').value='';$('progress-box').hidden=true;notice('');render();toast('已清空本地记录。');});
window.addEventListener('beforeunload',event=>{if(active){event.preventDefault();event.returnValue='';}});
restore();render();
