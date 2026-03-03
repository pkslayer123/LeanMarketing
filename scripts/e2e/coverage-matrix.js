#!/usr/bin/env node
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,"..",".."),SD=path.join(ROOT,"e2e","state");
const MP=path.join(SD,"manifest.json"),LP=path.join(SD,"persona-learning.json");
const GP=path.join(SD,"green-history.json"),OP=path.join(SD,"coverage-matrix.json");
const ar=process.argv.slice(2);
const isJ=ar.includes("--json"),shG=ar.includes("--gaps"),doE=ar.includes("--export");
function gA(n){const i=ar.indexOf(n);return i>=0&&ar[i+1]?ar[i+1]:null;}
const fD=gA("--feature"),iP=gA("--impact");
function lJ(f,d){if(!fs.existsSync(f))return d;try{return JSON.parse(fs.readFileSync(f,"utf-8"));}catch{return d;}}
function pR(v,w){return String(v).padEnd(w);}
function buildMatrix(){
const mf=lJ(MP,{features:{}}),lr=lJ(LP,{personas:{}}),gh=lJ(GP,{tests:{}});
const ft=mf.features??{},pF={},pP={},pTF={};
for(const[fk,c]of Object.entries(ft)){
const pm=c.permissions??[],ps=c.personas??[];
for(const p of pm){if(!pF[p])pF[p]=new Set();pF[p].add(fk);if(!pP[p])pP[p]=new Set();for(const pe of ps)pP[p].add(pe);}
for(const pe of ps){if(!pTF[pe])pTF[pe]=new Set();pTF[pe].add(fk);}
}
const aP=Object.keys(pF),uP=aP.filter(p=>!pP[p]||pP[p].size===0),gT=gh.tests??{};
const fC={};
for(const[fk,c]of Object.entries(ft)){
const pm=c.permissions??[],ps=c.personas??[];
const cp=pm.filter(p=>pP[p]?.size>0),cv=pm.length>0?Math.round(cp.length/pm.length*100):100;
const rt=Object.entries(gT).filter(([k])=>k.includes(fk)).map(([k,v])=>({key:k,...v}));
const pt=rt.filter(t=>t.consecutive_passes>0),ap=ps.filter(p=>lr.personas?.[p]?.totalRuns>0);
fC[fk]={personaCount:ps.length,activePersonaCount:ap.length,permissionCount:pm.length,coveragePct:cv,testCount:rt.length,passingTestCount:pt.length,uncoveredPermissions:pm.filter(p=>uP.includes(p)),weight:c.coverageWeight??1.0};
}
return{summary:{totalFeatures:Object.keys(ft).length,totalPermissions:aP.length,totalPersonas:Object.keys(pTF).length,uncoveredPermissions:uP.length,avgCoverage:Math.round(Object.values(fC).reduce((s,f)=>s+f.coveragePct,0)/Math.max(Object.keys(fC).length,1))||0},featureCoverage:fC,uncoveredPermissions:uP,permToPersonas:Object.fromEntries(Object.entries(pP).map(([k,v])=>[k,[...v]])),personaToFeatures:Object.fromEntries(Object.entries(pTF).map(([k,v])=>[k,[...v]]))};
}
const mx=buildMatrix();
if(isJ)console.log(JSON.stringify(mx,null,2));
else if(shG){const u=mx.uncoveredPermissions;console.log(`\nUncovered (${u.length})\n`);if(!u.length)console.log("All covered!");else for(const p of u)console.log(`  - ${p}`);}
else if(fD){const d=mx.featureCoverage[fD];if(!d)console.error(`Not found: ${fD}`);else console.log(`\n${fD}: ${d.coveragePct}% | ${d.activePersonaCount}/${d.personaCount} personas | ${d.permissionCount} perms\n`);}
else if(iP){const ps=mx.permToPersonas[iP]??[];console.log(`\nImpact ${iP}: ${ps.join(", ")||"(none)"}\n`);}
else{const{summary:s,featureCoverage:fc}=mx;console.log(`\nCoverage: ${s.totalFeatures} features, ${s.totalPermissions} perms, ${s.totalPersonas} personas`);console.log(`Avg: ${s.avgCoverage}% | Uncovered: ${s.uncoveredPermissions}\n`);for(const[k,d]of Object.entries(fc).sort(([,a],[,b])=>a.coveragePct-b.coveragePct))console.log(`  ${pR(k.slice(0,28),30)} ${d.coveragePct}% ${d.activePersonaCount}/${d.personaCount}p ${d.uncoveredPermissions.length}gaps`);}
if(doE){fs.mkdirSync(path.dirname(OP),{recursive:true});fs.writeFileSync(OP,JSON.stringify({timestamp:new Date().toISOString(),...mx},null,2)+"\n");}
try{const gp=path.join(SD,"coverage-gaps.json"),ut=[];for(const[fk,d]of Object.entries(mx.featureCoverage??{}))if(d.coveragePct===0||d.activePersonaCount===0)ut.push(fk);fs.writeFileSync(gp,JSON.stringify({timestamp:new Date().toISOString(),pages:{untested:ut,count:ut.length},permissions:{uncovered:mx.uncoveredPermissions??[],count:(mx.uncoveredPermissions??[]).length}},null,2)+"\n");}catch{}
