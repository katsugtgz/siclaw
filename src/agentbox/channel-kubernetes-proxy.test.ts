import { afterEach, describe, expect, it, vi } from "vitest";
import { Exec } from "@kubernetes/client-node";
import http from "node:http";
import https from "node:https";
import { load } from "js-yaml";
import { authorizeChannelKubernetesRequest, ChannelKubernetesProxy } from "./channel-kubernetes-proxy.js";
import type { ChannelExecutionPolicy } from "../shared/channel-execution-policy.js";

const policy:ChannelExecutionPolicy={version:1,revision:"test:1",fingerprint:"a".repeat(64),operations:["query","logs","pod_exec"],namespaces:["allowed"],mcp:[],knowledgeIds:[],reports:false,attachments:false};
const owned: Array<()=>void>=[];
function scopedFetch(url:string,options:{headers:Record<string,string>},scoped:any):Promise<Response>{
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:options.headers,ca:Buffer.from(scoped.clusters[0].cluster["certificate-authority-data"],"base64")},res=>{
      const chunks:Buffer[]=[];res.on("data",data=>chunks.push(Buffer.from(data)));res.once("error",reject);
      res.once("end",()=>{const headers=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i],res.rawHeaders[i+1]);resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers}));});
    });req.once("error",reject);
  });
}
afterEach(()=>{for(const cleanup of owned.splice(0))cleanup();vi.restoreAllMocks();});
describe("channel Kubernetes API boundary",()=>{
  it.each([
    ["GET","/api?timeout=32s","discovery"],
    ["GET","/apis/apps/v1/namespaces/allowed/deployments","query"],
    ["GET","/api/v1/namespaces/allowed/pods/p/log?follow=true","logs"],
    ["GET","/api/v1/namespaces/allowed/pods/p/exec?command=uname&stdout=true","pod_exec"],
  ])("permits only scoped %s %s",(method,path,scope)=>expect(authorizeChannelKubernetesRequest(method,path,policy)).toBe(scope));
  it.each([
    ["GET","/api/v1/pods"], ["GET","/api/v1/namespaces/other/pods"],
    ["GET","/api/v1/namespaces/allowed/secrets"], ["GET","/api/v1/namespaces/allowed/serviceaccounts/default/token"],
    ["POST","/api/v1/namespaces/allowed/pods"], ["DELETE","/api/v1/namespaces/allowed/pods/p"],
    ["GET","/api/v1/nodes/n/proxy"], ["GET","/api/v1/namespaces/allowed/pods/p/attach"],
    ["GET","/api/v1/namespaces/allowed/pods/p/exec?command=rm&command=-rf&command=/"],
    ["GET","/api/v1/namespaces/allowed/pods/p/exec?command=bash&command=-s&stdin=true"],
    ["GET","/api/v1/namespaces/allowed/pods/p/exec?command=uname&tty=true"],
    ["GET","/api/v1/namespaces/allowed/pods?watch=true"],
    ["GET","//evil.test/api/v1/namespaces/allowed/pods"],
    ["GET","/api/v1/namespaces/allowed%2F..%2Fother/pods"],
  ])("rejects %s %s before network access",(method,path)=>expect(()=>authorizeChannelKubernetesRequest(method,path,policy)).toThrow());

  it("closes every namespace when none is selected",()=>{
    expect(()=>authorizeChannelKubernetesRequest("GET","/api/v1/namespaces/allowed/pods",{...policy,namespaces:[]})).toThrow();
  });

  it("replaces real credentials, rejects other namespaces and stops on revocation",async()=>{
    const paths:string[]=[];let auth="";let live=true;
    const upstream=http.createServer((req,res)=>{paths.push(req.url!);auth=String(req.headers.authorization);res.setHeader("set-cookie","upstream-auth-secret");res.end('{"kind":"PodList","items":[]}');});
    await new Promise<void>(r=>upstream.listen(0,"127.0.0.1",r));owned.push(()=>upstream.closeAllConnections(),()=>upstream.close());
    const addr=upstream.address() as {port:number};
    const proxy=new ChannelKubernetesProxy(policy,async()=>{if(!live)throw new Error("revoked");});owned.push(()=>proxy.dispose());
    const config=await proxy.configure(JSON.stringify({apiVersion:"v1",kind:"Config","current-context":"real",clusters:[{name:"real",cluster:{server:`http://127.0.0.1:${addr.port}`,"insecure-skip-tls-verify":true}}],contexts:[{name:"real",context:{cluster:"real",user:"real"}}],users:[{name:"real",user:{token:"REAL-UPSTREAM-CREDENTIAL-CANARY"}}]}));
    expect(config).not.toContain("REAL-UPSTREAM-CREDENTIAL-CANARY");
    const scoped=load(config) as any;const base=scoped.clusters[0].cluster.server;const headers={authorization:`Bearer ${scoped.users[0].user.token}`};
    expect((await scopedFetch(base+"/api/v1/namespaces/other/pods",{headers},scoped)).status).toBe(403);
    expect(paths).toEqual([]);
    const good=await scopedFetch(base+"/api/v1/namespaces/allowed/pods",{headers},scoped);expect(good.status).toBe(200);await good.text();
    expect(good.headers.get("set-cookie")).toBeNull();expect(auth).toBe("Bearer REAL-UPSTREAM-CREDENTIAL-CANARY");
    live=false;expect((await scopedFetch(base+"/api/v1/namespaces/allowed/pods",{headers},scoped)).status).toBe(403);expect(paths).toHaveLength(1);
  });

  it("log-only bootstrap cannot disclose Pod environment or volumes",async()=>{
    const upstream=http.createServer((_req,res)=>res.end(JSON.stringify({apiVersion:"v1",kind:"Pod",metadata:{name:"p",namespace:"allowed",annotations:{secret:"hidden"}},spec:{containers:[{name:"c",env:[{name:"PASSWORD",value:"POD-ENV-CANARY"}]}],volumes:[{secret:{secretName:"hidden"}}]},status:{phase:"Running"}})));
    await new Promise<void>(r=>upstream.listen(0,"127.0.0.1",r));owned.push(()=>upstream.closeAllConnections(),()=>upstream.close());
    const proxy=new ChannelKubernetesProxy({...policy,operations:["logs"]},async()=>{});owned.push(()=>proxy.dispose());
    const scoped=load(await proxy.configure(JSON.stringify({apiVersion:"v1",kind:"Config","current-context":"real",clusters:[{name:"real",cluster:{server:`http://127.0.0.1:${(upstream.address() as any).port}`,"insecure-skip-tls-verify":true}}],contexts:[{name:"real",context:{cluster:"real",user:"real"}}],users:[{name:"real",user:{token:"real"}}]}))) as any;
    const response=await scopedFetch(scoped.clusters[0].cluster.server+"/api/v1/namespaces/allowed/pods/p",{headers:{authorization:`Bearer ${scoped.users[0].user.token}`}},scoped);
    const text=await response.text();expect(response.status).toBe(200);expect(text).not.toContain("CANARY");expect(text).not.toContain("volumes");expect(JSON.parse(text).spec.containers).toEqual([{name:"c"}]);
  });

  it("admits only the registered platform wrapper and kills its owned process on revoke",async()=>{
    const paths:string[]=[];
    const upstream=http.createServer((req,res)=>{paths.push(req.url!);res.end("ok");});
    await new Promise<void>(resolve=>upstream.listen(0,"127.0.0.1",resolve));owned.push(()=>upstream.closeAllConnections(),()=>upstream.close());
    const proxy=new ChannelKubernetesProxy({...policy,operations:["scripts"]},async()=>{});
    owned.push(()=>proxy.dispose());
    const scoped=load(await proxy.configure(JSON.stringify({apiVersion:"v1",kind:"Config","current-context":"real",clusters:[{name:"real",cluster:{server:`http://127.0.0.1:${(upstream.address() as any).port}`,"insecure-skip-tls-verify":true}}],contexts:[{name:"real",context:{cluster:"real",user:"real"}}],users:[{name:"real",user:{token:"real"}}]}))) as any;
    const base=scoped.clusters[0].cluster.server;const headers={authorization:`Bearer ${scoped.users[0].user.token}`};
    const args=["sh","-c","# owned platform wrapper\nexec bash -s"];
    const route=(pod="p",container="c",command=args)=>"/api/v1/namespaces/allowed/pods/"+pod+"/exec?"+new URLSearchParams([["container",container],["stdin","true"],...command.map(arg=>["command",arg] as [string,string])]);
    expect((await scopedFetch(base+route(),{headers},scoped)).status).toBe(403);
    const cleanup=["sh","-c","kill -- -12345"];
    const kill=vi.spyOn(Exec.prototype,"exec").mockRejectedValue(new Error("fixture transport closed"));
    proxy.registerPodTransport("allowed","p","c",args,true,cleanup);
    expect((await scopedFetch(base+route(),{headers},scoped)).status).toBe(200);
    // A protocol fallback may retry the same authorized transport.
    expect((await scopedFetch(base+route(),{headers},scoped)).status).toBe(200);
    expect((await scopedFetch(base+route("other"),{headers},scoped)).status).toBe(403);
    expect((await scopedFetch(base+route("p","other"),{headers},scoped)).status).toBe(403);
    expect((await scopedFetch(base+route("p","c",[...args,"injected"]),{headers},scoped)).status).toBe(403);
    expect((await scopedFetch(base+route()+"&stdin=false",{headers},scoped)).status).toBe(403);
    expect(paths).toHaveLength(2);
    proxy.dispose();proxy.dispose();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill.mock.calls[0].slice(0,4)).toEqual(["allowed","p","c",cleanup]);
    expect(()=>proxy.registerPodTransport("allowed","p","c",args,true,cleanup)).toThrow();
  });
});
