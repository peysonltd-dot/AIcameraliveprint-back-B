const sharp = require('sharp');

// Remove only the chroma backdrop, preserving white IP bodies, foam and blue water.
// This processes the WHOLE generated scene; it is not fixed-IP layering.
async function preparePrintPng(buffer, {width=1024,height=768,margin=0.08}={}) {
    const {data,info}=await sharp(buffer,{limitInputPixels:20000000}).rotate().ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const w=info.width,h=info.height,n=w*h;
    const distance=i=>Math.hypot(255-data[i*4], data[i*4+1], 255-data[i*4+2]);
    const border=[];
    for(let x=0;x<w;x++){border.push(x,(h-1)*w+x);}
    for(let y=1;y<h-1;y++){border.push(y*w,y*w+w-1);}
    const transparent=border.filter(i=>data[i*4+3]<8).length/border.length;
    if(transparent<0.95) {
        const keyCoverage=border.filter(i=>distance(i)<85 || data[i*4+3]<8).length/border.length;
        if(keyCoverage<0.90) throw new Error('圖片背景不適合透明輸出或圖案已碰到邊界；請保留原任務並由工作人員檢查後重試');
        const visited=new Uint8Array(n),queue=new Int32Array(n); let head=0,tail=0;
        function add(i){if(visited[i] || distance(i)>125)return;visited[i]=1;queue[tail++]=i;}
        border.forEach(add);
        while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);if(x)add(i-1);if(x<w-1)add(i+1);if(y)add(i-w);if(y<h-1)add(i+w);}
        for(let i=0;i<n;i++) {
            const d=distance(i);
            // Near-exact key in enclosed gaps is backdrop too. Broader fringe removal only connects to the outside.
            if(d<45 || visited[i]) {
                const a=Math.max(0,Math.min(1,(d-45)/80));
                data[i*4+3]=Math.min(data[i*4+3],Math.round(a*255));
                // Reduce magenta spill at the outer feathered edge; never key white or blue by brightness.
                if(a>0 && a<1){for(const c of [0,2])data[i*4+c]=Math.round(Math.max(0,Math.min(255,(data[i*4+c]-255*(1-a))/a)));data[i*4+1]=Math.round(Math.min(255,data[i*4+1]/a));}
            }
        }
    }
    // Adding padding cannot repair already clipped pixels. Reject visible content at the source edge.
    if(border.some(i=>data[i*4+3]>24)) throw new Error('圖案碰到原圖邊界，可能已裁切，請重新生成完整構圖');
    let left=w,top=h,right=-1,bottom=-1,count=0;
    for(let i=0;i<n;i++)if(data[i*4+3]>0){const x=i%w,y=Math.floor(i/w);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;}
    if(count<100 || right<left)throw new Error('未偵測到可印製圖案');
    const mx=Math.ceil(width*margin),my=Math.ceil(height*margin);
    const inner=await sharp(data,{raw:info}).extract({left,top,width:right-left+1,height:bottom-top+1})
        .resize(width-2*mx,height-2*my,{fit:'contain',background:'#00000000'}).png().toBuffer();
    return sharp({create:{width,height,channels:4,background:'#00000000'}})
        .composite([{input:inner,left:mx,top:my}]).png({compressionLevel:9}).toBuffer();
}
module.exports={preparePrintPng};
