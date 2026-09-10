// Offline only: all Leonardo requests and image downloads are mocked.
const assert=require('node:assert/strict');
const sharp=require('sharp');
process.env.LEONARDO_API_KEY='test-only';delete process.env.FIREBASE_CONFIG;
const realFetch=global.fetch;
let count=0,requests=[],reject=false,review=false;
(async()=>{
 const fixture=await sharp(Buffer.from('<svg width="1024" height="768"><rect width="1024" height="768" fill="#ff00ff"/><rect x="220" y="220" width="580" height="300" rx="30" fill="#208fc0"/><circle cx="600" cy="300" r="75" fill="white"/><circle cx="340" cy="300" r="60" fill="#a575b5"/></svg>')).png().toBuffer();
 global.fetch=async(url,options={})=>{
  url=String(url);if(url.startsWith('http://127.0.0.1:'))return realFetch(url,options);
  assert(!url.includes('openai.com'));
  if(url.endsWith('/init-image'))return Response.json({uploadInitImage:{id:'ref'+(++count),url:'https://mock/upload',fields:'{}'}});
  if(url==='https://mock/upload')return new Response('',{status:200});
  if(url.endsWith('/v2/generations')){
   const payload=JSON.parse(options.body);requests.push(payload);
   assert.equal(payload.model,'gpt-image-2','watercolor must never be requested');
   if(reject)return Response.json({message:'test rejection'},{status:400});
   return Response.json({generate:{generationId:'job'+requests.length}});
  }
  if(url.includes('/v1/generations/'))return Response.json({generations_by_pk:{status:'COMPLETE',generated_images:[{url:'https://mock/image'}]}});
  if(url==='https://mock/image')return new Response(review?await sharp({create:{width:1024,height:768,channels:3,background:'#777'}}).png().toBuffer():fixture);
  throw Error('Unexpected request '+url);
 };
 const {app}=require('../server');const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const post=(route,body)=>realFetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  const status=id=>realFetch(base+'/api/status/'+id).then(r=>r.json());
  const health=await realFetch(base+'/health').then(r=>r.json());
  assert.deepEqual(health.styles,['chibi']);assert.equal(health.generationsPerGuest,1);
  assert.equal(health.layeredComposite,false);assert.equal(health.pipelineVersion,'leonardo-chibi-print-v10');
  assert.equal((await post('/api/upload',{image:'invalid'})).status,400);
  async function run(sceneId='digital-ark-green'){
   const task=await (await post('/api/upload',{image:'data:image/png;base64,'+fixture.toString('base64'),sceneId})).json();
   for(let i=0;i<100;i++){
    await new Promise(r=>setTimeout(r,150));const data=await status(task.taskId);
    if(data.status!=='pending')return {...data,id:task.taskId};
   }throw Error('Timed out');
  }
  const scenes=(await realFetch(base+'/api/scenes').then(r=>r.json())).scenes;assert.equal(scenes.length,6);
  const refs=new Set();let first;
  for(const scene of scenes){
   const before=requests.length,task=await run(scene.id);first??=task;
   assert.equal(requests.length,before+1,'exactly one billable generation per guest');
   assert.equal(task.status,'completed');assert(!task.resultImageA);assert.equal(task.printStatusB,'ready');
   const payload=requests[before];assert.equal(payload.parameters.quantity,1);assert.equal(payload.parameters.quality,'LOW');
   assert.equal(payload.parameters.guidances.image_reference.length,5);refs.add(payload.parameters.guidances.image_reference[1].image.id);
   assert(payload.parameters.prompt.includes('super cute minimalist'));assert(payload.parameters.prompt.includes('AUTHORITATIVE OFFICIAL MASCOT'));
   const decoded=await sharp(Buffer.from(task.resultImageB.split(',')[1],'base64')).raw().toBuffer({resolveWithObject:true});
   assert.equal(decoded.info.channels,4);
   for(let y=0;y<768;y++)for(let x=0;x<1024;x++)if(x<82||x>=942||y<62||y>=706)assert.equal(decoded.data[(y*1024+x)*4+3],0);
  }
  assert.equal(refs.size,6);
  assert.equal((await post('/api/choice/'+first.id,{choice:'A'})).status,400);
  assert.equal((await post('/api/choice/'+first.id,{choice:'B'})).status,200);
  reject=true;const failed=await run();assert.equal(failed.status,'failed');assert.equal(requests.length,7,'no paid retries');reject=false;
  review=true;const pending=await run();assert.equal(pending.printStatusB,'review');assert(pending.resultImageB.startsWith('data:image/jpeg'));
  assert.equal((await post('/api/choice/'+pending.id,{choice:'B'})).status,409);
  assert.equal((await post('/api/admin/approve-result/'+pending.id,{choice:'B',confirmed:true})).status,400,'JPEG must not be approved');
  const before=requests.length;review=false;
  assert.equal((await post('/api/admin/reprocess/'+pending.id)).status,200);
  assert.equal(requests.length,before,'reprocessing never generates again');
  assert.equal((await status(pending.id)).printStatusB,'ready');
  const paper=await sharp(Buffer.from('<svg width="1024" height="768"><rect width="1024" height="768" fill="#fffdf5"/><rect x="200" y="200" width="400" height="350" fill="white" stroke="#333" stroke-width="12"/></svg>')).png().toBuffer();
  assert.equal((await post('/api/admin/upload-result-dual/'+pending.id,{resultImageB:'data:image/png;base64,'+paper.toString('base64')})).status,200);
  assert.equal((await status(pending.id)).printStatusB,'review');
  assert.equal((await post('/api/choice/'+pending.id,{choice:'B'})).status,409);
  assert.equal((await post('/api/admin/approve-result/'+pending.id,{choice:'B',confirmed:true})).status,200);
  assert.equal((await post('/api/choice/'+pending.id,{choice:'B'})).status,200);
  assert.equal(requests.length,before);
  console.log('PASS MOCK ONLY: six IPs, one GPT Image 2 LOW request per guest, no watercolor or paid retry, transparent margins, review cannot be selected, reprocess/replace/approve recovery without regeneration.');
 }finally{server.close();global.fetch=realFetch;}
})().catch(e=>{console.error(e);process.exitCode=1});
