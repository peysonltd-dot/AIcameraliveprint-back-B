const sharp = require('sharp');

const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
function hsv(r,g,b) {
    const hi=Math.max(r,g,b),lo=Math.min(r,g,b),d=hi-lo;
    let h=0;
    if(d) h=hi===r?60*((g-b)/d%6):hi===g?60*((b-r)/d+2):60*((r-g)/d+4);
    return [(h+360)%360,hi?d/hi:0,hi];
}
const hueDistance=(a,b)=>Math.min(Math.abs(a-b),360-Math.abs(a-b));
function borders(w,h) {
    const ids=[];
    for(let x=0;x<w;x++)ids.push(x,(h-1)*w+x);
    for(let y=1;y<h-1;y++)ids.push(y*w,y*w+w-1);
    return ids;
}
function flood(w,h,seeds,accept) {
    const mask=new Uint8Array(w*h),queue=new Int32Array(w*h);let head=0,tail=0;
    function add(i){if(!mask[i]&&accept(i)){mask[i]=1;queue[tail++]=i;}}
    seeds.forEach(add);
    while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);if(x)add(i-1);if(x<w-1)add(i+1);if(y)add(i-w);if(y<h-1)add(i+w);}
    return mask;
}
function sampleKey(data,border) {
    const samples=border.filter(i=>data[i*4+3]>200).map(i=>[data[i*4],data[i*4+1],data[i*4+2]]);
    if(!samples.length)return null;
    const med=c=>samples.map(p=>p[c]).sort((a,b)=>a-b)[Math.floor(samples.length/2)];
    const key=[med(0),med(1),med(2)], tone=hsv(...key);
    // Accept pink/magenta key backdrops only; never guess blue water or a purple scene as backdrop.
    if(tone[0]<290||tone[0]>345||tone[1]<0.3||tone[2]<100)return null;
    const matches=samples.filter(p=>{const t=hsv(...p);return hueDistance(t[0],tone[0])<16&&t[1]>.22;}).length;
    return matches/samples.length>=.88?{key,tone}:null;
}
function removeChroma(data,w,h,border,keyInfo,diagnostics) {
    const original=Buffer.from(data),n=w*h,{tone}=keyInfo;
    const likeKey=i=>{
        const p=i*4,t=hsv(original[p],original[p+1],original[p+2]);
        return t[1]>.16 && t[2]>65 && hueDistance(t[0],tone[0])<12;
    };
    // Connected flood follows lighter circles/gradients of the sampled key; enclosed artwork is not globally keyed.
    const mask=flood(w,h,border,i=>original[i*4+3]<8||likeKey(i));
    let removed=0;
    for(let i=0;i<n;i++)if(mask[i]){data[i*4+3]=0;removed++;}
    if(removed/n<.08)throw Error('可辨識的底色範圍不足，需人工確認');

    // Propagate the nearest actual backdrop sample into a narrow foreground band.
    // Only this band is eligible for color decontamination; interior clothing/IP colors remain untouched.
    const dist=new Uint8Array(n),nearest=new Int32Array(n),q=new Int32Array(n);let head=0,tail=0;
    for(let i=0;i<n;i++)if(mask[i]) {
        const x=i%w,y=Math.floor(i/w);
        if((x&& !mask[i-1])||(x<w-1&&!mask[i+1])||(y&&!mask[i-w])||(y<h-1&&!mask[i+w])){q[tail++]=i;nearest[i]=i;}
    }
    while(head<tail){const i=q[head++];if(dist[i]>=5)continue;const x=i%w,y=Math.floor(i/w);
        for(const j of [x?i-1:-1,x<w-1?i+1:-1,y?i-w:-1,y<h-1?i+w:-1])
            if(j>=0&&!mask[j]&&!dist[j]){dist[j]=dist[i]+1;nearest[j]=nearest[i];q[tail++]=j;}
    }
    for(let i=0;i<n;i++)if(!mask[i]&&dist[i]>0&&dist[i]<=2) {
        const p=i*4,bp=nearest[i]*4,x=i%w,y=Math.floor(i/w);
        const C=[original[p],original[p+1],original[p+2]],B=[original[bp],original[bp+1],original[bp+2]];
        let best=null;
        for(let dy=-5;dy<=5;dy++)for(let dx=-5;dx<=5;dx++) {
            if(x+dx<0||x+dx>=w||y+dy<0||y+dy>=h)continue;
            const j=(y+dy)*w+x+dx,jp=j*4;
            if(mask[j]||(dist[j]&&dist[j]<4)||original[jp+3]<240)continue;
            const F=[original[jp],original[jp+1],original[jp+2]];
            // Red/green excess must move toward the key; the RGB fit below also constrains the blue channel.
            if(C[0]-C[1] <= F[0]-F[1]+6)continue;
            const v=F.map((c,k)=>c-B[k]),den=v.reduce((s,c)=>s+c*c,0);if(den<1600)continue;
            const a=clamp(v.reduce((s,c,k)=>s+(C[k]-B[k])*c,0)/den);
            if(a<=.04||a>=.97)continue;
            const error=Math.hypot(...C.map((c,k)=>c-(a*F[k]+(1-a)*B[k])));
            const score=error+Math.hypot(dx,dy);
            if(error<=22&&(!best||score<best.score))best={a,F,score};
        }
        if(best){for(let c=0;c<3;c++)data[p+c]=best.F[c];data[p+3]=Math.round(original[p+3]*best.a);}
    }
    // Large enclosed regions matching the key cannot be distinguished from pink clothing safely.
    let uncertain=0;
    for(let i=0;i<n;i++)if(!mask[i]&&likeKey(i))uncertain++;
    if(uncertain>Math.max(48,n*.0005))diagnostics.warning='仍有接近底色的封閉區域，請檢查粉紅配件與色邊';
    diagnostics.method='adaptive-chroma';
}

async function preparePrintPng(buffer,{width=1024,height=768,margin=.08,diagnostics={}}={}) {
    const {data,info}=await sharp(buffer,{limitInputPixels:20000000}).rotate().ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const w=info.width,h=info.height,n=w*h,border=borders(w,h);
    const transparent=border.filter(i=>data[i*4+3]<8).length/border.length;
    if(transparent<.95) {
        let key=sampleKey(data,border);
        if(key)removeChroma(data,w,h,border,key,diagnostics);
        else {
            // Paper fallback removes only a near-uniform border-connected area and always needs staff review.
            const samples=border.map(i=>i*4),med=c=>samples.map(i=>data[i+c]).sort((a,b)=>a-b)[Math.floor(samples.length/2)];
            const paper=[med(0),med(1),med(2)];
            const delta=i=>Math.hypot(data[i*4]-paper[0],data[i*4+1]-paper[1],data[i*4+2]-paper[2]);
            if(Math.min(...paper)<210||border.filter(i=>delta(i)<24).length/border.length<.95)throw Error('外圍背景不是可辨識的單一底色，需要人工去背');
            const mask=flood(w,h,border,i=>delta(i)<=32);
            for(let i=0;i<n;i++)if(mask[i])data[i*4+3]=Math.min(data[i*4+3],Math.round(clamp((delta(i)-14)/18)*255));
            diagnostics.method='paper';diagnostics.warning='已使用淺色背景備援去背，請確認白色角色、衣物與水花邊緣';
        }
    }
    if(border.some(i=>data[i*4+3]>24))throw Error('圖案碰到原圖邊界，可能已裁切，請重新生成完整構圖');
    let left=w,top=h,right=-1,bottom=-1,count=0;
    for(let i=0;i<n;i++)if(data[i*4+3]>0){const x=i%w,y=Math.floor(i/w);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;}
    if(count<100||right<left)throw Error('未偵測到可印製圖案');
    const mx=Math.ceil(width*margin),my=Math.ceil(height*margin);
    const inner=await sharp(data,{raw:info}).extract({left,top,width:right-left+1,height:bottom-top+1}).resize(width-2*mx,height-2*my,{fit:'contain',background:'#00000000'}).png().toBuffer();
    return sharp({create:{width,height,channels:4,background:'#00000000'}}).composite([{input:inner,left:mx,top:my}]).png({compressionLevel:9}).toBuffer();
}
async function preparePrintResult(buffer,options={}) {
    const diagnostics={};
    try {
        const png=await preparePrintPng(buffer,{...options,diagnostics});
        return {buffer:png,mime:'image/png',printStatus:diagnostics.warning?'review':'ready',warning:diagnostics.warning||''};
    } catch(error) {
        const width=options.width||1024,height=options.height||768,margin=options.margin??.08,mx=Math.ceil(width*margin),my=Math.ceil(height*margin);
        const preview=await sharp(buffer,{limitInputPixels:20000000}).rotate().resize(width-2*mx,height-2*my,{fit:'contain',background:'#fffdf8'}).flatten({background:'#fffdf8'}).png().toBuffer();
        const jpeg=await sharp({create:{width,height,channels:3,background:'#fffdf8'}}).composite([{input:preview,left:mx,top:my}]).jpeg({quality:92}).toBuffer();
        return {buffer:jpeg,mime:'image/jpeg',printStatus:'review',warning:`保留未去背預覽，需人工處理：${error.message}`};
    }
}
module.exports={preparePrintPng,preparePrintResult};
