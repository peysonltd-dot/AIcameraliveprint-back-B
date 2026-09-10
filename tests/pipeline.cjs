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
let count = 0, generationRequests = [], rejectChibi = false, plainBackground = false;
(async () => {
 const dir = path.join(__dirname, '../assets/layers/digital-ark-green');
 // A full scene on a uniform key backdrop; output must preserve its colored artwork and remove only the backdrop.
 const fixture = await sharp(Buffer.from('<svg width="1024" height="768"><rect width="1024" height="768" fill="#ff00ff"/><rect x="220" y="220" width="580" height="300" rx="30" fill="#208fc0"/><circle cx="600" cy="300" r="75" fill="white"/><circle cx="340" cy="300" r="60" fill="#a575b5"/></svg>')).png().toBuffer();
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
  if(url==='https://mock/image') return new Response(plainBackground ? await sharp({create:{width:1024,height:768,channels:3,background:'#777777'}}).png().toBuffer() : fixture);
  throw Error('Unexpected external request '+url);
 };
 const {app,testHelpers:h}=require('../server');
 const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const health=await realFetch(base+'/health').then(r=>r.json());
  assert.equal(health.imageProvider,'leonardo-full-scene'); assert.equal(health.modelSideMask,false); assert.equal(health.removeBgMode,'local-chroma'); assert.equal(health.layeredComposite,false);
  const invalid=await realFetch(base+'/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:'invalid'})}); assert.equal(invalid.status,400);
  async function run(sceneId="digital-ark-green") {
   const task=await realFetch(base+'/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:'data:image/png;base64,'+fixture.toString('base64'),sceneId})}).then(r=>r.json());
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
   assert.equal(meta.format,'png'); assert.equal(meta.hasAlpha,true);
   const decoded=await sharp(Buffer.from(image.split(',')[1],'base64')).raw().toBuffer();
   for(let y=0;y<768;y++)for(let x=0;x<1024;x++)if(x<82||x>=942||y<62||y>=706)assert.equal(decoded[(y*1024+x)*4+3],0);

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
  rejectChibi=true; const failed=await run(); assert.equal(failed.status,'partial'); assert(failed.resultImageA); assert(!failed.resultImageB); assert(failed.error.includes('test rejection'));
  assert.equal(generationRequests.length,4,'no billable retries');
  rejectChibi=false;
  const catalog=await realFetch(base+'/api/scenes').then(r=>r.json());
  assert.equal(catalog.scenes.length,6);
  const ids=new Set();
  for(const scene of catalog.scenes) {
   const offset=generationRequests.length;
   const task=await run(scene.id);assert.equal(task.status,'completed');
   const payload=generationRequests[offset];ids.add(payload.parameters.guidances.image_reference[1].image.id);
   const conf=require('../assets/ip-catalog.json').find(x=>x.id===scene.id);assert(payload.parameters.prompt.includes(conf.description));
  }
  assert.equal(ids.size,6,'each IP gets a distinct official reference');
  plainBackground=true; const review=await run();assert.equal(review.status,'completed');assert.equal(review.printStatusA,'review');assert(review.resultImageA.startsWith('data:image/jpeg'));
  const before=generationRequests.length;
  plainBackground=false;
  const repaired=await realFetch(base+'/api/admin/reprocess/009',{method:'POST'}).then(r=>r.json());assert.equal(repaired.success,true);
  assert.equal(generationRequests.length,before,'local reprocessing must not start a paid generation');
  const fixed=await realFetch(base+'/api/status/009').then(r=>r.json());assert.equal(fixed.printStatusA,'ready');assert(fixed.resultImageA.startsWith('data:image/png'));
  const invalidChoice=await realFetch(base+'/api/choice/002',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({choice:'B'})});assert.equal(invalidChoice.status,400);
  console.log('PASS: Leonardo-only routing, two styles, five ordered references, six IPs, transparent PNG with guaranteed margins, invalid photo rejection, partial failure retained, no paid retries. MOCKED results only.');
 } finally { server.close(); global.fetch=realFetch; }
})().catch(e=>{console.error(e);process.exitCode=1});
