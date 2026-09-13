const express=require("express");
const multer=require("multer");
const fs=require("fs");
const fsp=fs.promises;
const path=require("path");
const crypto=require("crypto");
const {spawn}=require("child_process");
const archiver=require("archiver");
const unzipper=require("unzipper");
const sharp=require("sharp");
const {PDFDocument}=require("pdf-lib");
const {fromPath}=require("pdf2pic");
const { chromium }=require("playwright");

const app=express();
const PORT=process.env.PORT||3000;
const ROOT=path.join(__dirname,"..");
const TMP=path.join(ROOT,"tmp");
const OUT=path.join(ROOT,"output");
fs.mkdirSync(TMP,{recursive:true});fs.mkdirSync(OUT,{recursive:true});

const upload=multer({dest:TMP,limits:{fileSize:100*1024*1024}});
const jobs=new Map();

const registry={
 html:["pdf","apk","zip"],
 pdf:["html","jpg","png"],
 jpg:["png","webp","pdf","jpg"],
 jpeg:["png","webp","pdf","jpg"],
 png:["jpg","webp","pdf","png"],
 webp:["jpg","png","pdf","webp"],
 txt:["pdf","json"],
 json:["txt","csv","json"],
 csv:["json","txt","csv"],
 zip:["html"]
};

app.use(express.json());app.use(express.static(path.join(ROOT,"frontend")));
app.get("/api/formats",(req,res)=>res.json(registry));

function safeName(n){return path.basename(n).replace(/[^a-zA-Z0-9._-]/g,"_")}
function ext(n){let x=path.extname(n).slice(1).toLowerCase();return x==="jpeg"?"jpg":x}
function run(cmd,args,cwd){
 return new Promise((resolve,reject)=>{
  const p=spawn(cmd,args,{cwd,stdio:["ignore","pipe","pipe"]});let out="",err="";
  p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
  p.on("error",reject);p.on("close",c=>c?reject(Error(err||`${cmd} failed (${c})`)):resolve(out));
 });
}
async function zipDir(src,out){
 return new Promise((resolve,reject)=>{
  const output=fs.createWriteStream(out),a=archiver("zip",{zlib:{level:9}});
  output.on("close",resolve);a.on("error",reject);a.pipe(output);a.directory(src,false);a.finalize();
 });
}
async function unzipSafe(src,dest){
 const dir=await unzipper.Open.file(src);
 let total=0;
 for(const e of dir.files){
  const target=path.resolve(dest,e.path);
  if(!target.startsWith(path.resolve(dest)+path.sep))throw Error("Unsafe archive path");
  if(e.type==="File"){total+=e.uncompressedSize||0;if(total>300*1024*1024)throw Error("Extracted archive is too large")}
  await e.stream().pipe(fs.createWriteStream(target,{autoClose:true})); // replaced below by mkdir-aware extraction
 }
}
async function extractSafe(src,dest){
 const dir=await unzipper.Open.file(src);let total=0;
 for(const e of dir.files){
  const target=path.resolve(dest,e.path);if(!target.startsWith(path.resolve(dest)+path.sep))throw Error("Unsafe archive path");
  if(e.type==="Directory"){await fsp.mkdir(target,{recursive:true});continue}
  total+=e.uncompressedSize||0;if(total>300*1024*1024)throw Error("Archive expands beyond limit");
  await fsp.mkdir(path.dirname(target),{recursive:true});
  await new Promise((res,rej)=>e.stream().pipe(fs.createWriteStream(target)).on("finish",res).on("error",rej));
 }
}

async function htmlToPdf(input,out){
 const browser=await chromium.launch({headless:true});const page=await browser.newPage();
 await page.goto('file://'+path.resolve(input),{waitUntil:'networkidle'});await page.pdf({path:out,format:'A4',printBackground:true});await browser.close();
}
async function imageConvert(input,out,target,quality=90){await sharp(input).toFormat(target,{quality:Number(quality)||90}).toFile(out)}
async function imageToPdf(input,out){
 const img=await sharp(input).jpeg().toBuffer({resolveWithObject:true});
 const meta=await sharp(img.data).metadata();const pdf=await PDFDocument.create();
 const jpg=await pdf.embedJpg(img.data);const page=pdf.addPage([meta.width,meta.height]);page.drawImage(jpg,{x:0,y:0,width:meta.width,height:meta.height});
 await fsp.writeFile(out,await pdf.save());
}
async function pdfToImages(input,outDir,target){
 await fsp.mkdir(outDir,{recursive:true});
 const converter=fromPath(input,{density:150,saveFilename:"page",savePath:outDir,format:target});
 await converter.bulk(-1,{responseType:"image"});
}
async function htmlProjectToZip(input,out){
 const dir=path.join(TMP,crypto.randomUUID());await fsp.mkdir(dir,{recursive:true});
 await fsp.copyFile(input,path.join(dir,safeName(path.basename(input))));await zipDir(dir,out);await fsp.rm(dir,{recursive:true,force:true});
}
async function htmlToApk(input,out,opts){
 // Real Android build pipeline. Requires JAVA_HOME, ANDROID_HOME and Gradle/Android SDK.
 const build=path.join(TMP,crypto.randomUUID());await fsp.mkdir(build,{recursive:true});
 const project=path.join(build,"app");await fsp.mkdir(path.join(project,"src/main/assets"),{recursive:true});
 const web=path.join(project,"src/main/assets");await fsp.copyFile(input,path.join(web,"index.html"));
 const appName=opts.app_name||"STRIKE APP",pkg=opts.package_name||"com.example.strikeapp",ver=opts.version_name||"1.0.0";
 const pkgPath=pkg.replace(/\./g,"/");
 await fsp.mkdir(path.join(project,"src/main/java",pkgPath),{recursive:true});
 const settings=`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories{google();mavenCentral()} }\nrootProject.name="StrikeGenerated"; include(":app")`;
 const root=`plugins { id 'com.android.application' version '8.7.3' apply false }`;
 const gradle=`plugins { id 'com.android.application' }\n\nandroid { namespace '${pkg}'; compileSdk 35\n defaultConfig { applicationId '${pkg}'; minSdk 23; targetSdk 35; versionCode 1; versionName '${ver}' }\n}\n`;
 const manifest=`<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/><application android:theme="@style/AppTheme" android:label="${appName}"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>`;
 await fsp.mkdir(path.join(project,"src/main/res/values"),{recursive:true});
 await fsp.writeFile(path.join(build,"settings.gradle"),settings);await fsp.writeFile(path.join(build,"build.gradle"),root);await fsp.writeFile(path.join(project,"build.gradle"),gradle);
 await fsp.writeFile(path.join(project,"src/main/res/values/styles.xml"),`<resources><style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar"/></resources>`);
 await fsp.writeFile(path.join(project,"src/main/AndroidManifest.xml"),manifest);
 const activity=`package ${pkg};\nimport android.app.*;import android.os.*;import android.webkit.*;import android.view.*;\npublic class MainActivity extends Activity{public void onCreate(Bundle b){super.onCreate(b);WebView w=new WebView(this);w.getSettings().setJavaScriptEnabled(true);w.getSettings().setDomStorageEnabled(true);w.loadUrl("file:///android_asset/index.html");setContentView(w);}}`;
 await fsp.writeFile(path.join(project,"src/main/java",pkgPath,"MainActivity.java"),activity);
 await run(process.platform==="win32"?"gradlew.bat":"./gradlew",["assembleDebug"],build);
 const built=path.join(project,"build/outputs/apk/debug/app-debug.apk");await fsp.copyFile(built,out);await fsp.rm(build,{recursive:true,force:true});
}
async function apkRecover(input,out){
 const dir=path.join(TMP,crypto.randomUUID());await fsp.mkdir(dir,{recursive:true});await extractSafe(input,dir);
 const hits=[];
 async function walk(d){for(const x of await fsp.readdir(d,{withFileTypes:true})){const p=path.join(d,x.name);if(x.isDirectory())await walk(p);else if(/\.(html?|css|js)$/i.test(x.name))hits.push(p)}}
 await walk(dir);
 if(!hits.length){await fsp.writeFile(out,`APK ANALYSIS REPORT\n\nNo recoverable HTML/CSS/JavaScript source was found in this APK.\nA native APK cannot be reconstructed into its original HTML source when those web assets are not present.\n`);return}
 const rec=path.join(TMP,crypto.randomUUID());await fsp.mkdir(rec,{recursive:true});
 for(const h of hits){const rel=path.relative(dir,h);const dest=path.join(rec,rel);await fsp.mkdir(path.dirname(dest),{recursive:true});await fsp.copyFile(h,dest)}
 await zipDir(rec,out);await fsp.rm(dir,{recursive:true,force:true});await fsp.rm(rec,{recursive:true,force:true});
}
async function convert(job){
 const j=jobs.get(job.id),s=j.source,t=j.target,input=j.input,work=j.work;let outBase="result";
 try{
  j.status="processing";j.progress=15;j.message="Validating input…";
  if(!registry[s]||!registry[s].includes(t))throw Error(`Unsupported conversion: ${s} → ${t}`);
  let out;
  if(s==="html"&&t==="pdf"){out=path.join(work,"result.pdf");j.progress=35;j.message="Rendering HTML to PDF…";await htmlToPdf(input,out)}
  else if(s==="html"&&t==="apk"){out=path.join(work,"result.apk");j.progress=25;j.message="Building Android project…";await htmlToApk(input,out,j.options)}
  else if(s==="html"&&t==="zip"){out=path.join(work,"website.zip");j.progress=60;j.message="Packaging project…";await htmlProjectToZip(input,out)}
  else if(s==="apk"&&t==="html"){out=path.join(work,"recovered-web-project.zip");j.progress=35;j.message="Analyzing APK and recovering web assets…";await apkRecover(input,out)}
  else if(["jpg","png","webp"].includes(s)&&["jpg","png","webp"].includes(t)){out=path.join(work,`result.${t}`);j.progress=55;j.message="Re-encoding image…";await imageConvert(input,out,t,j.options.quality)}
  else if(["jpg","png"].includes(s)&&t==="pdf"){out=path.join(work,"result.pdf");j.progress=55;j.message="Creating PDF…";await imageToPdf(input,out)}
  else if(s==="pdf"&&["jpg","png"].includes(t)){out=path.join(work,`pages.${t}`);j.progress=55;j.message="Rendering PDF pages…";await pdfToImages(input,work,t);out=path.join(work,"pages.zip");await zipDir(work,out)}
  else if(s==="json"&&t==="txt"){out=path.join(work,"result.txt");const x=JSON.parse(await fsp.readFile(input,"utf8"));await fsp.writeFile(out,JSON.stringify(x,null,2))}
  else if(s==="txt"&&t==="json"){out=path.join(work,"result.json");const x=await fsp.readFile(input,"utf8");JSON.parse(x);await fsp.writeFile(out,x)}
  else if(s==="csv"&&t==="json"){out=path.join(work,"result.json");const lines=(await fsp.readFile(input,"utf8")).split(/\r?\n/).filter(Boolean);const h=lines.shift().split(",");const rows=lines.map(l=>{const v=l.split(",");return Object.fromEntries(h.map((k,i)=>[k,v[i]??""]))});await fsp.writeFile(out,JSON.stringify(rows,null,2))}
  else throw Error("Engine not implemented for this pair yet.");
  const st=await fsp.stat(out);if(st.size===0)throw Error("Output validation failed: empty output");
  const final=path.join(OUT,job.id+"-"+path.basename(out));await fsp.copyFile(out,final);
  j.output=final;j.filename=path.basename(final);j.status="completed";j.progress=100;j.message="Conversion completed and output validated.";
 }catch(e){j.status="failed";j.error=e.message;j.message="Conversion failed.";j.progress=0}
}
app.post("/api/convert",upload.single("file"),async(req,res)=>{
 try{
  if(!req.file)return res.status(400).json({error:"No file uploaded"});
  const source=String(req.body.source||ext(req.file.originalname)),target=String(req.body.target||"").toLowerCase();
  const id=crypto.randomUUID(),work=path.join(TMP,id);await fsp.mkdir(work,{recursive:true});
  const job={id,source,target,input:req.file.path,work,status:"queued",progress:5,message:"Job queued",options:JSON.parse(req.body.options||"{}")};jobs.set(id,job);
  convert(job).finally(()=>{setTimeout(()=>fsp.rm(work,{recursive:true,force:true}).catch(()=>{}),30*60*1000)});
  res.json({jobId:id});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/jobs/:id",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json({jobId:j.id,status:j.status,progress:j.progress,message:j.message,error:j.error,source:j.source,target:j.target,filename:j.filename})});
app.get("/api/jobs/:id/download",async(req,res)=>{const j=jobs.get(req.params.id);if(!j||j.status!=="completed"||!j.output)return res.status(404).send("Output unavailable");res.download(j.output,j.filename)});
app.listen(PORT,()=>console.log(`STRIKE Converter running on http://localhost:${PORT}`));
