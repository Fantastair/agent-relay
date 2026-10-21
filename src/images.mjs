import {mkdir,writeFile,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {id,RelayError} from './util.mjs';

export const MAX_IMAGE_BYTES=1024*1024;
const validId=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fail=()=>{throw new RelayError('图片格式无效，仅支持 PNG、JPEG、WebP','input');};
export function imageDimensions(bytes,mime){
  let w,h;
  if(mime==='image/png'){
    if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR'||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND')fail();
    w=bytes.readUInt32BE(16);h=bytes.readUInt32BE(20);
  }else if(mime==='image/jpeg'){
    if(bytes.length<12||bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)fail();
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==255)fail();while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;
      if(offset+2>bytes.length)fail();const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)fail();
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(length<8)fail();h=bytes.readUInt16BE(offset+3);w=bytes.readUInt16BE(offset+5);break;}
      offset+=length;
    }
  }else if(mime==='image/webp'){
    if(bytes.length<30||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||bytes.readUInt32LE(4)+8!==bytes.length)fail();
    const type=bytes.toString('ascii',12,16),size=bytes.readUInt32LE(16);if(size+20>bytes.length)fail();
    if(type==='VP8X'&&size>=10){w=bytes.readUIntLE(24,3)+1;h=bytes.readUIntLE(27,3)+1;}
    else if(type==='VP8L'&&size>=5&&bytes[20]===47){const bits=bytes.readUInt32LE(21);w=(bits&16383)+1;h=((bits>>>14)&16383)+1;}
    else if(type==='VP8 '&&size>=10&&bytes.subarray(23,26).equals(Buffer.from([157,1,42]))){w=bytes.readUInt16LE(26)&16383;h=bytes.readUInt16LE(28)&16383;}
    else fail();
  }else fail();
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>16000||h>16000||w*h>20000000)throw new RelayError('图片尺寸无效或超过2000万像素','input');
  return {w,h};
}

export class ImageStore{
  constructor(store,dataDir){this.store=store;this.directory=path.resolve(dataDir,'images');}
  describe(imageId){
    if(!validId(imageId))throw new RelayError('图片 ID 无效','input');
    const image=this.store.image(imageId);if(!image)throw new RelayError('图片不存在，请重新上传','input');
    if(!new RegExp(`^${imageId}\\.(?:png|jpg|webp)$`).test(image.filename))throw new RelayError('图片存储记录无效','input');
    const {filename,...metadata}=image;return {...metadata,path:path.join(this.directory,filename),url:'/api/image/'+imageId};
  }
  async upload({dataUrl}={}){
    if(typeof dataUrl!=='string'||dataUrl.length>Math.ceil(MAX_IMAGE_BYTES/3)*4+100)throw new RelayError('单张图片不超过1 MiB','input');
    const match=dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);if(!match)fail();
    const mime=match[1],bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==match[2])throw new RelayError('图片数据无效或超过1 MiB','input');
    const dimensions=imageDimensions(bytes,mime),imageId=id(),filename=imageId+'.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime]);
    await mkdir(this.directory,{recursive:true});await writeFile(path.join(this.directory,filename),bytes,{flag:'wx',mode:0o600});
    this.store.addImage({id:imageId,filename,mime,bytes:bytes.length,...dimensions,sha256:createHash('sha256').update(bytes).digest('hex')});
    return this.describe(imageId);
  }
  async read(imageId){
    const image=this.describe(imageId);let stat,bytes;
    try{stat=await lstat(image.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==image.bytes)throw new Error('invalid file');bytes=await readFile(image.path);}catch{throw new RelayError('图片文件不可读取，请重新上传','input');}
    if(createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw new RelayError('图片文件已变化，请重新上传','input');
    return {image,bytes};
  }
}
