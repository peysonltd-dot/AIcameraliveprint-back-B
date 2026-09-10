const assert=require('node:assert/strict');
const sharp=require('sharp');
const {preparePrintResult}=require('../print-image');
(async()=>{
 const svg=Buffer.from('<svg width="1024" height="768"><rect width="1024" height="768" fill="white"/><rect x="250" y="180" width="450" height="360" fill="white" stroke="#303030" stroke-width="10"/><rect x="270" y="210" width="80" height="90" fill="#ff00ff"/><rect x="370" y="210" width="80" height="90" fill="#effaff"/></svg>');
 const result=await preparePrintResult(await sharp(svg).png().toBuffer());
 assert.equal(result.mime,'image/png');assert.equal(result.printStatus,'review');
 const {data,info}=await sharp(result.buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let white=0,pink=0,paleBlue=0;
 for(let i=0;i<data.length;i+=4){if(!data[i+3])continue;const x=(i/4)%info.width,y=Math.floor(i/4/info.width);assert(x>=82&&x<942&&y>=62&&y<706);if(data[i]===255&&data[i+1]===255&&data[i+2]===255)white++;if(data[i]===255&&data[i+1]===0&&data[i+2]===255)pink++;if(data[i]===239&&data[i+1]===250&&data[i+2]===255)paleBlue++;}
 assert.equal(data[3],0);assert(white>1000&&pink>100&&paleBlue>100);
 console.log('PASS white-background: actual alpha, safe margins, outlined white/pink/pale blue preserved; review retained.');
})().catch(e=>{console.error(e);process.exitCode=1});
