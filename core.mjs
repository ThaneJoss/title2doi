export function plain(value = '') {
  return String(value).replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

export function norm(value) {
  return plain(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const yearOf = (date) => String(date?.['date-parts']?.[0]?.[0] ?? '').match(/^\d{4}$/)?.[0] || String(date?.raw || date?.literal || '').match(/\b(?:1[5-9]|20|21)\d{2}\b/)?.[0] || '';
export const firstAuthor = (item) => plain(item.author?.[0]?.family || item.author?.[0]?.literal || '');
export const authorText = (item) => (item.author || []).slice(0, 3).map(a => plain(a.literal || [a.given, a.family].filter(Boolean).join(' '))).join(', ') + ((item.author?.length || 0) > 3 ? ' et al.' : '');

export function cleanDOI(value) {
  let doi = String(value || '').trim().replace(/^doi\s*:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  try { doi = decodeURIComponent(doi); } catch {}
  return /^10\.\d{4,9}\/[^\s]+$/i.test(doi) ? doi : '';
}
export const doiURL = doi => 'https://doi.org/' + encodeURIComponent(doi).replace(/%2F/gi, '/');

export function parseCSL(text) {
  if (new TextEncoder().encode(text).length > 15 * 1024 * 1024) throw new Error('文件超过 15 MB。请分批导出文献。');
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '').trim()); }
  catch { throw new Error('无法解析 JSON。请在 Zotero 中将导出格式选为「CSL JSON」，不要粘贴参考文献列表或 BibTeX。'); }
  const items = Array.isArray(data) ? data : [data];
  if (!items.length) throw new Error('文件中没有文献条目。');
  if (items.length > 5000) throw new Error('每批最多 5,000 条，请分批导出。');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string' || !item.type) throw new Error(`第 ${i + 1} 条不是 CSL JSON 条目（缺少 type）。请使用 Zotero 的「CSL JSON」导出。`);
    if (item.title != null && typeof item.title !== 'string') throw new Error(`第 ${i + 1} 条 title 应为文本。`);
    if (item.author != null && (!Array.isArray(item.author) || item.author.some(a => !a || typeof a !== 'object'))) throw new Error(`第 ${i + 1} 条 author 格式不正确。`);
    if (item.DOI != null && typeof item.DOI !== 'string') throw new Error(`第 ${i + 1} 条 DOI 应为文本。`);
  }
  return items.map((raw, index) => ({index, raw, title:plain(raw.title || ''), year:yearOf(raw.issued), author:firstAuthor(raw), existing:String(raw.DOI || '').trim(), status:raw.DOI?.trim() ? 'existing' : norm(raw.title).length < 4 ? 'invalid' : 'ready', candidates:[], chosen:null, confirmed:false, error:''}));
}

function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  for (let i = 0; i < a.length - 1; i++) counts.set(a.slice(i, i+2), (counts.get(a.slice(i, i+2)) || 0) + 1);
  let common = 0;
  for (let i = 0; i < b.length - 1; i++) { const key=b.slice(i,i+2), count=counts.get(key)||0; if(count){common++;counts.set(key,count-1);} }
  return 2 * common / (a.length+b.length-2);
}

export function titleSimilarity(a, b) {
  a=norm(a);b=norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const at=new Set(a.split(' ')),bt=new Set(b.split(' '));
  const overlap=[...at].filter(x=>bt.has(x)).length;
  const tokenScore=overlap/(at.size+bt.size-overlap);
  return 0.8*dice(a,b)+0.2*tokenScore;
}

export function rankCandidates(row, works) {
  const seen=new Set();
  const typeMap={'article-journal':'journal-article','paper-conference':'proceedings-article','chapter':'book-chapter','book':'book','dataset':'dataset','report':'report','thesis':'dissertation','manuscript':'posted-content'};
  const candidates = works.flatMap(work=>{
    const doi=cleanDOI(work.DOI);
    if(!doi || seen.has(doi.toLowerCase())) return [];
    seen.add(doi.toLowerCase());
    const title=plain(work.title?.[0] || '');
    if(!title) return [];
    const titleScore=titleSimilarity(row.title,title);
    const year=yearOf(work.issued || work.published);
    const author=firstAuthor(work);
    const authorMatch=!!row.author && !!author && norm(row.author)===norm(author);
    const yearDelta=row.year && year ? Math.abs(Number(row.year)-Number(year)) : null;
    const yearMatch=yearDelta===0;
    const typeMismatch=!!typeMap[row.raw.type] && !!work.type && typeMap[row.raw.type]!==work.type;
    let score=titleScore*80;
    if(row.author && author) score+=authorMatch?12:0; else score+=4;
    if(yearDelta!==null) score+=yearDelta===0?8:yearDelta===1?4:0; else score+=2;
    if(typeMismatch) score-=6;
    const reasons=[`标题相似度 ${Math.round(titleScore*100)} / 100`,row.author&&author?(authorMatch?'第一作者一致':'第一作者不同'):'缺少作者用于比对',yearDelta!==null?(yearMatch?'年份一致':`年份相差 ${yearDelta} 年`):'缺少年份用于比对'];
    if(typeMismatch) reasons.push('文献类型不同');
    return [{doi,title,year,author,authors:authorText(work),journal:plain(work['container-title']?.[0]||''),type:work.type||'',titleScore,score:Math.round(score),authorMatch,yearMatch,typeMismatch,reasons}];
  }).sort((a,b)=>b.score-a.score);
  const top=candidates[0], second=candidates[1];
  const high=!!top && top.titleScore>=0.96 && top.authorMatch && top.yearMatch && !top.typeMismatch && norm(row.title).length>=20 && (!second || top.score-second.score>=8);
  return {candidates,high};
}

export function queryURL(row, email='') {
  const url=new URL('https://api.crossref.org/works');
  url.searchParams.set('query.bibliographic',[row.title,row.author,row.year].filter(Boolean).join(' ').slice(0,1800));
  url.searchParams.set('rows','5');
  url.searchParams.set('select','DOI,title,author,issued,container-title,type');
  if(email) url.searchParams.set('mailto',email);
  return url.href;
}

export const confirmedRows = rows => rows.filter(r => r.confirmed && r.chosen && !r.existing);
export function patchedCSL(rows) {
  return rows.map(row=>row.confirmed && row.chosen && !row.existing ? {...row.raw, DOI:row.chosen.doi} : row.raw);
}
export function csvReport(rows) {
  const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  const statusNames={ready:'待查询',querying:'待查询',existing:'已有 DOI',invalid:'缺少标题',high:'高匹配待确认',review:'待核对',none:'未找到',error:'查询失败'};
  return '\uFEFF'+[['标题','第一作者','年份','原 DOI','确认 DOI','状态','匹配分数','候选标题'],...rows.map(r=>[r.title,r.author,r.year,r.existing,r.confirmed?r.chosen?.doi:'',r.confirmed?'已确认':statusNames[r.status],r.chosen?.score??'',r.chosen?.title??''])].map(line=>line.map(cell).join(',')).join('\r\n');
}

// Self-contained function: its source is included in scripts copied into Zotero.
export async function zoteroApply(payload, apply, Z, promptConfirm) {
  function normalize(s) { return String(s||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' '); }
  const pane=Z.getActiveZoteroPane();
  const items=pane?.getSelectedItems().filter(item=>item.isRegularItem()) || [];
  if(!items.length) return '请先在 Zotero 主窗口选中要补全 DOI 的原文献，再运行脚本。';
  const report=[], plan=[], used=new Set();
  const doiField=Z.ItemFields.getID('DOI');
  for(const entry of payload) {
    const prefix=entry.title;
    if(!/^10\.\d{4,9}\/\S+$/i.test(entry.doi)) {report.push('跳过无效 DOI：'+prefix);continue;}
    let matches=items.filter(item=>normalize(item.getField('title'))===normalize(entry.title));
    if(entry.key) matches=matches.filter(item=>item.key===entry.key);
    else {
      // Without a stable Zotero item key, require two additional exact checks.
      if(!entry.year || !entry.author) {report.push('缺少条目标识、年份或作者，请手动粘贴：'+prefix);continue;}
      matches=matches.filter(item=>{
        const y=String(item.getField('date')||'').match(/\b(?:1[5-9]|20|21)\d{2}\b/)?.[0];
        const creator=item.getCreators()[0];
        return y===entry.year && normalize(creator?.lastName)===normalize(entry.author);
      });
    }
    if(matches.length!==1) {report.push((matches.length?'存在重复条目，未更改：':'未在所选条目中找到：')+prefix);continue;}
    const item=matches[0];
    if(used.has(item.id)) {report.push('输入中重复条目，未重复更改：'+prefix);continue;}
    if(!Z.ItemFields.isValidForType(doiField,item.itemTypeID)) {report.push('此条目类型无 DOI 字段，请手动处理：'+prefix);continue;}
    if(String(item.getField('DOI')||'').trim()) {report.push('已有 DOI，跳过：'+prefix);continue;}
    if(/^\s*DOI\s*:\s*\S+/im.test(String(item.getField('extra')||''))) {report.push('Extra 中已有 DOI，跳过：'+prefix);continue;}
    used.add(item.id);plan.push({item,entry});
  }
  const preview=plan.map(p=>p.entry.title+' → '+p.entry.doi);
  if(!apply || !plan.length) return ['预览：可补全 '+plan.length+' 条（尚未写入）。',...preview,...report].join('\n');
  if(!promptConfirm('即将为所选文献补全 '+plan.length+' 个空白 DOI。\n\n'+preview.slice(0,12).join('\n')+(plan.length>12?'\n……':''))) return '已取消，未写入任何 DOI。';
  let changed=0;
  await Z.DB.executeTransaction(async()=>{
    for(const {item,entry} of plan) {
      if(String(item.getField('DOI')||'').trim()) continue;
      item.setField('DOI',entry.doi);await item.save();changed++;
    }
  });
  return ['已补全 '+changed+' 个 DOI。',...preview,...report].join('\n');
}

export function makeZoteroScript(rows, apply=false) {
  const payload=confirmedRows(rows).map(r=>({title:r.raw.title,year:r.year,author:r.author,key:String(r.raw.id||'').match(/^https?:\/\/(?:www\.)?zotero\.org\/(?:users\/(?:local\/)?[^/]+|groups\/[^/]+)\/items\/([A-Z0-9]{8})$/i)?.[1]||'',doi:r.chosen.doi}));
  return '// DOI 补全工作台 · '+(apply?'确认后写入':'仅预览，不写入')+'\n// 在 Zotero 主窗口选中原文献；工具 → 开发者 → Run JavaScript。\n// 只处理所选条目的空白 DOI。运行前请备份 Zotero 数据。\nconst payload = '+JSON.stringify(payload,null,2)+';\nconst run = '+zoteroApply.toString()+';\nreturn await run(payload, '+apply+', Zotero, message => confirm(message));';
}
