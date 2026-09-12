import * as THREE from './vendor/three.module.js';

// A depth-tested renderer for this untextured logo. It uses the actual mesh,
// camera and material so a lost GPU context does not end the 3D interaction.
export function drawingSize(width,height,pixelRatio=1,software=false){
 width=Math.max(1,width);height=Math.max(1,height);
 const budget=software?900000:1800000,edge=software?1500:2048;
 const ratio=Math.min(Math.max(.25,pixelRatio),software?1.25:1.5,Math.sqrt(budget/(width*height)),edge/Math.max(width,height));
 return [Math.max(1,Math.floor(width*ratio)),Math.max(1,Math.floor(height*ratio))];
}

export class SoftwareLogoRenderer{
 constructor(canvas=document.createElement('canvas')){
  this.domElement=canvas;this.isSoftware=true;
  this.context=canvas.getContext('2d',{alpha:true});
  if(!this.context)throw Error('Canvas 2D is unavailable');
  this.width=0;this.height=0;this.cache=new WeakMap();
  this.matrix=new THREE.Matrix4();this.normalMatrix=new THREE.Matrix3();
  this.viewProjection=new THREE.Matrix4();this.vector=new THREE.Vector3();
  this.lights=[[.45,.6,1],[-1,.25,.4],[.6,.4,-1],[-.7,-.3,-1]].map(p=>new THREE.Vector3(...p).normalize());
 }
 setSize(width,height){
  if(width===this.width&&height===this.height)return;
  this.width=width;this.height=height;this.domElement.width=width;this.domElement.height=height;
  this.image=this.context.createImageData(width,height);
  // Four subpixel samples per output pixel, resolved with premultiplied alpha.
  // These buffers live in CPU memory and do not allocate a second GPU context.
  this.sampleWidth=width*2;this.sampleHeight=height*2;
  this.samplePixels=new Uint8ClampedArray(width*height*16);
  this.depthBuffer=new Float32Array(width*height*4);
 }
 render(scene,camera){
  if(!this.image)return;
  const width=this.sampleWidth,height=this.sampleHeight,pixels=this.samplePixels,zbuffer=this.depthBuffer;
  pixels.fill(0);zbuffer.fill(Infinity);
  scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
  this.viewProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  scene.traverse(mesh=>{
   if(!mesh.isMesh||!mesh.visible)return;
   const geometry=mesh.geometry,position=geometry.attributes.position,normal=geometry.attributes.normal,index=geometry.index;
   if(!position||!index)return;
   let cached=this.cache.get(geometry);
   if(!cached){cached={projected:new Float64Array(position.count*4),colors:new Float32Array(position.count*3)};this.cache.set(geometry,cached);}
   const {projected,colors}=cached;
   this.matrix.multiplyMatrices(this.viewProjection,mesh.matrixWorld);this.normalMatrix.getNormalMatrix(mesh.matrixWorld);
   const m=this.matrix.elements;
   const material=mesh.material,base=[material.color.r,material.color.g,material.color.b];
   const lightingKey=[...this.normalMatrix.elements,...base].join(',');
   const updateLighting=cached.lightingKey!==lightingKey;cached.lightingKey=lightingKey;
   for(let i=0;i<position.count;i++){
    const x=position.getX(i),y=position.getY(i),z=position.getZ(i),w=m[3]*x+m[7]*y+m[11]*z+m[15],o=i*4;
    projected[o]=((m[0]*x+m[4]*y+m[8]*z+m[12])/w*.5+.5)*width;
    projected[o+1]=(.5-(m[1]*x+m[5]*y+m[9]*z+m[13])/w*.5)*height;
    projected[o+2]=(m[2]*x+m[6]*y+m[10]*z+m[14])/w;projected[o+3]=w;
    if(!updateLighting)continue;
    this.vector.fromBufferAttribute(normal,i).applyMatrix3(this.normalMatrix).normalize();
    let lighting=.6+.2*Math.max(0,this.vector.y);
    for(const light of this.lights)lighting+=.45*Math.max(0,this.vector.dot(light));
    for(let channel=0;channel<3;channel++){
     const linear=base[channel]*lighting*1.5;
     const mapped=Math.max(0,Math.min(1,(linear*(2.51*linear+.03))/(linear*(2.43*linear+.59)+.14)));
     colors[i*3+channel]=255*(mapped<=.0031308?12.92*mapped:1.055*mapped**(1/2.4)-.055);
    }
   }
   for(let t=0;t<index.count;t+=3){
    const ia=index.getX(t),ib=index.getX(t+1),ic=index.getX(t+2),a=ia*4,b=ib*4,c=ic*4;
    if(projected[a+3]<=0||projected[b+3]<=0||projected[c+3]<=0)continue;
    const ax=projected[a],ay=projected[a+1],az=projected[a+2],bx=projected[b],by=projected[b+1],bz=projected[b+2],cx=projected[c],cy=projected[c+1],cz=projected[c+2];
    const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    if(area>=-1e-9)continue; // same outward-face culling as the WebGL material
    const left=Math.max(0,Math.floor(Math.min(ax,bx,cx))),right=Math.min(width-1,Math.ceil(Math.max(ax,bx,cx)));
    const top=Math.max(0,Math.floor(Math.min(ay,by,cy))),bottom=Math.min(height-1,Math.ceil(Math.max(ay,by,cy)));
    if(left>right||top>bottom)continue;
    const ca=ia*3,cb=ib*3,cc=ic*3;
    const flat=Math.abs(colors[ca]-colors[cb])+Math.abs(colors[ca]-colors[cc])+Math.abs(colors[ca+1]-colors[cb+1])+Math.abs(colors[ca+1]-colors[cc+1])<.01;
    const inv=1/area,dx0=(by-cy)*inv,dy0=(cx-bx)*inv,dx1=(cy-ay)*inv,dy1=(ax-cx)*inv;
    const px=left+.5,py=top+.5;
    let row0=((bx-px)*(cy-py)-(by-py)*(cx-px))*inv;
    let row1=((cx-px)*(ay-py)-(cy-py)*(ax-px))*inv;
    for(let y=top;y<=bottom;y++,row0+=dy0,row1+=dy1){
     // Intersect barycentric half-planes once per scanline. Thin triangles no
     // longer scan an enormous empty bounding rectangle at supersampled sizes.
     let begin=0,end=right-left;
     if(dx0>1e-14)begin=Math.max(begin,Math.ceil((-.000001-row0)/dx0));
     else if(dx0< -1e-14)end=Math.min(end,Math.floor((-.000001-row0)/dx0));
     else if(row0<-.000001)continue;
     if(dx1>1e-14)begin=Math.max(begin,Math.ceil((-.000001-row1)/dx1));
     else if(dx1< -1e-14)end=Math.min(end,Math.floor((-.000001-row1)/dx1));
     else if(row1<-.000001)continue;
     const dx2=-dx0-dx1,row2=1-row0-row1;
     if(dx2>1e-14)begin=Math.max(begin,Math.ceil((-.000001-row2)/dx2));
     else if(dx2< -1e-14)end=Math.min(end,Math.floor((-.000001-row2)/dx2));
     else if(row2<-.000001)continue;
     if(begin>end)continue;
     let w0=row0+dx0*begin,w1=row1+dx1*begin,offset=y*width+left+begin;
     for(let x=begin;x<=end;x++,w0+=dx0,w1+=dx1,offset++){
      const w2=1-w0-w1;if(w0<-.000001||w1<-.000001||w2<-.000001)continue;
      const z=w0*az+w1*bz+w2*cz;if(z< -1||z>1||z>=zbuffer[offset])continue;
      zbuffer[offset]=z;const o=offset*4;
      if(flat){pixels[o]=colors[ca];pixels[o+1]=colors[ca+1];pixels[o+2]=colors[ca+2];}
      else{
       const pa=w0/projected[a+3],pb=w1/projected[b+3],pc=w2/projected[c+3],sum=pa+pb+pc;
       for(let k=0;k<3;k++)pixels[o+k]=(pa*colors[ca+k]+pb*colors[cb+k]+pc*colors[cc+k])/sum;
      }
      pixels[o+3]=255;
     }
    }
   }
  });
  const output=this.image.data;
  for(let y=0;y<this.height;y++)for(let x=0;x<this.width;x++){
   const a=(y*2*width+x*2)*4,b=a+4,c=a+width*4,d=c+4,o=(y*this.width+x)*4;
   const alpha=pixels[a+3]+pixels[b+3]+pixels[c+3]+pixels[d+3];
   output[o+3]=Math.round(alpha/4);
   if(!alpha){output[o]=output[o+1]=output[o+2]=0;continue;}
   const covered=alpha/255;
   for(let k=0;k<3;k++)output[o+k]=(pixels[a+k]+pixels[b+k]+pixels[c+k]+pixels[d+k])/covered;
  }
  this.context.putImageData(this.image,0,0);
 }
 dispose(){this.image=null;this.samplePixels=null;this.depthBuffer=null;this.cache=new WeakMap();}
}
