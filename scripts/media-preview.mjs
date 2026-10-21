// Isolated, mock-only media fixtures. No native messages or mail are sent.
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {startPreview} from './preview.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,checksum]);}
function picture(which){
  const w=320,h=200,row=w*3+1,raw=Buffer.alloc(row*h,255);for(let y=0;y<h;y++){raw[y*row]=0;for(let x=0;x<w;x++){
    let color=[255,255,255];
    if(which===0){if((x-85)**2+(y-100)**2<=45**2)color=[230,40,40];if(x>=185&&x<265&&y>=60&&y<140)color=[30,90,220];}
    else{if(x>=40&&x<120&&y>=65&&y<135)color=[250,200,30];if(y>=45&&y<150&&Math.abs(x-225)<(y-45)*0.48)color=[30,170,80];}
    for(let channel=0;channel<3;channel++)raw[y*row+1+x*3+channel]=color[channel];
  }}
  const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const service=await startPreview({dataDir:path.join(root,'data-dev','media-preview'),port:Number(process.env.RELAY_PORT||4327)});
try{
  if(!service.store.get('mediaPreviewSeeded',false)){
    for(const side of ['codex','deepseek'])service.relay.confirmImageCapability({side,sessionId:service.relay.sessionId(side),supportsImages:true});
    const images=[];for(let i=0;i<2;i++)images.push(await service.images.upload({dataUrl:'data:image/png;base64,'+picture(i).toString('base64')}));
    const message=service.relay.sendMessage({text:'请逐张描述图里的颜色、形状和左右位置。',imageIds:images.map(image=>image.id)});
    service.store.addMessage({sender:'codex',text:'',replyTo:message.id,rootId:message.rootId,meta:{silent:true,control:'no-reply',fixture:true}});
    service.store.set('mediaPreviewSeeded',true);service.store.set('mediaPreviewImageIds',images.map(image=>image.id));
  }
  const report={url:'http://127.0.0.1:'+service.server.address().port,mockOnly:true,capabilityDeclarations:'mock fixtures, not production verification',images:service.store.get('mediaPreviewImageIds',[]).map(imageId=>service.images.describe(imageId)),rooms:service.store.rooms().map(room=>({id:room.id,title:room.title,archived:room.archived}))};
  await writeFile(path.join(service.dataDir,'fixtures.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));
}catch(error){await service.close();throw error;}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void service.close().then(()=>process.exit(0)));
