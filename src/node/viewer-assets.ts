// Self-contained assets for the transcript viewer. Kept as plain strings with
// no template-literal interpolation so they embed verbatim into the page.

export const VIEWER_STYLES = `
:root{
  color-scheme:dark;
  --bg:#0a0c0f; --panel:#12161d; --panel2:#0f1319; --code:#0d1117;
  --line:#1e2530; --line2:#161c25; --chip:#181f29;
  --ink:#e7e9ee; --muted:#8a93a2; --faint:#59626f;
  --fn:#e0b06a; --user:#b3a4e6; --assistant:#4ec98a; --tool:#e0aa4d;
  --system:#c084fc; --child:#cf87e6; --error:#ff7a7a;
  --j-key:#c9a6f0; --j-str:#7fcf9a; --j-num:#e0aa6a; --j-bool:#e08aae; --j-null:#6b7484;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.6;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.mono,code,pre{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
details>summary{list-style:none}
details>summary::-webkit-details-marker{display:none}

header{position:sticky;top:0;z-index:6;background:var(--panel);border-bottom:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:12px;padding:13px 0}
.brand{font-weight:650;font-size:14.5px;letter-spacing:-.01em}
.pill{font-size:11.5px;color:var(--muted);background:var(--chip);border-radius:999px;padding:3px 10px}
.spacer{flex:1}
select{font:inherit;font-size:13px;color:var(--ink);background:var(--panel2);border:1px solid var(--line);
  border-radius:8px;padding:7px 30px 7px 11px;max-width:52vw;appearance:none;
  background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);
  background-position:calc(100% - 16px) 52%,calc(100% - 11px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.tabs{position:sticky;top:52px;z-index:5;background:var(--bg);border-bottom:1px solid var(--line)}
.tabsInner{display:flex;gap:2px}
.tab{appearance:none;border:0;background:none;cursor:pointer;font:inherit;font-size:13px;color:var(--muted);
  padding:12px 4px;margin-right:20px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--ink)}
.tab.active{color:var(--ink);font-weight:600;border-bottom-color:var(--ink)}
main{padding:22px 0 100px}
.reading{max-width:820px;margin:0 auto}

.note{color:var(--muted);font-size:12.5px;margin:0 0 20px}
.card{background:var(--panel2);border-radius:12px;padding:16px 18px;margin:0 0 14px}
.card h2{margin:0 0 12px;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.kv{display:grid;grid-template-columns:186px 1fr;gap:9px 18px;font-size:13.5px}
.kv .k{color:var(--muted)}
.kv .v{word-break:break-word}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px}
.stat{background:var(--panel);border-radius:10px;padding:13px 15px}
.stat .n{font-size:21px;font-weight:650;letter-spacing:-.02em}
.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:3px}
.stopchips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.stack{display:grid;gap:8px}

pre.block{background:var(--code);border-radius:9px;padding:12px 14px;overflow:auto;font-size:12.5px;line-height:1.6;margin:0;white-space:pre;max-height:420px}
pre.wrap{white-space:pre-wrap;word-break:break-word}
.j-key{color:var(--j-key)} .j-str{color:var(--j-str)} .j-num{color:var(--j-num)}
.j-bool{color:var(--j-bool)} .j-null{color:var(--j-null)}

.tbar{display:flex;gap:16px;margin:0 0 12px}
.tbtn{border:0;background:none;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;
  text-decoration:underline;text-underline-offset:2px;padding:0}
.tbtn:hover{color:var(--ink)}

.chev::before{content:"\\203A";color:var(--faint);font-size:12px;flex:0 0 auto;transition:transform .12s;display:inline-block}
details[open]>summary .chev::before{transform:rotate(90deg)}

details.msg{padding:15px 0}
.msg>summary{cursor:pointer;display:flex;align-items:center;gap:9px}
.rn{font-size:12.5px;font-weight:650;letter-spacing:.01em}
.rn.user{color:var(--user)} .rn.assistant{color:var(--assistant)} .rn.tool{color:var(--tool)} .rn.system{color:var(--system)}
.msg>summary .tele{margin-left:auto}
.tele{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--muted)}
.mb{margin-top:10px;padding-left:16px}
.mb>*+*{margin-top:10px}
.text{white-space:pre-wrap;word-break:break-word}
.md>*:first-child{margin-top:0}
.md>*:last-child{margin-bottom:0}
.md p{margin:0 0 9px}
.md .mdh{font-weight:650;margin:14px 0 7px;line-height:1.3}
.md .mdh1,.md .mdh2{font-size:16px} .md .mdh3{font-size:15px} .md .mdh4{font-size:14px}
.md .mdh5,.md .mdh6{font-size:13px;color:var(--muted);text-transform:none}
.md ul,.md ol{margin:0 0 9px;padding-left:22px}
.md li{margin:3px 0}
.md li>ul,.md li>ol{margin:3px 0}
.md code{font-family:ui-monospace,monospace;font-size:12.5px;background:var(--chip);border-radius:5px;padding:1px 5px}
.md pre.code{margin:9px 0}
.md a{color:var(--fn);text-decoration:underline;text-underline-offset:2px}
.md blockquote{margin:9px 0;padding-left:12px;border-left:2px solid var(--line);color:var(--muted)}
.md strong{font-weight:650} .md em{font-style:italic}
.md hr{border:0;border-top:1px solid var(--line);margin:14px 0}

details.reason>summary{cursor:pointer;color:var(--muted);font-size:12px;display:inline-flex;align-items:center;gap:6px}
.reason .rtext{color:var(--muted);white-space:pre-wrap;margin-top:7px}

details.call{margin-top:12px}
.call>summary{cursor:pointer;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.cn{font-family:ui-monospace,monospace;font-weight:650;color:var(--fn);font-size:13px}
.args{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted)}
.rsum{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted)}
.rsum.err{color:var(--error)}
.rsum .arrow{color:var(--faint);margin-right:6px}
.mb2{padding-left:18px;margin-top:4px}
.mb2>*+*{margin-top:8px}
.arglabel{font-family:ui-monospace,monospace;font-size:11px;color:var(--faint);margin-bottom:-2px}
.code{font-family:ui-monospace,monospace;font-size:12px;line-height:1.55;background:var(--code);border-radius:9px;
  padding:11px 13px;overflow:auto;max-height:360px;white-space:pre}
details.codewrap>summary{cursor:pointer;color:var(--muted);font-family:ui-monospace,monospace;font-size:11.5px;
  display:flex;align-items:center;gap:8px}
.codewrap>pre.code{margin-top:6px}
.res{font-size:13px;color:var(--ink)}
.res.err{color:var(--error)}
.res .arrow{color:var(--faint);margin-right:8px;font-family:ui-monospace,monospace}
.res.err .arrow{color:var(--error)}
img.artifact{max-width:min(100%,360px);border-radius:10px;display:block}

.sub{padding-left:16px;margin:16px 0}
.sub .sh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--child);font-weight:650;font-size:13px}
.sub .sb{margin-top:6px;color:var(--ink)}
button.open{margin-left:auto;border:0;background:none;color:var(--child);font:inherit;font-size:12.5px;cursor:pointer;
  text-decoration:underline;text-underline-offset:2px;padding:0}
button.open:hover{opacity:.75}
button.back{border:0;background:none;color:var(--muted);font:inherit;font-size:12.5px;cursor:pointer;padding:0;
  margin:0 0 16px;text-decoration:underline;text-underline-offset:2px}
button.back:hover{color:var(--ink)}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);background:var(--chip);border-radius:6px;padding:2px 9px}
.chip.warn{color:var(--error);background:color-mix(in srgb,var(--error) 12%,transparent)}

.rawrow{margin:0 0 3px}
.rawrow>summary{list-style:none;padding:9px 6px;display:flex;align-items:center;gap:11px;cursor:pointer;font-size:13px;border-radius:8px}
.rawrow>summary:hover{background:var(--panel2)}
.rawrow .seq{font-family:ui-monospace,monospace;font-size:12px;color:var(--faint);min-width:34px}
.rawrow .type{font-weight:500}
.rawrow .cat{margin-left:auto;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint)}
.rawrow pre.block{margin:4px 6px 8px}
.empty{color:var(--muted);text-align:center;padding:60px 0}
`;

export const VIEWER_CLIENT_JS = [
  "(function(){",
  "var DATA = JSON.parse(document.getElementById('viewer-data').textContent);",
  "var state = { session: DATA.rootSessionId, tab: 'overview' };",
  "var app = document.getElementById('app');",
  "",
  "function el(tag, opts, kids){ var n=document.createElement(tag);",
  "  if(opts){ for(var k in opts){",
  "    if(k==='class') n.className=opts[k]; else if(k==='text') n.textContent=opts[k];",
  "    else if(k==='html') n.innerHTML=opts[k];",
  "    else if(k==='on'){ for(var ev in opts[k]) n.addEventListener(ev, opts[k][ev]); }",
  "    else n.setAttribute(k, opts[k]); } }",
  "  if(kids){ for(var i=0;i<kids.length;i++){ var c=kids[i]; if(c==null) continue;",
  "    n.appendChild(typeof c==='string'?document.createTextNode(c):c); } } return n; }",
  "function rec(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; }",
  "function num(n){ return (n==null?0:n).toLocaleString(); }",
  "function cap(s){ s=String(s||''); return s.charAt(0).toUpperCase()+s.slice(1); }",
  "function money(n){ if(!n) return '$0'; return '$'+Number(n).toFixed(6).replace(/0+$/,'').replace(/\\.$/,''); }",
  "function time(s){ if(!s) return ''; var d=new Date(s); return isNaN(d)?s:d.toLocaleString(); }",
  "function short(s){ s=String(s||''); return s.length>22? s.slice(0,12)+'\\u2026'+s.slice(-5):s; }",
  "function esc(s){ s=String(s); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }",
  "function chev(){ return el('span',{class:'chev'}); }",
  "function mdInline(s){ var codes=[];",
  "  s=s.replace(/`([^`]+)`/g, function(_,c){ codes.push(c); return '\\u0000'+(codes.length-1)+'\\u0000'; });",
  "  s=s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function(_,t,u){ return /^(https?:|mailto:)/i.test(u)? '<a href=\"'+u+'\" target=\"_blank\" rel=\"noopener noreferrer\">'+t+'</a>' : t; });",
  "  s=s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>');",
  "  s=s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g,'$1<em>$2</em>');",
  "  s=s.replace(/\\u0000(\\d+)\\u0000/g, function(_,i){ return '<code>'+codes[i]+'</code>'; });",
  "  return s; }",
  "function md(src){ var lines=String(src).replace(/\\r\\n/g,'\\n').split('\\n'); var out=[]; var i=0; var para=[];",
  "  function flushP(){ if(para.length){ out.push('<p>'+mdInline(para.join(' '))+'</p>'); para=[]; } }",
  "  while(i<lines.length){ var ln=lines[i];",
  "    if(/^```/.test(ln)){ flushP(); i++; var buf=[]; while(i<lines.length && !/^```/.test(lines[i])){ buf.push(lines[i]); i++; } i++; out.push('<pre class=\"code\">'+esc(buf.join('\\n'))+'</pre>'); continue; }",
  "    if(/^\\s*$/.test(ln)){ flushP(); i++; continue; }",
  "    var h=ln.match(/^(#{1,6})\\s+(.*)$/); if(h){ flushP(); var lvl=h[1].length>6?6:h[1].length; out.push('<div class=\"mdh mdh'+lvl+'\">'+mdInline(esc(h[2]))+'</div>'); i++; continue; }",
  "    if(/^\\s*([-*+]|\\d+\\.)\\s+/.test(ln)){ flushP(); var ordered=/^\\s*\\d+\\./.test(ln); var items=[];",
  "      while(i<lines.length && /^\\s*([-*+]|\\d+\\.)\\s+/.test(lines[i])){ items.push('<li>'+mdInline(esc(lines[i].replace(/^\\s*([-*+]|\\d+\\.)\\s+/,'')))+'</li>'); i++; }",
  "      out.push('<'+(ordered?'ol':'ul')+'>'+items.join('')+'</'+(ordered?'ol':'ul')+'>'); continue; }",
  "    if(/^\\s*>\\s?/.test(ln)){ flushP(); var q=[]; while(i<lines.length && /^\\s*>\\s?/.test(lines[i])){ q.push(lines[i].replace(/^\\s*>\\s?/,'')); i++; } out.push('<blockquote>'+mdInline(esc(q.join(' ')))+'</blockquote>'); continue; }",
  "    if(/^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\1]*$/.test(ln)){ flushP(); out.push('<hr>'); i++; continue; }",
  "    para.push(esc(ln)); i++; }",
  "  flushP(); return out.join(''); }",
  "function hl(v, ind){ ind=ind||'';",
  "  if(v===null||v===undefined) return '<span class=\"j-null\">null</span>';",
  "  var t=typeof v;",
  "  if(t==='number') return '<span class=\"j-num\">'+esc(v)+'</span>';",
  "  if(t==='boolean') return '<span class=\"j-bool\">'+v+'</span>';",
  "  if(t==='string') return '<span class=\"j-str\">\"'+esc(v)+'\"</span>';",
  "  if(Array.isArray(v)){ if(!v.length) return '[]'; var pi=ind+'  '; var it=[];",
  "    for(var i=0;i<v.length;i++) it.push(pi+hl(v[i],pi)); return '[\\n'+it.join(',\\n')+'\\n'+ind+']'; }",
  "  var ks=Object.keys(v); if(!ks.length) return '{}'; var p=ind+'  '; var rows=[];",
  "  for(var j=0;j<ks.length;j++) rows.push(p+'<span class=\"j-key\">\"'+esc(ks[j])+'\"</span>: '+hl(v[ks[j]],p));",
  "  return '{\\n'+rows.join(',\\n')+'\\n'+ind+'}'; }",
  "",
  "function sessionOrder(){ var out=[],seen={};",
  "  function walk(id,d){ if(seen[id]||!DATA.sessions[id]) return; seen[id]=1; out.push({id:id,depth:d});",
  "    var ch=DATA.sessions[id].childIds||[]; for(var i=0;i<ch.length;i++) walk(ch[i],d+1); }",
  "  walk(DATA.rootSessionId,0); for(var k in DATA.sessions) if(!seen[k]) walk(k,0); return out; }",
  "function label(id){ var s=DATA.sessions[id]; var p=s&&s.descriptor&&s.descriptor.purpose; return p?p:id; }",
  "function turnTelemetry(session){ var m={}; for(var i=0;i<session.events.length;i++){ var e=session.events[i];",
  "  if(e.type==='model.call.completed'&&e.turnId) m[e.turnId]=rec(e.data); } return m; }",
  "",
  "function header(){ var sel=el('select',{on:{change:function(ev){ state.session=ev.target.value; render(); }}});",
  "  var order=sessionOrder();",
  "  for(var i=0;i<order.length;i++){ var o=order[i]; var pre=o.depth?(Array(o.depth+1).join('\\u2014 ')):'';",
  "    var opt=el('option',{value:o.id,text:pre+label(o.id)}); if(o.id===state.session) opt.setAttribute('selected','selected'); sel.appendChild(opt); }",
  "  var n=Object.keys(DATA.sessions).length;",
  "  var bar=el('div',{class:'bar'},[ el('span',{class:'brand',text:'Harness transcript'}),",
  "    el('span',{class:'pill',text:n+' session'+(n>1?'s':'')}), el('span',{class:'spacer'}), sel ]);",
  "  return el('header',null,[ el('div',{class:'wrap'},[bar]) ]); }",
  "function tabs(){ var names=[['overview','Overview'],['transcript','Transcript'],['raw','Raw']];",
  "  var inner=el('div',{class:'tabsInner'});",
  "  for(var i=0;i<names.length;i++){ (function(key,text){ inner.appendChild(el('button',{class:'tab'+(state.tab===key?' active':''),text:text,on:{click:function(){ state.tab=key; render(); }}})); })(names[i][0],names[i][1]); }",
  "  return el('div',{class:'tabs'},[ el('div',{class:'wrap'},[inner]) ]); }",
  "",
  "function codeNode(text, lbl){ text=String(text); var lines=text.split('\\n').length;",
  "  if(text.length<=1400 && lines<=30) return el('pre',{class:'code',text:text});",
  "  return el('details',{class:'codewrap'},[ el('summary',null,[ chev(), el('span',{text:(lbl||'content')+'  \\u00b7  '+lines+' lines'}) ]), el('pre',{class:'code',text:text}) ]); }",
  "function splitArgs(input){ var scal=[],blk=[];",
  "  if(input&&typeof input==='object'&&!Array.isArray(input)){ for(var k in input){ var v=input[k];",
  "    if(typeof v==='string'&&(v.indexOf('\\n')>=0||v.length>96)) blk.push([k,v]); else scal.push([k, typeof v==='string'?v:JSON.stringify(v)]); } }",
  "  else if(input!=null){ blk.push([null, JSON.stringify(input,null,2)]); } return {scal:scal, blk:blk}; }",
  "function shortResultText(result){ var c=Array.isArray(result.content)?result.content:[];",
  "  if(c.some(function(b){return b&&b.type!=='text';})) return null;",
  "  var ts=c.filter(function(b){return b&&b.type==='text';}); if(ts.length!==1) return null;",
  "  var t=ts[0].text||''; return (t.indexOf('\\n')<0 && t.length<=64)? t : null; }",
  "function resultBody(result, skipShort){ var out=[]; var c=Array.isArray(result.content)?result.content:[];",
  "  for(var i=0;i<c.length;i++){ var b=c[i]; if(!b) continue;",
  "    if(b.type==='text'){ if(skipShort) continue; var t=b.text||''; if(t.indexOf('\\n')>=0||t.length>140) out.push(codeNode(t,'output')); else out.push(el('div',{class:'res'+(result.isError?' err':'')},[ el('span',{class:'arrow',text:'\\u21B3'}), el('span',{text:t}) ])); }",
  "    else if(b.type==='image'){ var u=DATA.images[(b.artifact&&b.artifact.sha256)||'']; out.push(u?el('img',{class:'artifact',src:u}):el('span',{class:'chip',text:'image '+short(b.artifact&&b.artifact.sha256)})); }",
  "    else out.push(el('span',{class:'chip',text:b.type})); } return out; }",
  "function renderCall(call, result, mark){ var isErr=result&&result.isError;",
  "  var det=el('details',{class:'call',open:'open'});",
  "  var sum=el('summary',null,[ chev(), el('span',{class:'cn',text:call.name||'tool'}) ]);",
  "  var sa=splitArgs(call.input);",
  "  if(sa.scal.length){ var ps=[]; for(var i=0;i<sa.scal.length;i++) ps.push(sa.scal[i][0]+': '+sa.scal[i][1]); sum.appendChild(el('span',{class:'args',text:ps.join('   ')})); }",
  "  var inline=null;",
  "  if(result){ if(mark) mark(result.toolCallId); inline=shortResultText(result);",
  "    sum.appendChild(el('span',{class:'rsum'+(isErr?' err':'')},[ el('span',{class:'arrow',text:'\\u21B3'}), el('span',{text: inline!=null?inline:(isErr?'error':'ok')}) ])); }",
  "  det.appendChild(sum);",
  "  var body=el('div',{class:'mb2'});",
  "  for(var b=0;b<sa.blk.length;b++){ if(sa.blk[b][0]) body.appendChild(el('div',{class:'arglabel',text:sa.blk[b][0]})); body.appendChild(codeNode(sa.blk[b][1], sa.blk[b][0]||'content')); }",
  "  if(result){ var rb=resultBody(result, inline!=null); for(var r=0;r<rb.length;r++) body.appendChild(rb[r]); }",
  "  if(body.children.length) det.appendChild(body);",
  "  return det; }",
  "",
  "function contentBlocks(blocks){ var out=[]; if(!Array.isArray(blocks)) return out;",
  "  for(var i=0;i<blocks.length;i++){ var b=blocks[i]; if(!b) continue;",
  "    if(b.type==='text'){ out.push(el('div',{class:'md',html:md(b.text||'')})); }",
  "    else if(b.type==='image'){ var u=DATA.images[(b.artifact&&b.artifact.sha256)||''];",
  "      out.push(u? el('img',{class:'artifact',src:u}) : el('span',{class:'chip',text:'image '+short(b.artifact&&b.artifact.sha256)})); }",
  "    else if(b.type==='reasoning'){ out.push(el('details',{class:'reason'},[ el('summary',null,[chev(), el('span',{text:'Thinking'})]), el('div',{class:'rtext',text:b.text||''}) ])); }",
  "    else if(b.type==='provider'){ out.push(el('span',{class:'chip',text:'provider \\u00b7 '+(b.provider||'')+'/'+(b.providerType||'')})); }",
  "    else if(b.type==='file'){ out.push(el('span',{class:'chip',text:'file '+short(b.artifact&&b.artifact.sha256)})); }",
  "    else out.push(el('span',{class:'chip',text:'['+(b.type||'?')+']'})); } return out; }",
  "function telemetryChip(t){ if(!t) return null;",
  "  if(t.error) return el('span',{class:'chip warn',text:'\\u26A0 '+String(t.error).slice(0,80)});",
  "  var tl=t.telemetry||{}; var u=tl.usage||{};",
  "  var s=(tl.model||'')+'  '+num(u.inputTokens)+'\\u2192'+num(u.outputTokens)+' tok';",
  "  if(tl.costUsd) s+='  '+money(tl.costUsd); if(tl.latencyMs!=null) s+='  '+tl.latencyMs+'ms'; if(tl.stopReason) s+='  '+tl.stopReason;",
  "  return el('span',{class:'tele',text:s}); }",
  "",
  "function transcript(session){ var reading=el('div',{class:'reading'}); var tt=turnTelemetry(session);",
  "  function setAll(open){ var ds=reading.getElementsByTagName('details'); for(var i=0;i<ds.length;i++) ds[i].open=open; }",
  "  reading.appendChild(el('div',{class:'tbar'},[ el('button',{class:'tbtn',text:'Expand all',on:{click:function(){ setAll(true); }}}), el('button',{class:'tbtn',text:'Collapse all',on:{click:function(){ setAll(false); }}}) ]));",
  "  if(session.descriptor&&session.descriptor.parentSessionId) reading.appendChild(el('button',{class:'back',text:'\\u2190 back to parent',on:{click:function(){ state.session=session.descriptor.parentSessionId; render(); }}}));",
  "  var results={}; for(var i=0;i<session.events.length;i++){ var e=session.events[i]; if(e.type!=='message.appended') continue; var mm=rec(e.data).message; if(!mm||mm.role!=='tool'||!Array.isArray(mm.content)) continue;",
  "    for(var j=0;j<mm.content.length;j++){ var rb=mm.content[j]; if(rb&&rb.type==='tool_result') results[rb.toolCallId]=rb; } }",
  "  var used={}; function mark(id){ used[id]=1; } var any=false;",
  "  function msgDetails(role, chip, bodyNodes){ var det=el('details',{class:'msg',open:'open'});",
  "    var sum=el('summary',null,[ chev(), el('span',{class:'rn '+role,text: role==='tool'?'Tool':cap(role)}) ]); if(chip) sum.appendChild(chip);",
  "    det.appendChild(sum); det.appendChild(el('div',{class:'mb'}, bodyNodes)); return det; }",
  "  for(var i=0;i<session.events.length;i++){ var e=session.events[i]; var d=rec(e.data);",
  "    if(e.type==='message.appended'){ var msg=rec(d.message); var role=msg.role||'user';",
  "      if(role==='tool'){ var rem=(msg.content||[]).filter(function(b){ return !(b&&b.type==='tool_result'&&used[b.toolCallId]); }); if(!rem.length) continue; any=true; reading.appendChild(msgDetails('tool', null, contentBlocks(rem))); continue; }",
  "      any=true; var chip=(role==='assistant'&&e.turnId&&tt[e.turnId])? telemetryChip(tt[e.turnId]) : null;",
  "      var nodes=[]; var blocks=Array.isArray(msg.content)?msg.content:[];",
  "      for(var b=0;b<blocks.length;b++){ var bl=blocks[b]; if(bl&&bl.type==='tool_call') nodes.push(renderCall(bl, results[bl.id], mark)); else { var cn=contentBlocks([bl]); for(var k=0;k<cn.length;k++) nodes.push(cn[k]); } }",
  "      reading.appendChild(msgDetails(role, chip, nodes)); }",
  "    else if(e.type==='child.started'){ var cid=d.childSessionId;",
  "      var cp=(DATA.sessions[cid]&&DATA.sessions[cid].descriptor&&DATA.sessions[cid].descriptor.purpose)||d.purpose||cid;",
  "      var sh=el('div',{class:'sh'},[ el('span',{text:'\\u2197 sub-agent'}), el('span',{text:cp}) ]);",
  "      if(DATA.sessions[cid]) sh.appendChild(el('button',{class:'open',text:'open transcript',on:{click:(function(id){return function(){ state.session=id; state.tab='transcript'; render(); };})(cid)}}));",
  "      reading.appendChild(el('div',{class:'sub'},[sh])); }",
  "    else if(e.type==='child.completed'){ var r=rec(d.result);",
  "      var sh2=el('div',{class:'sh'}); sh2.appendChild(el('span',{text:'\\u2713 sub-agent returned'}));",
  "      if(r.confidence!=null) sh2.appendChild(el('span',{class:'chip',text:'confidence '+r.confidence}));",
  "      if(r.childSessionId&&DATA.sessions[r.childSessionId]) sh2.appendChild(el('button',{class:'open',text:'open transcript',on:{click:(function(id){return function(){ state.session=id; state.tab='transcript'; render(); };})(r.childSessionId)}}));",
  "      reading.appendChild(el('div',{class:'sub'},[ sh2, el('div',{class:'sb text',text:r.conclusion||'(no conclusion)'}) ])); } }",
  "  if(!any) reading.appendChild(el('div',{class:'empty',text:'No messages in this session.'}));",
  "  return reading; }",
  "",
  "function kv(k,v){ return [el('div',{class:'k',text:k}), el('div',{class:'v',text:v})]; }",
  "function overview(session){ var wrap=el('div'); var cfg=session.config; var desc=session.descriptor||{};",
  "  wrap.appendChild(el('p',{class:'note',text:DATA.generatedNote}));",
  "  var sr=kv('Session id', session.id);",
  "  if(desc.purpose) sr=sr.concat(kv('Purpose', desc.purpose));",
  "  if(desc.createdAt) sr=sr.concat(kv('Created', time(desc.createdAt)));",
  "  if(desc.parentSessionId) sr=sr.concat(kv('Parent session', desc.parentSessionId));",
  "  wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Session'}), el('div',{class:'kv'},sr) ]));",
  "  if(cfg){ var mr=kv('Provider', (cfg.provider&&cfg.provider.provider)||'');",
  "    mr=mr.concat(kv('Model', (cfg.provider&&cfg.provider.model)||''));",
  "    if(cfg.provider&&cfg.provider.endpoint) mr=mr.concat(kv('Endpoint', cfg.provider.endpoint));",
  "    mr=mr.concat(kv('Config', cfg.id+' \\u00b7 v'+cfg.version));",
  "    if(cfg.temperature!=null) mr=mr.concat(kv('Temperature', String(cfg.temperature)));",
  "    if(cfg.maxOutputTokens!=null) mr=mr.concat(kv('Max output tokens', String(cfg.maxOutputTokens)));",
  "    wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Model configuration'}), el('div',{class:'kv'},mr) ]));",
  "    if(cfg.systemPrompt) wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'System prompt \\u00b7 agent instructions'}), el('pre',{class:'block wrap',text:cfg.systemPrompt}) ]));",
  "    if(cfg.tools&&cfg.tools.length){ var tls=el('div',{class:'stack'});",
  "      for(var i=0;i<cfg.tools.length;i++){ var t=cfg.tools[i]; tls.appendChild(el('details',{class:'call'},[ el('summary',null,[ chev(), el('span',{class:'cn',text:t.name}), el('span',{class:'args',text:t.description||''}) ]), el('div',{class:'mb2'},[ el('pre',{class:'code',html:hl(t.inputSchema)}) ]) ])); }",
  "      wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Tools \\u00b7 '+cfg.tools.length}), tls ])); } }",
  "  else wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Model configuration'}), el('div',{class:'note',text:'Config not available.'}) ]));",
  "  var fu=null; for(var i=0;i<session.events.length;i++){ var e=session.events[i]; if(e.type==='message.appended'){ var m=rec(e.data).message; if(m&&m.role==='user'){ fu=m; break; } } }",
  "  if(fu) wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Initial user prompt'}), el('div',null, contentBlocks(fu.content)) ]));",
  "  var s=session.telemetry||{}; var stat=el('div',{class:'stats'});",
  "  function add(n,l){ stat.appendChild(el('div',{class:'stat'},[ el('div',{class:'n',text:n}), el('div',{class:'l',text:l}) ])); }",
  "  add(num(s.modelCalls),'model calls'); add(num(s.actionCalls),'tool calls');",
  "  add(num(s.inputTokens),'input tokens'); add(num(s.outputTokens),'output tokens');",
  "  add(money(s.costUsd),'cost'); add(num(s.actionFailures),'tool failures');",
  "  if(s.reasoningTokens) add(num(s.reasoningTokens),'reasoning tok'); if(s.cacheReadTokens) add(num(s.cacheReadTokens),'cache read tok');",
  "  var tc=el('div',{class:'card'},[ el('h2',{text:'Telemetry \\u00b7 this session'}), stat ]);",
  "  var stops=s.stopReasons||{}; var sk=Object.keys(stops);",
  "  if(sk.length){ var sc=el('div',{class:'stopchips'}); for(var i=0;i<sk.length;i++) sc.appendChild(el('span',{class:'chip',text:sk[i]+': '+stops[sk[i]]})); tc.appendChild(sc); }",
  "  wrap.appendChild(tc);",
  "  var outcome=null; for(var i=session.events.length-1;i>=0;i--){ if(session.events[i].type==='run.completed'){ outcome=rec(session.events[i].data).outcome; break; } }",
  "  if(outcome) wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Outcome'}), el('pre',{class:'block',html:hl(outcome)}) ]));",
  "  if(session.childIds&&session.childIds.length){ var list=el('div',{class:'stack'});",
  "    for(var i=0;i<session.childIds.length;i++){ (function(id){ var sh=el('div',{class:'sh'},[ el('span',{text:'\\u2197'}), el('span',{text:label(id)}) ]);",
  "      if(DATA.sessions[id]) sh.appendChild(el('button',{class:'open',text:'open',on:{click:function(){ state.session=id; state.tab='transcript'; render(); }}})); else sh.appendChild(el('span',{class:'chip',text:'not captured'}));",
  "      list.appendChild(el('div',{class:'sub'},[sh])); })(session.childIds[i]); }",
  "    wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Sub-agents \\u00b7 '+session.childIds.length}), list ])); }",
  "  return wrap; }",
  "",
  "function raw(session){ var wrap=el('div');",
  "  for(var i=0;i<session.events.length;i++){ var e=session.events[i];",
  "    wrap.appendChild(el('details',{class:'rawrow'},[",
  "      el('summary',null,[ el('span',{class:'seq',text:'#'+e.sequence}), el('span',{class:'type',text:e.type}), el('span',{class:'cat',text:e.category}) ]),",
  "      el('pre',{class:'block',html:hl(e)}) ])); }",
  "  return wrap; }",
  "",
  "function render(){ var session=DATA.sessions[state.session]; app.innerHTML='';",
  "  app.appendChild(header()); app.appendChild(tabs()); var inner=el('div',{class:'wrap'});",
  "  if(!session) inner.appendChild(el('div',{class:'empty',text:'Session not found.'}));",
  "  else if(state.tab==='overview') inner.appendChild(overview(session));",
  "  else if(state.tab==='transcript') inner.appendChild(transcript(session));",
  "  else inner.appendChild(raw(session));",
  "  app.appendChild(el('main',null,[inner])); window.scrollTo(0,0); }",
  "render();",
  "})();",
].join("\n");
