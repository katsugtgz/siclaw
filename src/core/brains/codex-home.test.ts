import {describe,it,expect} from "vitest";
import {codexHomeForScope} from "./codex-home.js";

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
});
