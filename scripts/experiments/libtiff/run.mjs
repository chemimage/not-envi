import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
const repo=process.cwd(), outputAt=process.argv.indexOf('--output'), root=outputAt>=0?path.resolve(process.argv[outputAt+1]):path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.join(repo,'package.json'));
const {chromium}=require('@playwright/test');
const {createServer}=await import(pathToFileURL(path.join(repo,'node_modules/vite/dist/node/index.js')));
const server=await createServer({root:repo,server:{host:'127.0.0.1',port:4182,strictPort:true,fs:{allow:[repo,root]}},plugins:[{name:'probe',configureServer(s){s.middlewares.use('/probe',async(req,res,next)=>{
  const name=req.url.split('?')[0].slice(1);
  if(name==='index.html'){res.setHeader('Content-Type','text/html');res.end('<input id="files" type="file">');return;}
  if(!/^[\w.-]+\.(mjs|wasm)$/.test(name)) return next();
  try{const data=await readFile(path.join(root,name));res.setHeader('Content-Type',name.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(data);}catch{next();}
});}}]});
await server.listen();
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
page.on('console',m=>{if(m.type()==='error') console.error(m.text());});
const report={date:new Date().toISOString(),sourceCommit:'d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d',viewerCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),emscripten:'4.0.22',chromium:browser.version(),fixtures:[],real:[]};
if(process.argv.includes('--finish-only'))Object.assign(report,JSON.parse(await readFile(path.join(root,'results.json'),'utf8')));
async function save(){await writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));}
try{
 await page.goto('http://127.0.0.1:4182/probe/index.html');
 await page.evaluate(async()=>{
  window.rpc=(variant)=>{const worker=new Worker('/probe/libtiff.worker.mjs',{type:'module'});let id=0;const pending=new Map();worker.onmessage=({data})=>{const p=pending.get(data.id);pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);};return {call:(type,args={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});worker.postMessage({id:key,type,...args});}),close:()=>worker.terminate(),variant};};
  window.writer=rpc('probe');await writer.call('init',{variant:'probe'});
  window.reader=rpc('reader');await reader.call('init');
  window.small=rpc('small');await small.call('init',{variant:'small'});
  const {addDatasetFromFile}=await import('/src/io/tiff-loader.js');
  const {readBandWindow,readBandWindowBIP}=await import('/src/core/raster-io.js');
  const {createFmapRangeDataSource}=await import('/src/io/fmap/index.js');
  const wasm=await(await fetch('/wasm/fmap/pkg/fmap_core.wasm')).arrayBuffer();
  window.openHyve=async(file,sync=false)=>{
    const args={fmapEnabled:true,fmapWasmBytes:wasm,fmapOptions:{poolBytes:64*1024*1024},cacheBytes:128*1024*1024,ioConcurrency:12,createDataset:d=>d};
    if(sync) args.createFmapRangeDataSource=(f,options)=>createFmapRangeDataSource(f,{...options,workerFactory:()=>{
      const code=`import '${location.origin}/src/io/fmap/fmap.worker.js'; const reader=new FileReaderSync(); Blob.prototype.arrayBuffer=function(){return Promise.resolve(reader.readAsArrayBuffer(this));};`;
      return new Worker(URL.createObjectURL(new Blob([code],{type:'text/javascript'})),{type:'module'});
    }});
    const start=performance.now(); const ds=await addDatasetFromFile(file,args);await ds.cached.ready;
    ds.openMs=performance.now()-start;
    ds.read=async(win)=>{const start=performance.now();const read=ds.meta.interleave==='bip'?readBandWindowBIP:readBandWindow;const planes=await Promise.all(Array.from({length:ds.meta.bands},(_,band)=>read(ds.meta,ds.cached,band,win.x,win.y,win.w,win.h,win.step||1,12)));return {planes,computeMs:performance.now()-start};};return ds;
  };
  window.median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
  window.oracle=(x,y,c,config,level=0)=>{const gx=x*2**level,gy=y*2**level;if(config.float)return gx/1024+gy/2048+c*.125;if(config.noise){let v=(gy*1024+gx+1+c*77)>>>0;v=Math.imul(v^(v>>>16),0x45d9f3b);v=Math.imul(v^(v>>>16),0x45d9f3b);return (v^(v>>>16))&255;}return(gx*13+gy*7+((gx>>5)^(gy>>4))*31+c*53)&255;};
  window.check=(result,win,config,packed=false,level=0)=>{const channels=config.channels||1;const data=packed?(config.float?new Float32Array(result.bytes):new Uint8Array(result.bytes)):result.planes;let count=0;for(let y=0;y<win.h;y++)for(let x=0;x<win.w;x++)for(let c=0;c<channels;c++){const value=packed?data[(y*win.w+x)*channels+c]:data[c][y*win.w+x];const expected=oracle(win.x+x*(win.step||1),win.y+y*(win.step||1),c,config,level);if(value!==expected)throw Error(`Pixel mismatch ${value} != ${expected} at ${x},${y},${c}`);count++;}return count;};
 });
 const configs=[
  {name:'raw-gray',codec:1},{name:'packbits-gray',codec:32773},
  {name:'lzw-gray',codec:5},{name:'lzw-noise',codec:5,noise:true},
  {name:'deflate-gray',codec:8},{name:'deflate-noise',codec:8,noise:true},
  {name:'lzw-predictor2-rgb',codec:5,predictor:2,channels:3},
  {name:'deflate-predictor2-rgb',codec:8,predictor:2,channels:3},
  {name:'deflate-float32',codec:8,float:true},
  {name:'deflate-predictor3-float32',codec:8,float:true,predictor:3},
  {name:'lzw-strips',codec:5,tiled:false},{name:'deflate-strips',codec:8,tiled:false},
  {name:'lzw-main-ifds',codec:5,pyramid:1},{name:'lzw-subifds',codec:5,pyramid:2}
 ];
 for(const config of process.argv.includes('--finish-only')?[]:configs){
  const result=await page.evaluate(async config=>{
    const fixture=await writer.call('make',config),file=new File([fixture.bytes],config.name+'.tif');
    const output={config,fileBytes:file.size,variants:[],verified:0};
    const windows=[{x:13,y:29,w:128,h:128,step:1},{x:341,y:403,w:128,h:128,step:1},{x:511,y:127,w:128,h:128,step:1},{x:0,y:0,w:256,h:256,step:4}];
    for(const kind of ['libtiff','libtiff-Oz','hyve','hyve-sync-control']){
      const lib=kind.startsWith('libtiff'),r=kind==='libtiff-Oz'?small:reader;
      const opened=lib?await r.call('open',{file}):await openHyve(file,kind==='hyve-sync-control');
      const row={kind,openMs:opened.openMs,phases:[]};
      for(const phase of ['first','warm','worker-ready-cache-cleared']){if(phase==='worker-ready-cache-cleared'){if(lib)await r.call('clear');else{opened.cached.clear();await opened.cached.getStats();}}const times=[];for(const win of windows){const data=lib?await r.call('window',win):await opened.read(win);times.push(data.computeMs);output.verified+=check(data,win,config,lib);}row.phases.push({phase,times,medianMs:median(times)});}
      row.stats=lib?await r.call('stats'):await opened.cached.getStats();
      if(lib)await r.call('close');else opened.cached.close();output.variants.push(row);
    }
    await reader.call('open',{file});
    const block=await reader.call('block',{index:0});
    const c=await reader.call('codec',{bytes:block.bytes});
    const directory={Compression:config.codec,Predictor:config.predictor||1,BitsPerSample:Array(config.channels||1).fill(config.float?32:8),SamplesPerPixel:config.channels||1,SampleFormat:Array(config.channels||1).fill(config.float?3:1),TileWidth:block.meta.blockWidth,TileLength:block.meta.blockHeight,ImageWidth:block.meta.width,RowsPerStrip:block.meta.blockHeight,PlanarConfiguration:1};
    const j=await reader.call('jsCodec',{bytes:block.bytes,expected:block.decodedBytes,directory});
    if(new Uint8Array(c.bytes).some((v,i)=>v!==new Uint8Array(j.bytes)[i]))throw Error('Codec byte mismatch');
    output.codec={libtiffMs:median(c.times),jsMs:median(j.times),libtiffTimes:c.times,jsTimes:j.times,encodedBytes:block.bytes.byteLength,decodedBytes:block.decodedBytes,verifiedBytes:j.bytes.byteLength};
    if(config.pyramid){output.directories=[];for(const level of [0,1,2,0]){const info=await reader.call('directory',{level});const win={x:9,y:7,w:64,h:64};const data=await reader.call('window',win);output.verified+=check(data,win,config,true,level);output.directories.push({level,...info});}}
    await reader.call('close');return output;
  },config);
  report.fixtures.push(result);await save();console.log(config.name,JSON.stringify({codec:result.codec,variants:result.variants.map(v=>({kind:v.kind,ms:v.phases.map(p=>p.medianMs)}))}));
 }
 const filename='full_slide_with_auto_level_and_per_wn_vs_VS_071526.tif';
 for(const device of process.argv.includes('--finish-only')||process.argv.includes('--skip-real')?[]:[{name:'SSD',root:'E:/__SCRATCH__'},{name:'HDD',root:'D:/from mykolas'}]){
  const filenameFull=path.join(device.root,filename),before=await stat(filenameFull);
  await page.locator('#files').setInputFiles(filenameFull);
  const result=await page.evaluate(async device=>{
    const file=document.querySelector('#files').files[0],rows=[];
    const windows=[{x:1280,y:3400,w:512,h:512},{x:21800,y:14000,w:512,h:512},{x:31000,y:21000,w:512,h:512},{x:0,y:0,w:509,h:365,step:73}];
    const reference=[];let checked=0;
    for(const kind of ['hyve','libtiff','hyve-sync-control']){
      const lib=kind==='libtiff',opened=lib?await reader.call('open',{file}):await openHyve(file,kind==='hyve-sync-control');
      const row={kind,openMs:opened.openMs,metadata:lib?opened:{meta:opened.meta},phases:[]};
      for(const phase of ['first','warm']){const times=[];for(let i=0;i<windows.length;i++){const win=windows[i];const data=lib?await reader.call('window',win):await opened.read(win);times.push(data.computeMs);const packed=lib?new Uint8Array(data.bytes):null;if(kind==='hyve'&&phase==='first')reference.push(data.planes);else for(let p=0;p<win.w*win.h;p++)for(let c=0;c<3;c++){const value=lib?packed[p*3+c]:data.planes[c][p];if(value!==reference[i][c][p])throw Error('Real TIFF mismatch');checked++;}}row.phases.push({phase,times});}
      row.stats=lib?await reader.call('stats'):await opened.cached.getStats();
      if(lib)await reader.call('close');else opened.cached.close();rows.push(row);
    }
    return {device:device.name,file:{name:file.name,size:file.size,lastModified:file.lastModified},windows,rows,checked};
  },device);
  const after=await stat(filenameFull);result.sourceMetadataUnchanged=before.size===after.size&&before.mtimeMs===after.mtimeMs;
  report.real.push(result);await save();console.log('real',device.name,result.rows.map(r=>({kind:r.kind,times:r.phases.map(p=>p.times)})));
 }
 for(const variant of ['reader','small']){const wasm=await readFile(path.join(root,`libtiff-${variant}.wasm`)),js=await readFile(path.join(root,`libtiff-${variant}.mjs`));report.size??={};report.size[variant]={wasm:wasm.length,glue:js.length,wasmGzip:gzipSync(wasm).length,glueGzip:gzipSync(js).length,base64WasmPlusGlue:Math.ceil(wasm.length/3)*4+js.length};}
 const fixture=await page.evaluate(async()=>{const data=await writer.call('make',{codec:8,predictor:3,float:true});let s='';for(const value of new Uint8Array(data.bytes))s+=String.fromCharCode(value);return btoa(s);});
 await writeFile(path.join(root,'offline-fixture.tif'),Buffer.from(fixture,'base64'));
 const factory=(await readFile(path.join(root,'libtiff-reader.mjs'),'utf8')).replace(/export default Module;?\s*$/,'');
 const wasmBase64=(await readFile(path.join(root,'libtiff-reader.wasm'))).toString('base64');
 const worker=(await readFile(path.join(root,'libtiff.worker.mjs'),'utf8')).replace(/const create = \(await import\([^\n]+/,'const create = Module;').replace('module = await create({','module = await create({ wasmBinary: Uint8Array.from(atob("'+wasmBase64+'"),c=>c.charCodeAt(0)),');
 const html='<!doctype html><meta charset="utf-8"><title>Isolated offline libtiff check</title><pre id="output">Running</pre><script>const worker=new Worker(URL.createObjectURL(new Blob(['+JSON.stringify(factory.replaceAll('import.meta.url','self.location.href')+'\n'+worker)+'],{type:"text/javascript"})),{type:"classic"}); let id=0;const pending=new Map();worker.onerror=(error)=>{window.result={error:error.message || "Worker load failed"};};worker.onmessage=({data})=>{const p=pending.get(data.id);pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);};const call=(type,args={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});worker.postMessage({id:key,type,...args});});(async()=>{await call("init");const bytes=Uint8Array.from(atob('+JSON.stringify(fixture)+'),c=>c.charCodeAt(0));await call("open",{file:new File([bytes],"fixture.tif")});const output=await call("window",{x:13,y:29,w:128,h:128});const values=new Float32Array(output.bytes);for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(values[y*128+x]!==((13+x)/1024+(29+y)/2048))throw Error("Offline mismatch");window.result={ok:true,verified:values.length,stats:output.stats};document.querySelector("#output").textContent=JSON.stringify(window.result);})().catch(error=>{window.result={error:String(error)};});</script>';
 const offlinePath=path.join(root,'offline.html');await writeFile(offlinePath,html);
 const offline=await browser.newContext();await offline.setOffline(true);const offlinePage=await offline.newPage();offlinePage.on('pageerror',e=>console.error(e));offlinePage.on('console',m=>console.error(m.text()));await offlinePage.goto(pathToFileURL(offlinePath).href);await offlinePage.waitForFunction(()=>window.result?.ok || window.result?.error);report.offline=await offlinePage.evaluate(()=>window.result);report.offline.htmlBytes=Buffer.byteLength(html);report.offline.gzipBytes=gzipSync(html).length;await offline.close();
 if(!report.offline.ok)throw Error(JSON.stringify(report.offline));
 report.malformed=await page.evaluate(async()=>{try{await reader.call('open',{file:new File([new Uint8Array([73,73,42,0,8,0,0,0])],'truncated.tif')});return {rejected:false};}catch(error){return{rejected:true,error:String(error)};}});
 if(!report.malformed.rejected)throw Error('Truncated input accepted');
 await save();
}finally{await browser.close();await server.close();}



