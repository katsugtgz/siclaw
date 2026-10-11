import {it,expect,vi} from 'vitest';
import {parseChannelExecutionPolicy,type ChannelExecutionPolicy} from './channel-execution-policy.js';
import {authorizeChannelKubernetesRequest,ChannelKubernetesProxy} from '../agentbox/channel-kubernetes-proxy.js';
import {load} from 'js-yaml';
import {NativeMcpAuthorization} from '../gateway/mcp-authorization.js';
import {ExecutionGrantRegistry} from '../gateway/execution-grants.js';
import {mcpConfigurationDigest} from './mcp-authorization.js';
const policy=():ChannelExecutionPolicy=>({version:3,revision:'agent:1:dm',fingerprint:'a'.repeat(64),operations:['query','logs','pod_exec','ssh_exec','scripts','mcp','knowledge','reports','attachments'],namespaces:[],mcp:[],knowledgeIds:[],reports:true,attachments:true});
it('preserves the Agent credential default namespace without disclosing the upstream token',async()=>{
 const proxy=new ChannelKubernetesProxy(policy(),async()=>{});
 try{
  const raw=await proxy.configure(JSON.stringify({apiVersion:'v1',kind:'Config','current-context':'real',clusters:[{name:'real',cluster:{server:'https://cluster.invalid'}}],contexts:[{name:'real',context:{cluster:'real',user:'real',namespace:'agent-default'}}],users:[{name:'real',user:{token:'UPSTREAM-CANARY'}}]}));
  expect((load(raw) as any).contexts[0].context.namespace).toBe('agent-default');expect(raw).not.toContain('UPSTREAM-CANARY');
 }finally{proxy.dispose()}
});
it('inherits namespace access but retains secret, write and raw-transport safety',()=>{
 const p=parseChannelExecutionPolicy(policy())!;
 for(const path of ['/api/v1/nodes','/api/v1/pods','/api/v1/namespaces/a/pods','/api/v1/namespaces/b/pods'])expect(authorizeChannelKubernetesRequest('GET',path,p)).toBe('query');
 for(const [method,path]of [['DELETE','/api/v1/namespaces/a/pods/p'],['GET','/api/v1/secrets'],['GET','/api/v1/namespaces/a/secrets'],['GET','/api/v1/nodes/n/proxy'],['POST','/api/v1/namespaces/a/pods/p/exec?command=sh&command=-c&command=rm%20-rf%20/tmp']])expect(()=>authorizeChannelKubernetesRequest(method,path,p)).toThrow();
 expect(()=>parseChannelExecutionPolicy({...p,namespaces:['a']})).toThrow();expect(()=>parseChannelExecutionPolicy({...p,version:'3'})).toThrow();expect(()=>parseChannelExecutionPolicy({...p,operations:[]})).toThrow();
});
it('uses Agent MCP governance without a second per-channel tool list and rechecks revocation',async()=>{
 const p=policy(),config={transport:'streamable-http' as const,url:'https://mcp.invalid',siclawId:'m',env:{SICLAW_MCP_OPERATION_POLICY:JSON.stringify({version:1,tools:{list_pods:{effect:'read'}}})}};
 const registry=new ExecutionGrantRegistry(async()=>({clusters:[],hosts:[],policy:p})),grant=await registry.open('a','s',{kind:'binding',id:'g'},{userId:'u'});
 let revoked=false;
 const request=vi.fn(async(method:string)=>method==='config.getResources'?{mcp_server_ids:['m']}:method==='config.getMcpServers'?{mcpServers:{selected:config}}:{policy:{...p,fingerprint:revoked?'b'.repeat(64):p.fingerprint}});
 const auth=new NativeMcpAuthorization({request},()=>'',()=>grant);
 const call=(name:string)=>auth.authorize({agentId:'a'} as any,'s',{server:'selected',kind:'tool',name,arguments:{},callId:'c',configurationDigest:mcpConfigurationDigest(config)},new AbortController().signal,grant.grantId);
 await expect(call('list_pods')).resolves.toMatchObject({effect:'read'});await expect(call('delete_pods')).rejects.toThrow();revoked=true;await expect(call('list_pods')).rejects.toThrow(/revoked/);
});
