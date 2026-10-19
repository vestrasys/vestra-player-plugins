const fs = require('node:fs');
const path = require('node:path');
const ts = require('/tmp/vestra-rebuild-toolchain-20261018/node_modules/typescript');
const out=path.join(__dirname,'dist');fs.mkdirSync(out,{recursive:true});
for(const name of ['main','extractor','playback']) {
 const sourcePath=path.join(__dirname,'src',name+'.ts');
 const source=fs.readFileSync(fs.existsSync(sourcePath)?sourcePath:path.join(__dirname,name+'.ts'),'utf8');
 const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,strict:true},fileName:name+'.ts',reportDiagnostics:true});
 const errors=(result.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error);
 if(errors.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>__dirname,getNewLine:()=> '\n'}));
 fs.writeFileSync(path.join(out,name+'.js'),result.outputText);
}
