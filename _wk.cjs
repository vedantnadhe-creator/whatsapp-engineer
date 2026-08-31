const D=require('better-sqlite3');const db=new D('/home/ubuntu/whatsapp-engineer/sessions.db',{readonly:true});
const wk=ts=>{const d=new Date(ts.replace(' ','T')+'Z');const ms=d.getTime();
 let f=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),13,0,0));
 while(f.getUTCDay()!==5||f.getTime()>ms) f=new Date(f.getTime()-86400000);
 return f.toISOString().slice(0,10);};
const isClaude=m=>m&&!/^codex:|^ollama:|^grok/.test(m);
const W={};const get=k=>W[k]||(W[k]={sess:0,csess:0,in:0,out:0,cost:0,umsg:0,hitWeekly:null,weeklyN:0,sessLimit:0});
for(const s of db.prepare('select created_at,model,input_tokens,output_tokens,cost_usd from sessions where created_at is not null').all()){
 const w=get(wk(s.created_at));w.sess++;if(isClaude(s.model)){w.csess++;w.in+=s.input_tokens||0;w.out+=s.output_tokens||0;w.cost+=s.cost_usd||0;}}
for(const m of db.prepare("select timestamp from messages where role='user' and timestamp is not null").all()) get(wk(m.timestamp)).umsg++;
for(const m of db.prepare("select timestamp,content from messages where content like 'You%hit your%limit%' and timestamp is not null").all()){
 const w=get(wk(m.timestamp));
 if(m.content.includes('weekly limit')){w.weeklyN++;if(!w.hitWeekly||m.timestamp<w.hitWeekly)w.hitWeekly=m.timestamp;}
 else if(m.content.includes('session limit'))w.sessLimit++;}
console.log('weekStart | sess | claudeSess | userTurns | inTok | outTok | cost$ | 5h-hits | wk-hits | 1stWeeklyHit | daysIn');
for(const [k,w] of Object.entries(W).sort((a,b)=>a[0]<b[0]?-1:1).filter(([k])=>k>='2026-05-01')){
 const days=w.hitWeekly?((new Date(w.hitWeekly.replace(' ','T')+'Z')-new Date(k+'T13:00:00Z'))/86400000).toFixed(1):'-';
 console.log([k,w.sess,w.csess,w.umsg,(w.in/1e6).toFixed(1)+'M',(w.out/1e6).toFixed(2)+'M',w.cost.toFixed(0),w.sessLimit,w.weeklyN,(w.hitWeekly||'-'),days].join(' | '));}
