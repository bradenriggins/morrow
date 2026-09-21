// Evaluate this expression in a page. It returns a JSON string with the counts that WI-T.1 needs.
// It reads computed styles only. It changes nothing.
export const CENSUS_EXPRESSION = String.raw`(()=>{const tally=(m,k)=>m.set(k,(m.get(k)||0)+1);const fs=new Map(),fw=new Map(),lh=new Map(),rad=new Map(),col=new Map(),bg=new Map(),gap=new Map(),pad=new Map(),ls=new Map();let small=0,targets=[],long=0,textEls=0;
for(const el of document.querySelectorAll('body *')){const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')continue;const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
 const own=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());
 if(own){textEls++;tally(fs,cs.fontSize);tally(fw,cs.fontWeight);tally(lh,(parseFloat(cs.lineHeight)/parseFloat(cs.fontSize)).toFixed(2));tally(col,cs.color);if(cs.letterSpacing!=='normal')tally(ls,cs.letterSpacing);if(parseFloat(cs.fontSize)<13)small++;
  if(el.tagName==='P'||el.tagName==='SMALL'||el.tagName==='LI'){const ch=r.width/(parseFloat(cs.fontSize)*0.5);if(ch>85)long++;}}
 if(cs.borderRadius!=='0px')tally(rad,cs.borderRadius);
 if(cs.backgroundColor!=='rgba(0, 0, 0, 0)')tally(bg,cs.backgroundColor);
 if(cs.display.includes('flex')||cs.display.includes('grid')){if(cs.gap!=='normal'&&cs.gap!=='0px')tally(gap,cs.gap);}
 if(cs.padding!=='0px')tally(pad,cs.padding);
 if(el.matches('button,a,input,select,summary,[role=button]')){if(r.height<44||r.width<44)targets.push(el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+' '+Math.round(r.width)+'x'+Math.round(r.height));}}
const top=(m,n=12)=>[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,v])=>k+' ×'+v);
return JSON.stringify({textEls,fontSizes:top(fs,14),distinctSizes:fs.size,weights:top(fw),lineHeights:top(lh,10),distinctLH:lh.size,letterSpacing:top(ls,6),radii:top(rad,10),distinctRadii:rad.size,textColors:top(col,8),distinctTextColors:col.size,backgrounds:top(bg,8),gaps:top(gap,12),distinctGaps:gap.size,paddings:top(pad,12),distinctPaddings:pad.size,smallText:small,longLines:long,smallTargets:targets.slice(0,12),smallTargetCount:targets.length,h:[...document.querySelectorAll('h1,h2,h3,h4')].map(h=>h.tagName+':'+getComputedStyle(h).fontSize+'/'+getComputedStyle(h).fontWeight).slice(0,14)})})()`;
