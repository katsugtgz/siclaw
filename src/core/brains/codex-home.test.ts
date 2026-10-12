import {describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {codexHomeForScope, codexHomeOwnerKey, restoreCodexHomeForSession} from "./codex-home.js";

describe("native Codex storage scope", () => {
  it("shares native storage across conversations only for the same identified owner and Skill scope", () => {
    const scope={agentId:"sre-a",userId:"alice",sessionId:"one",skills:[{name:"diag",filePath:"/skills/diag/SKILL.md"}]};
    const home=codexHomeForScope("/data",scope);
    expect(codexHomeForScope("/data",{...scope,sessionId:"two"})).toBe(home);
    expect(codexHomeForScope("/data",{...scope,userId:"bob"})).not.toBe(home);
    expect(codexHomeForScope("/data",{...scope,agentId:"sre-b"})).not.toBe(home);
    expect(codexHomeForScope("/data",{...scope,skills:[]})).not.toBe(home);
    expect(codexHomeForScope("/data",{...scope,userId:undefined,sessionId:"two"})).not.toBe(
      codexHomeForScope("/data",{...scope,userId:undefined}));
  });
  it("recovers a legacy conversation after Skill withdrawal using owner-verified link metadata", () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-home-restore-"));
    try {
      const owner={agentId:"agent",userId:"alice",sessionId:"one"};
      const skill={name:"diagnose",filePath:path.join(root,"withdrawn","SKILL.md")};
      const home=codexHomeForScope(root,{...owner,skills:[skill]});
      fs.mkdirSync(path.join(home,"skills"),{recursive:true});
      // The withdrawn target may already be gone. Read link metadata only.
      fs.symlinkSync(path.dirname(skill.filePath),path.join(home,"skills",skill.name));
      const saved={rolloutPath:path.join(home,"sessions","rollout.jsonl")};
      expect(restoreCodexHomeForSession(root,owner,saved)).toBe(home);
      expect(codexHomeForScope(root,{...owner,skills:[]})).not.toBe(home);
      expect(()=>restoreCodexHomeForSession(root,{...owner,userId:"bob"},saved)).toThrow(/owner/);
      expect(()=>restoreCodexHomeForSession(root,{...owner,agentId:"other"},saved)).toThrow(/owner/);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  it("stamps the owner and resumes the original home without changing new-conversation scope", () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-home-stamp-"));
    try {
      const owner={agentId:"agent",userId:"alice",sessionId:"one"};
      const home=codexHomeForScope(root,{...owner,skills:[{name:"prior",filePath:"/prior/SKILL.md"}]});
      fs.mkdirSync(home,{recursive:true});
      const saved={home,ownerKey:codexHomeOwnerKey(owner)};
      expect(restoreCodexHomeForSession(root,owner,saved)).toBe(home);
      expect(restoreCodexHomeForSession(root,{...owner,sessionId:"two"},saved)).toBe(home);
      expect(()=>restoreCodexHomeForSession(root,{...owner,userId:"bob"},saved)).toThrow(/different owner/);
      expect(codexHomeForScope(root,{...owner,skills:[]})).not.toBe(home);
      expect(codexHomeOwnerKey({...owner,userId:undefined,sessionId:"one"})).not.toBe(codexHomeOwnerKey({...owner,userId:undefined,sessionId:"two"}));
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  it("rejects redirected and out-of-namespace home metadata without reading targets", () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-home-links-"));
    try {
      const owner={agentId:"agent",userId:"alice",sessionId:"one"};
      const home=codexHomeForScope(root,{...owner,skills:[]});
      fs.mkdirSync(path.dirname(home),{recursive:true});
      const target=path.join(root,"other");fs.mkdirSync(target);
      fs.symlinkSync(target,home,"dir");
      expect(()=>restoreCodexHomeForSession(root,owner,{home,ownerKey:codexHomeOwnerKey(owner)})).toThrow(/redirected/);
      expect(()=>restoreCodexHomeForSession(root,owner,{home:target,ownerKey:codexHomeOwnerKey(owner)})).toThrow(/namespace/);
      expect(restoreCodexHomeForSession(root,owner,{})).toBeUndefined();
      fs.unlinkSync(home);fs.mkdirSync(home);fs.symlinkSync(path.join(root,"missing"),path.join(home,"skills"),"dir");
      expect(()=>restoreCodexHomeForSession(root,owner,{rolloutPath:path.join(home,"sessions","rollout.jsonl")})).toThrow(/projection is redirected/);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
});
