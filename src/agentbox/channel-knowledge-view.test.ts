import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,expect,it} from "vitest";
import {createChannelKnowledgeView,disposeChannelKnowledgeView} from "./channel-knowledge-view.js";
import type {ChannelExecutionPolicy} from "../shared/channel-execution-policy.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const policy:ChannelExecutionPolicy={version:1,revision:"r1",fingerprint:"a".repeat(64),operations:["knowledge"],namespaces:[],mcp:[],knowledgeIds:["one"],reports:false,attachments:false};
it("materializes only selected repository bytes and a filtered root index",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"channel-kb-test-"));roots.push(root);
  for(const id of ["one","two"]){fs.mkdirSync(path.join(root,"repos",id),{recursive:true});fs.writeFileSync(path.join(root,"repos",id,"INDEX.md"),`CONTENT-${id}`);}
  fs.writeFileSync(path.join(root,"INDEX.md"),"PRIVATE-OTHER-ROOT-INDEX");fs.writeFileSync(path.join(root,".citation-manifest.json"),JSON.stringify({version:1,repos:[{id:"one",root:"repos/one"},{id:"two",root:"repos/two"}]}));
  const view=createChannelKnowledgeView(root,policy);roots.push(view);
  expect(fs.existsSync(path.join(view,"repos","two"))).toBe(false);expect(fs.readFileSync(path.join(view,"index.md"),"utf8")).not.toContain("PRIVATE");expect(fs.readFileSync(path.join(view,"repos","one","INDEX.md"),"utf8")).toBe("CONTENT-one");
});
it("preserves selected citation sidecars and only cleans views owned by this process",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"channel-kb-test-"));roots.push(root);
  fs.mkdirSync(path.join(root,"repos","one"),{recursive:true});
  for(const name of ["index.md",".okf-routes.json",".library-introduction.json",".private-config"])
    fs.writeFileSync(path.join(root,"repos","one",name),name);
  const sources=[{resource:"page",title:"selected",url:"https://example.test/selected"}];
  fs.writeFileSync(path.join(root,".citation-manifest.json"),JSON.stringify({version:1,repos:[{id:"one",root:"repos/one",sources,verifiedRoutes:true}]}));
  const view=createChannelKnowledgeView(root,policy);roots.push(view);
  expect(fs.existsSync(path.join(view,"repos","one",".okf-routes.json"))).toBe(true);
  expect(fs.existsSync(path.join(view,"repos","one",".private-config"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(view,".citation-manifest.json"),"utf8")).repos[0].sources).toEqual(sources);
  disposeChannelKnowledgeView(root);expect(fs.existsSync(root)).toBe(true);
  disposeChannelKnowledgeView(view);disposeChannelKnowledgeView(view);expect(fs.existsSync(view)).toBe(false);
});
it("refuses ambiguous mounts and never falls back to the whole Agent knowledge",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"channel-kb-test-"));roots.push(root);
  expect(()=>createChannelKnowledgeView(root,policy)).toThrow();
  fs.writeFileSync(path.join(root,".citation-manifest.json"),JSON.stringify({repos:[{id:"one",root:""},{id:"two",root:"repos/two"}]}));expect(()=>createChannelKnowledgeView(root,policy)).toThrow();
});
