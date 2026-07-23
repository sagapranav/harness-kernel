// Self-contained assets for the transcript viewer. Kept as plain strings with
// no template-literal interpolation so they embed verbatim into the page.

export const VIEWER_STYLES = `
:root{
  --bg:#f7f8fa; --panel:#ffffff; --ink:#1b1f24; --muted:#6b7280; --line:#e4e7ec;
  --accent:#2563eb; --user:#2563eb; --assistant:#0f9d58; --tool:#b45309;
  --system:#7c3aed; --child:#db2777; --error:#dc2626; --code:#f3f4f6;
  --chip:#eef2f7;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1116; --panel:#161a21; --ink:#e6e8eb; --muted:#9aa4b2; --line:#262c36;
    --accent:#60a5fa; --user:#60a5fa; --assistant:#4ade80; --tool:#fbbf24;
    --system:#c084fc; --child:#f472b6; --error:#f87171; --code:#11151b;
    --chip:#1c222b;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;z-index:5;background:var(--panel);
  border-bottom:1px solid var(--line);padding:10px 20px;
  display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header .title{font-weight:600;font-size:15px}
header .spacer{flex:1}
select{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);color:var(--ink);max-width:60vw}
.tabs{display:flex;gap:4px;padding:0 20px;background:var(--panel);
  border-bottom:1px solid var(--line);position:sticky;top:53px;z-index:4}
.tab{padding:10px 14px;border:0;background:none;color:var(--muted);cursor:pointer;
  font:inherit;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab.active{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
main{max-width:960px;margin:0 auto;padding:22px 20px 80px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:16px 18px;margin:0 0 16px}
.card h2{margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);font-weight:600}
.kv{display:grid;grid-template-columns:170px 1fr;gap:6px 14px}
.kv .k{color:var(--muted)}
.kv .v{word-break:break-word}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.stat{background:var(--chip);border-radius:8px;padding:10px 12px}
.stat .n{font-size:18px;font-weight:600}
.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
pre.block{background:var(--code);border:1px solid var(--line);border-radius:8px;
  padding:12px 14px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:8px 0 0}
pre.json{white-space:pre;max-height:460px}
.msg{display:flex;gap:12px;margin:0 0 14px}
.msg .rail{width:4px;border-radius:3px;flex:0 0 auto;background:var(--muted)}
.msg.user .rail{background:var(--user)} .msg.assistant .rail{background:var(--assistant)}
.msg.tool .rail{background:var(--tool)} .msg.system .rail{background:var(--system)}
.msg .body{flex:1;min-width:0}
.msg .role{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  font-weight:600;margin-bottom:4px;display:flex;gap:8px;align-items:center}
.text{white-space:pre-wrap;word-break:break-word}
.subcard{border:1px solid var(--line);border-radius:8px;margin:8px 0 0;overflow:hidden}
.subcard .h{background:var(--chip);padding:6px 10px;font-size:12px;font-weight:600;
  display:flex;gap:8px;align-items:center}
.subcard .c{padding:10px}
.subcard.err .h{color:var(--error)}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--chip);
  border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted)}
.chip.tokens{font-family:ui-monospace,monospace}
img.artifact{max-width:340px;max-height:260px;border-radius:8px;border:1px solid var(--line);
  display:block;margin:8px 0 0}
details{margin:8px 0 0}
summary{cursor:pointer;color:var(--muted);font-size:12px}
.subagent{border:1px dashed var(--child);border-radius:10px;padding:12px 14px;margin:0 0 14px;
  background:color-mix(in srgb,var(--child) 6%,var(--panel))}
.subagent .h{color:var(--child);font-weight:600;font-size:13px;display:flex;gap:8px;
  align-items:center;flex-wrap:wrap}
button.link{border:1px solid var(--child);color:var(--child);background:none;border-radius:7px;
  padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
button.back{border:1px solid var(--line);color:var(--ink);background:var(--panel);
  border-radius:7px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.note{color:var(--muted);font-size:12px;margin:0 0 16px}
.rawrow{border:1px solid var(--line);border-radius:8px;margin:0 0 8px;overflow:hidden;
  background:var(--panel)}
.rawrow summary{padding:8px 12px;display:flex;gap:10px;align-items:center;color:var(--ink)}
.rawrow .seq{color:var(--muted);font-family:ui-monospace,monospace}
.rawrow .cat{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--chip);
  color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.rawrow pre{margin:0;border-top:1px solid var(--line);border-radius:0}
.empty{color:var(--muted);padding:40px 0;text-align:center}
`;

export const VIEWER_CLIENT_JS = [
  "(function(){",
  "var DATA = JSON.parse(document.getElementById('viewer-data').textContent);",
  "var state = { session: DATA.rootSessionId, tab: 'overview' };",
  "var app = document.getElementById('app');",
  "",
  "function el(tag, opts, kids){",
  "  var n = document.createElement(tag);",
  "  if(opts){ for(var k in opts){",
  "    if(k==='class') n.className=opts[k];",
  "    else if(k==='text') n.textContent=opts[k];",
  "    else if(k==='html') n.innerHTML=opts[k];",
  "    else if(k==='on') { for(var ev in opts[k]) n.addEventListener(ev, opts[k][ev]); }",
  "    else n.setAttribute(k, opts[k]);",
  "  } }",
  "  if(kids){ for(var i=0;i<kids.length;i++){ var c=kids[i]; if(c==null) continue;",
  "    n.appendChild(typeof c==='string'?document.createTextNode(c):c); } }",
  "  return n;",
  "}",
  "function rec(v){ return (v && typeof v==='object' && !Array.isArray(v)) ? v : {}; }",
  "function num(n){ return (n==null?0:n).toLocaleString(); }",
  "function money(n){ if(!n) return '$0'; return '$'+Number(n).toFixed(6).replace(/0+$/,'').replace(/\\.$/,''); }",
  "function time(s){ if(!s) return ''; var d=new Date(s); return isNaN(d)?s:d.toLocaleString(); }",
  "function short(s){ return s? (s.length>18? s.slice(0,10)+'…'+s.slice(-4):s):''; }",
  "",
  "function sessionOrder(){",
  "  var out=[], seen={};",
  "  function walk(id, depth){ if(seen[id]||!DATA.sessions[id]) return; seen[id]=1;",
  "    out.push({id:id, depth:depth}); var ch=DATA.sessions[id].childIds||[];",
  "    for(var i=0;i<ch.length;i++) walk(ch[i], depth+1); }",
  "  walk(DATA.rootSessionId, 0);",
  "  for(var k in DATA.sessions) if(!seen[k]) walk(k,0);",
  "  return out;",
  "}",
  "function label(id){ var s=DATA.sessions[id]; var p=s&&s.descriptor&&s.descriptor.purpose;",
  "  return (p? p : id); }",
  "",
  "function turnTelemetry(session){ var m={};",
  "  for(var i=0;i<session.events.length;i++){ var e=session.events[i];",
  "    if(e.type==='model.call.completed' && e.turnId) m[e.turnId]=rec(e.data); }",
  "  return m; }",
  "",
  "function header(){",
  "  var sel = el('select',{on:{change:function(ev){ state.session=ev.target.value; state.tab=state.tab; render(); }}});",
  "  var order=sessionOrder();",
  "  for(var i=0;i<order.length;i++){ var o=order[i];",
  "    var pre = o.depth? (Array(o.depth+1).join('— ')) : '';",
  "    var opt = el('option',{value:o.id,text:pre+label(o.id)+(o.depth? '' : ' (root)')});",
  "    if(o.id===state.session) opt.setAttribute('selected','selected');",
  "    sel.appendChild(opt); }",
  "  return el('header',null,[",
  "    el('div',{class:'title',text:'Harness transcript'}),",
  "    el('span',{class:'chip',text: (Object.keys(DATA.sessions).length)+' session'+(Object.keys(DATA.sessions).length>1?'s':'')}),",
  "    el('div',{class:'spacer'}), sel ]);",
  "}",
  "function tabs(){ var names=[['overview','Overview'],['transcript','Transcript'],['raw','Raw']];",
  "  var bar=el('div',{class:'tabs'});",
  "  for(var i=0;i<names.length;i++){ (function(key,text){",
  "    bar.appendChild(el('button',{class:'tab'+(state.tab===key?' active':''),text:text,",
  "      on:{click:function(){ state.tab=key; render(); }}})); })(names[i][0],names[i][1]); }",
  "  return bar; }",
  "",
  "function contentBlocks(blocks){ var out=[]; if(!Array.isArray(blocks)) return out;",
  "  for(var i=0;i<blocks.length;i++){ var b=blocks[i]; if(!b) continue;",
  "    if(b.type==='text'){ out.push(el('div',{class:'text',text:b.text||''})); }",
  "    else if(b.type==='tool_call'){",
  "      out.push(el('div',{class:'subcard'},[",
  "        el('div',{class:'h'},['\\uD83D\\uDD27 ', el('span',{text:b.name||'tool'}), el('span',{class:'chip',text:short(b.id)})]),",
  "        el('div',{class:'c'},[ el('pre',{class:'block mono',text:JSON.stringify(b.input,null,2)}) ]) ])); }",
  "    else if(b.type==='tool_result'){",
  "      out.push(el('div',{class:'subcard'+(b.isError?' err':'')},[",
  "        el('div',{class:'h'},[(b.isError?'\\u26A0 result (error) ':'\\u21A9 result '), el('span',{class:'chip',text:short(b.toolCallId)})]),",
  "        el('div',{class:'c'}, contentBlocks(b.content)) ])); }",
  "    else if(b.type==='image'){",
  "      var sha=(b.artifact&&b.artifact.sha256)||''; var url=DATA.images[sha];",
  "      if(url){ out.push(el('img',{class:'artifact',src:url,alt:(b.alt||'image')})); }",
  "      else { out.push(el('div',{class:'chip',text:'\\uD83D\\uDDBC image '+short(sha)+' ('+num(b.artifact&&b.artifact.bytes)+' B '+((b.artifact&&b.artifact.mediaType)||'')+')'})); } }",
  "    else if(b.type==='file'){ var f=b.artifact||{};",
  "      out.push(el('div',{class:'chip',text:'\\uD83D\\uDCCE file '+short(f.sha256)+' ('+num(f.bytes)+' B '+(f.mediaType||'')+')'})); }",
  "    else if(b.type==='reasoning'){",
  "      out.push(el('details',null,[ el('summary',{text:'reasoning'+(b.redacted?' (redacted)':'')}), el('div',{class:'text',text:b.text||''}) ])); }",
  "    else if(b.type==='provider'){",
  "      out.push(el('div',{class:'chip',text:'provider block: '+(b.provider||'')+'/'+(b.providerType||'')})); }",
  "    else { out.push(el('div',{class:'chip',text:'['+(b.type||'unknown')+' block]'})); } }",
  "  return out; }",
  "",
  "function telemetryChip(t){ if(!t) return null; var u=(t.telemetry&&t.telemetry.usage)||{};",
  "  if(t.error){ return el('span',{class:'chip',text:'\\u26A0 '+String(t.error).slice(0,80)}); }",
  "  var tl=t.telemetry||{};",
  "  var s=(tl.model||'')+'  '+num(u.inputTokens)+'\\u2192'+num(u.outputTokens)+' tok';",
  "  if(tl.costUsd) s+='  '+money(tl.costUsd); if(tl.latencyMs!=null) s+='  '+tl.latencyMs+'ms';",
  "  if(tl.stopReason) s+='  '+tl.stopReason;",
  "  return el('span',{class:'chip tokens',text:s}); }",
  "",
  "function transcript(session){ var wrap=el('div'); var tt=turnTelemetry(session); var any=false;",
  "  if(session.descriptor && session.descriptor.parentSessionId){",
  "    wrap.appendChild(el('button',{class:'back',text:'\\u2191 back to parent',",
  "      on:{click:function(){ state.session=session.descriptor.parentSessionId; render(); }}})); }",
  "  for(var i=0;i<session.events.length;i++){ var e=session.events[i]; var d=rec(e.data);",
  "    if(e.type==='message.appended'){ any=true; var msg=rec(d.message); var role=msg.role||'user';",
  "      var roleRow=[el('span',{text:role})];",
  "      if(role==='assistant' && e.turnId && tt[e.turnId]){ var chip=telemetryChip(tt[e.turnId]); if(chip) roleRow.push(chip); }",
  "      if(role==='tool' && msg.metadata && msg.metadata.status){ roleRow.push(el('span',{class:'chip',text:msg.metadata.status})); }",
  "      wrap.appendChild(el('div',{class:'msg '+role},[ el('div',{class:'rail'}),",
  "        el('div',{class:'body'},[ el('div',{class:'role'},roleRow) ].concat(contentBlocks(msg.content))) ])); }",
  "    else if(e.type==='child.started'){ var cid=d.childSessionId;",
  "      var childPurpose=(DATA.sessions[cid]&&DATA.sessions[cid].descriptor&&DATA.sessions[cid].descriptor.purpose)||(d.purpose)||cid;",
  "      var row=el('div',{class:'subagent'},[ el('div',{class:'h'},['\\u2197 sub-agent  ', el('span',{text:childPurpose})]) ]);",
  "      if(DATA.sessions[cid]){ row.querySelector('.h').appendChild(",
  "        el('button',{class:'link',text:'open transcript',on:{click:(function(id){return function(){ state.session=id; state.tab='transcript'; render(); };})(cid)}})); }",
  "      wrap.appendChild(row); }",
  "    else if(e.type==='child.completed'){ var r=rec(d.result);",
  "      var chead=[el('span',{text:'\\u2714 sub-agent returned'}), (r.noneFound?el('span',{class:'chip',text:'none found'}):null), (r.confidence!=null?el('span',{class:'chip',text:'confidence '+r.confidence}):null)];",
  "      if(r.childSessionId && DATA.sessions[r.childSessionId]){ chead.push(el('button',{class:'link',text:'open transcript',on:{click:(function(id){return function(){ state.session=id; state.tab='transcript'; render(); };})(r.childSessionId)}})); }",
  "      wrap.appendChild(el('div',{class:'subagent'},[ el('div',{class:'h'},chead), el('div',{class:'text',text:r.conclusion||'(no conclusion)'}) ])); } }",
  "  if(!any) wrap.appendChild(el('div',{class:'empty',text:'No messages in this session.'}));",
  "  return wrap; }",
  "",
  "function kv(k,v){ return [el('div',{class:'k',text:k}), el('div',{class:'v',text:v})]; }",
  "function overview(session){ var wrap=el('div'); var cfg=session.config; var desc=session.descriptor||{};",
  "  wrap.appendChild(el('p',{class:'note',text:DATA.generatedNote}));",
  "  var sessRows=[]; ",
  "  sessRows=sessRows.concat(kv('Session id', session.id));",
  "  if(desc.purpose) sessRows=sessRows.concat(kv('Purpose', desc.purpose));",
  "  if(desc.createdAt) sessRows=sessRows.concat(kv('Created', time(desc.createdAt)));",
  "  if(desc.parentSessionId) sessRows=sessRows.concat(kv('Parent session', desc.parentSessionId));",
  "  wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Session'}), el('div',{class:'kv'},sessRows) ]));",
  "  if(cfg){ var mr=[]; mr=mr.concat(kv('Provider', (cfg.provider&&cfg.provider.provider)||''));",
  "    mr=mr.concat(kv('Model', (cfg.provider&&cfg.provider.model)||''));",
  "    if(cfg.provider&&cfg.provider.endpoint) mr=mr.concat(kv('Endpoint', cfg.provider.endpoint));",
  "    mr=mr.concat(kv('Config', cfg.id+' v'+cfg.version));",
  "    if(cfg.temperature!=null) mr=mr.concat(kv('Temperature', String(cfg.temperature)));",
  "    if(cfg.maxOutputTokens!=null) mr=mr.concat(kv('Max output tokens', String(cfg.maxOutputTokens)));",
  "    wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Model configuration'}), el('div',{class:'kv'},mr) ]));",
  "    if(cfg.systemPrompt){ wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'System prompt (agent instructions)'}), el('pre',{class:'block',text:cfg.systemPrompt}) ])); }",
  "    if(cfg.tools&&cfg.tools.length){ var tl=el('div');",
  "      for(var i=0;i<cfg.tools.length;i++){ var t=cfg.tools[i];",
  "        tl.appendChild(el('div',{class:'subcard'},[ el('div',{class:'h'},['\\uD83D\\uDD27 ', el('span',{text:t.name})]),",
  "          el('div',{class:'c'},[ el('div',{class:'text',text:t.description||''}), el('pre',{class:'block mono',text:JSON.stringify(t.inputSchema,null,2)}) ]) ])); }",
  "      wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Tools ('+cfg.tools.length+')'}), tl ])); } }",
  "  else { wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Model configuration'}), el('div',{class:'note',text:'Config not available (catalog not provided).'}) ])); }",
  "  var firstUser=null; for(var i=0;i<session.events.length;i++){ var e=session.events[i];",
  "    if(e.type==='message.appended'){ var m=rec(e.data).message; if(m&&m.role==='user'){ firstUser=m; break; } } }",
  "  if(firstUser){ wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Initial user prompt'}),",
  "    el('div',{class:'body'}, contentBlocks(firstUser.content)) ])); }",
  "  var s=session.telemetry||{}; var stat=el('div',{class:'stats'});",
  "  function addStat(n,l){ stat.appendChild(el('div',{class:'stat'},[ el('div',{class:'n',text:n}), el('div',{class:'l',text:l}) ])); }",
  "  addStat(num(s.modelCalls),'model calls'); addStat(num(s.actionCalls),'tool calls');",
  "  addStat(num(s.inputTokens),'input tokens'); addStat(num(s.outputTokens),'output tokens');",
  "  addStat(money(s.costUsd),'cost'); addStat(num(s.actionFailures),'tool failures');",
  "  if(s.cacheReadTokens) addStat(num(s.cacheReadTokens),'cache read tok');",
  "  if(s.reasoningTokens) addStat(num(s.reasoningTokens),'reasoning tok');",
  "  wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Telemetry (this session)'}), stat ]));",
  "  var stops=s.stopReasons||{}; var sk=Object.keys(stops);",
  "  if(sk.length){ var chips=el('div'); for(var i=0;i<sk.length;i++) chips.appendChild(el('span',{class:'chip',text:sk[i]+': '+stops[sk[i]]}));",
  "    wrap.querySelector('.stats').parentNode.appendChild(chips); }",
  "  var outcome=null; for(var i=session.events.length-1;i>=0;i--){ if(session.events[i].type==='run.completed'){ outcome=rec(session.events[i].data).outcome; break; } }",
  "  if(outcome){ wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Outcome'}), el('pre',{class:'block mono',text:JSON.stringify(outcome,null,2)}) ])); }",
  "  if(session.childIds&&session.childIds.length){ var list=el('div');",
  "    for(var i=0;i<session.childIds.length;i++){ (function(id){ ",
  "      list.appendChild(el('div',{class:'subagent'},[ el('div',{class:'h'},['\\u2197 ', el('span',{text:label(id)}),",
  "        (DATA.sessions[id]? el('button',{class:'link',text:'open',on:{click:function(){ state.session=id; state.tab='transcript'; render(); }}}) : el('span',{class:'chip',text:'not captured'})) ]) ])); })(session.childIds[i]); }",
  "    wrap.appendChild(el('div',{class:'card'},[ el('h2',{text:'Sub-agents ('+session.childIds.length+')'}), list ])); }",
  "  return wrap; }",
  "",
  "function raw(session){ var wrap=el('div');",
  "  for(var i=0;i<session.events.length;i++){ var e=session.events[i];",
  "    var row=el('details',{class:'rawrow'},[",
  "      el('summary',null,[ el('span',{class:'seq',text:'#'+e.sequence}), el('span',{class:'cat',text:e.category}),",
  "        el('span',{text:e.type}), el('span',{class:'spacer'}) ]),",
  "      el('pre',{class:'block json mono',text:JSON.stringify(e,null,2)}) ]);",
  "    wrap.appendChild(row); }",
  "  return wrap; }",
  "",
  "function render(){ var session=DATA.sessions[state.session];",
  "  app.innerHTML='';",
  "  app.appendChild(header()); app.appendChild(tabs());",
  "  var main=el('main');",
  "  if(!session){ main.appendChild(el('div',{class:'empty',text:'Session not found.'})); }",
  "  else if(state.tab==='overview') main.appendChild(overview(session));",
  "  else if(state.tab==='transcript') main.appendChild(transcript(session));",
  "  else main.appendChild(raw(session));",
  "  app.appendChild(main);",
  "  window.scrollTo(0,0);",
  "}",
  "render();",
  "})();",
].join("\n");
