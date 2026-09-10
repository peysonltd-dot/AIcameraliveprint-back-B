// Offline integration checks. No paid provider calls; all external fetches are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
process.env.LEONARDO_API_KEY = 'test-only';
process.env.IMAGE_PROVIDER = 'openai-protected';
process.env.REMOVE_BG_MODE = 'leonardo';
delete process.env.FIREBASE_CONFIG;
const realFetch = global.fetch;
let count = 0, generationRequests = [], rejectChibi = false;
(async () => {
 const dir = path.join(__dirname, '../assets/layers/digital-ark-green');
 // Magenta is intentionally retained: full-scene mode must NOT chroma-key or overlay anything.
 const fixture = await sharp({create:{width:1024,height:768,channels:3,background:'#ff00ff'}}).png().toBuffer();
 global.fetch = async (url, options={}) => {
  url=String(url);
  if(url.startsWith('http://127.0.0.1:')) return realFetch(url, options);
  assert(!url.includes('openai.com'), 'must never call OpenAI');
  if(url.endsWith('/init-image')) return Response.json({uploadInitImage:{id:'ref'+(++count),url:'https://mock/upload',fields:'{}'}});
  if(url==='https://mock/upload') return new Response('',{status:200});
  if(url.endsWith('/v2/generations')) {
   const payload=JSON.parse(options.body); generationRequests.push(payload);
   if(rejectChibi && payload.model==='gpt-image-2') return Response.json({message:'test rejection'},{status:400});
   return Response.json({generate:{generationId:payload.model}});
  }
  if(url.includes('/v1/generations/')) return Response.json({generations_by_pk:{status:'COMPLETE',generated_images:[{url:'https://mock/image'}]}});
  if(url==='https://mock/image') return new Response(fixture);
  throw Error('Unexpected external request '+url);
 };
 const {app,testHelpers:h}=require('../server');
 const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const health=await realFetch(base+'/health').then(r=>r.json());
  assert.equal(health.imageProvider,'leonardo-full-scene'); assert.equal(health.modelSideMask,false); assert.equal(health.removeBgMode,'none'); assert.equal(health.layeredComposite,false);
  const invalid=await realFetch(base+'/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:'invalid'})}); assert.equal(invalid.status,400);
  async function run() {
   const task=await realFetch(base+'/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:'data:image/png;base64,'+fixture.toString('base64')})}).then(r=>r.json());
   for(let i=0;i<100;i++) {
    await new Promise(r=>setTimeout(r,150));
    const status=await realFetch(base+'/api/status/'+task.taskId).then(r=>r.json());
    if(status.status!=='pending') return status;
   }
   throw Error('test timed out');
  }
  const completed=await run(); assert.equal(completed.status,'completed');
  for(const image of [completed.resultImageA,completed.resultImageB]) {
   const meta=await sharp(Buffer.from(image.split(',')[1],'base64')).metadata(); assert.equal(meta.width,1024); assert.equal(meta.height,768);
   const decoded=await sharp(Buffer.from(image.split(',')[1],'base64')).raw().toBuffer();
   for(const offset of [0,(650*1024+900)*3]) {assert(decoded[offset]>245); assert(decoded[offset+1]<10); assert(decoded[offset+2]>245);}
  }
  assert.equal(generationRequests.length,2);
  const gpt=generationRequests.find(x=>x.model==='gpt-image-2');
  const gemini=generationRequests.find(x=>x.model==='gemini-2.5-flash-image');
  assert.equal(gpt.parameters.quality,'LOW'); assert.equal(gpt.parameters.guidances.image_reference[0].strength,undefined);
  assert(gpt.parameters.prompt.includes('super cute minimalist')); assert(gemini.parameters.prompt.includes('customer watercolor'));
  for(const payload of generationRequests) {
   assert.equal(payload.parameters.guidances.image_reference.length,5);
   assert(payload.parameters.prompt.includes('AUTHORITATIVE OFFICIAL MASCOT'));
   assert(payload.parameters.prompt.includes('ONE complete finished'));
   assert(!payload.parameters.prompt.includes('isolated seated human'));
  }
  for(const i of [0,1,2,3]) assert.equal(gpt.parameters.guidances.image_reference[i].image.id,gemini.parameters.guidances.image_reference[i].image.id);
  assert.notEqual(gpt.parameters.guidances.image_reference[4].image.id,gemini.parameters.guidances.image_reference[4].image.id);
  assert.equal(gemini.parameters.guidances.image_reference[1].strength,'HIGH');
  assert.equal(gemini.parameters.guidances.image_reference[3].strength,'LOW');
  assert.equal(gpt.parameters.quantity,1); assert.equal(gemini.parameters.quantity,1);
  rejectChibi=true; const failed=await run(); assert.equal(failed.status,'failed'); assert(failed.resultImageA); assert(!failed.resultImageB); assert(failed.error.includes('test rejection'));
  assert.equal(generationRequests.length,4,'no billable retries');
  console.log('PASS: Leonardo-only routing, two styles, five ordered references, 1024x768 full-scene passthrough without keying or overlays, invalid photo rejection, partial failure retained, no paid retries. MOCKED results only.');
 } finally { server.close(); global.fetch=realFetch; }
})().catch(e=>{console.error(e);process.exitCode=1});
