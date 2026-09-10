const assert=require('node:assert/strict');const sharp=require('sharp');const {preparePrintPng}=require('../print-image');
async function svg(body){return sharp(Buffer.from(`<svg width="1024" height="768">${body}</svg>`)).png().toBuffer();}
(async()=>{
 const key='<rect width="1024" height="768" fill="#ff00ff"/>';
 const colors='<rect x="150" y="160" width="200" height="350" fill="#ffffff"/><rect x="350" y="160" width="200" height="350" fill="#168ac6"/><rect x="550" y="160" width="200" height="350" fill="#af8ac8"/>';
 const result=await preparePrintPng(await svg(key+colors));
 const {data,info}=await sharp(result).raw().toBuffer({resolveWithObject:true});assert.equal(info.channels,4);
 let white=0,blue=0,purple=0;
 for(let i=0;i<data.length;i+=4){if(!data[i+3])continue;const x=(i/4)%1024,y=Math.floor(i/4/1024);assert(x>=82&&x<942&&y>=62&&y<706);if(data[i]>250&&data[i+1]>250&&data[i+2]>250)white++;if(data[i]<30&&data[i+1]>110&&data[i+2]>170)blue++;if(data[i]>140&&data[i+1]>110&&data[i+1]<170&&data[i+2]>170)purple++;}
 assert(white>1000&&blue>1000&&purple>1000,'white IP, blue water, purple character retained');
 await assert.rejects(preparePrintPng(await svg('<rect width="1024" height="768" fill="white"/>'+colors)),/背景/);
 await assert.rejects(preparePrintPng(await svg(key+'<rect x="0" y="200" width="400" height="300" fill="blue"/>')),/邊界/);
 await assert.rejects(preparePrintPng(await svg(key)),/未偵測/);
 const alphaInput=await svg(colors);const alphaOut=await preparePrintPng(alphaInput);assert.equal((await sharp(alphaOut).metadata()).hasAlpha,true);
 console.log('PASS print: actual alpha, 8% margins, white/purple/blue preserved, invalid backdrop and clipped source rejected, native-alpha input supported.');
})().catch(e=>{console.error(e);process.exitCode=1});
