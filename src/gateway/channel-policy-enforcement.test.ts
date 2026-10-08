import { describe,expect,it,vi } from "vitest";
import { ExecutionGrantRegistry,stillCovers } from "./execution-grants.js";
import { NativeMcpAuthorization } from "./mcp-authorization.js";
import { mcpConfigurationDigest } from "../shared/mcp-authorization.js";
import { parseChannelExecutionPolicy,type ChannelExecutionPolicy } from "../shared/channel-execution-policy.js";

const policy:ChannelExecutionPolicy={version:1,revision:"a:1:g:1",fingerprint:"a".repeat(64),operations:["query","mcp"],namespaces:["allowed"],
  mcp:[{serverId:"mcp-id",tools:["list_pods"],resources:[],prompts:[],arguments:{namespace:["allowed"]}}],knowledgeIds:[],reports:false,attachments:false};
describe("channel execution policy authority",()=>{
  it("freezes every nested selector and refuses malformed or write authority",()=>{
    const parsed=parseChannelExecutionPolicy(policy)!;expect(Object.isFrozen(parsed.namespaces)).toBe(true);expect(Object.isFrozen(parsed.mcp[0].arguments)).toBe(true);
    expect(()=>parseChannelExecutionPolicy({...policy,operations:["write"]})).toThrow();expect(()=>parseChannelExecutionPolicy({...policy,namespaces:["*"]})).toThrow();
  });
  it("changes scope/revision by issuing a different grant and revokes old holders",async()=>{
    let current={clusters:["cluster"],hosts:[],policy};
    const registry=new ExecutionGrantRegistry(async()=>current);
    const first=await registry.open("a","s",{kind:"binding",id:"group"},{userId:"alice",openId:"oa"});
    current={...current,policy:{...policy,fingerprint:"b".repeat(64),namespaces:["other"]}};
    expect((await registry.renew(first.grantId,"a")).ok).toBe(false);
    const next=await registry.open("a","s",{kind:"binding",id:"group"},{userId:"bob",openId:"ob"});
    expect(next.grantId).not.toBe(first.grantId);expect(first.sender?.userId).toBe("alice");
    expect(stillCovers(first.resources,next.resources)).toBe(false);
  });
  it("uses the original sender for every renewal, not the later speaker",async()=>{
    const resolve=vi.fn(async()=>({clusters:[],hosts:[],policy}));const registry=new ExecutionGrantRegistry(resolve);
    const alice=await registry.open("a","s",{kind:"binding",id:"g"},{userId:"alice",openId:"oa"});
    await registry.open("a","s",{kind:"binding",id:"g"},{userId:"bob",openId:"ob"});
    await registry.renew(alice.grantId,"a");expect(resolve.mock.calls.at(-1)?.[3]).toEqual({userId:"alice",openId:"oa"});
  });
  it("authorizes only selected MCP tools, exact argument scopes and a fresh policy",async()=>{
    let activeFingerprint=policy.fingerprint;
    const config={transport:"streamable-http" as const,url:"https://mcp.invalid",siclawId:"mcp-id",headers:{Authorization:"Bearer MCP-CANARY"},env:{SICLAW_MCP_OPERATION_POLICY:JSON.stringify({version:1,tools:{list_pods:{effect:"read"},other:{effect:"read"}}})}};
    const registry=new ExecutionGrantRegistry(async()=>({clusters:[],hosts:[],policy}));
    const grant=await registry.open("a","s",{kind:"binding",id:"g"},{userId:"alice",openId:"oa"});
    const request=vi.fn(async(method:string)=>method==="config.getResources"?{mcp_server_ids:["mcp-id"]}:method==="config.getMcpServers"?{mcpServers:{test:config}}:{policy:{...policy,fingerprint:activeFingerprint}});
    const auth=new NativeMcpAuthorization({request},()=>"wrong-latest-speaker",()=>grant);
    const op={server:"test",kind:"tool" as const,name:"list_pods",callId:"call",arguments:{namespace:"allowed"},configurationDigest:mcpConfigurationDigest(config)};
    const permit=await auth.authorize({agentId:"a",orgId:"o",boxId:"b"},"s",op,new AbortController().signal,grant.grantId);
    expect(permit.userId).toBe("alice");expect(JSON.stringify(permit)).not.toContain("MCP-CANARY");
    await expect(auth.authorize({agentId:"a"} as any,"s",{...op,arguments:{namespace:"other"}},new AbortController().signal,grant.grantId)).rejects.toThrow();
    await expect(auth.authorize({agentId:"a"} as any,"s",{...op,name:"other"},new AbortController().signal,grant.grantId)).rejects.toThrow();
    activeFingerprint="c".repeat(64);await expect(auth.authorize({agentId:"a"} as any,"s",op,new AbortController().signal,grant.grantId)).rejects.toThrow();
  });
});
