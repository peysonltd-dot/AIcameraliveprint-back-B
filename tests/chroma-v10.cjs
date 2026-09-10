const assert=require('node:assert/strict');const sharp=require('sharp');const {preparePrintResult}=require('../print-image');
(async()=>{
 const build=body=>sharp(Buffer.from(`<svg width="512" height="512">${body}</svg>`)).png().toBuffer();
 const subject='<rect x="140" y="160" width="230" height="220" rx="15" fill="#168ac6"/><circle cx="310" cy="220" r="40" fill="white"/><circle cx="200" cy="230" r="35" fill="#af8ac8"/>';
 for(const color of ['#ff00ff','#d72286','#c83e80']){
  const input=await build(`<rect width="512" height="512" fill="${color}"/><circle cx="256" cy="260" r="200" fill="#fff" opacity=".25"/>`+subject);
  const result=await preparePrintResult(input);assert.equal(result.printStatus,'ready');
  const {data,info}=await sharp(result.buffer).raw().toBuffer({resolveWithObject:true});
  let white=0,purple=0,pink=0;
  for(let i=0;i<data.length;i+=4)if(data[i+3]>200){if(data[i]>250&&data[i+1]>250&&data[i+2]>250)white++;if(data[i]>160&&data[i]<185&&data[i+1]>120&&data[i+1]<150&&data[i+2]>190)purple++;if(data[i]>data[i+1]+50&&data[i+2]>data[i+1]+25&&data[i]>data[i+2])pink++;}
  assert(white>100&&purple>100);assert.equal(pink,0,'pink gradient halo removed: '+color);assert.equal(info.channels,4);
 }
 // A two-pixel blue/magenta mixed fringe around blue artwork: verify blue survives and the pink spill decreases.
 const raw=Buffer.alloc(512*512*4);
 for(let y=0;y<512;y++)for(let x=0;x<512;x++){
  let c=[255,0,255,255];
  if(x>=120&&x<390&&y>=150&&y<360){const edge=Math.min(x-120,389-x,y-150,359-y);c=edge<2?[104,93,232,255]:[22,138,198,255];}
  raw.set(c,(y*512+x)*4);
 }
 const result=await preparePrintResult(await sharp(raw,{raw:{width:512,height:512,channels:4}}).png().toBuffer());
 assert.equal(result.printStatus,'ready');const d=await sharp(result.buffer).raw().toBuffer();let contaminated=0,blue=0;
 for(let i=0;i<d.length;i+=4)if(d[i+3]>100){if(d[i]>80&&d[i+1]<110)contaminated++;if(d[i]<35&&d[i+1]>125)blue++;}
 assert(blue>1000);assert.equal(contaminated,0,'mixed pink fringe decontaminated');
 // Large enclosed same-key areas are ambiguous and must be reviewed rather than silently deleting clothing.
 const ambiguous=await preparePrintResult(await build('<rect width="512" height="512" fill="#ff00ff"/>'+subject+'<rect x="225" y="260" width="40" height="50" fill="#ff00ff"/>'));
 assert.equal(ambiguous.printStatus,'review');
 console.log('PASS adaptive chroma: sampled pink shades, lighter halo removed, white and purple retained, mixed blue fringe cleaned, enclosed key-colored artwork sent to review.');
})().catch(e=>{console.error(e);process.exitCode=1});
