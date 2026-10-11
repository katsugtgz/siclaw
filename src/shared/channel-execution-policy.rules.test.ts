import {describe,it,expect,vi} from 'vitest';
import {parseChannelExecutionPolicy,channelPolicyForCluster,requireChannelHostOperation,type ChannelExecutionPolicy,type ChannelResourceRule} from './channel-execution-policy.js';
import {authorizeChannelKubernetesRequest} from '../agentbox/channel-kubernetes-proxy.js';
import {NativeMcpAuthorization} from '../gateway/mcp-authorization.js';
import {ExecutionGrantRegistry} from '../gateway/execution-grants.js';
import {mcpConfigurationDigest} from './mcp-authorization.js';

const leaf=(operations:string[],namespaces:string[]=[]):ChannelExecutionPolicy=>({version:1,revision:'r1',fingerprint:'a'.repeat(64),operations,namespaces,mcp:[],knowledgeIds:[],reports:false,attachments:false});
const rule=(id:string,kind:ChannelResourceRule['kind'],authority:ChannelExecutionPolicy,clusterNames:string[]=[],hostNames:string[]=[]):ChannelResourceRule=>({id,kind,authority,clusterNames,hostNames,hostIds:hostNames});
const policy=(rules:ChannelResourceRule[]):ChannelExecutionPolicy=>({...leaf([...new Set(rules.flatMap(r=>[...r.authority.operations]))],[...new Set(rules.flatMap(r=>[...r.authority.namespaces]))]),version:2,rules,mcp:rules.flatMap(r=>[...r.authority.mcp]),knowledgeIds:rules.flatMap(r=>[...r.authority.knowledgeIds])});

describe('resource rule authority',()=>{
 it('never combines actions, namespaces or clusters across different rules',()=>{
  const p=parseChannelExecutionPolicy(policy([
   rule('qa','kubernetes',leaf(['query'],['a']),['first']),
   rule('lb','kubernetes',leaf(['logs'],['b']),['first']),
   rule('qb','kubernetes',leaf(['query'],['b']),['second']),
  ]))!;
  const first=channelPolicyForCluster(p,'first'),second=channelPolicyForCluster(p,'second');
  expect(authorizeChannelKubernetesRequest('GET','/api/v1/namespaces/a/pods',first)).toBe('query');
  expect(authorizeChannelKubernetesRequest('GET','/api/v1/namespaces/b/pods/p/log',first)).toBe('logs');
  expect(()=>authorizeChannelKubernetesRequest('GET','/api/v1/namespaces/b/pods',first)).toThrow();
  expect(()=>authorizeChannelKubernetesRequest('GET','/api/v1/namespaces/a/pods/p/log',first)).toThrow();
  expect(()=>authorizeChannelKubernetesRequest('GET','/api/v1/namespaces/a/pods',second)).toThrow();
  expect(()=>authorizeChannelKubernetesRequest('GET','/api/v1/nodes',first)).toThrow();
  expect(()=>authorizeChannelKubernetesRequest('GET','/api/v1/namespaces/a/secrets',first)).toThrow();
  expect(()=>authorizeChannelKubernetesRequest('DELETE','/api/v1/namespaces/a/pods/p',first)).toThrow();
 });
 it('enforces each host operation and freezes nested authority',()=>{
  const p=parseChannelExecutionPolicy(policy([rule('a','host',leaf(['ssh_exec']),[],['061']),rule('b','host',leaf(['scripts']),[],['062'])]))!;
  expect(()=>requireChannelHostOperation(p,'061','ssh_exec')).not.toThrow();
  expect(()=>requireChannelHostOperation(p,'062','scripts')).not.toThrow();
  expect(()=>requireChannelHostOperation(p,'062','ssh_exec')).toThrow();
  expect(()=>requireChannelHostOperation(p,'061','scripts')).toThrow();
  expect(()=>requireChannelHostOperation(p,'other','ssh_exec')).toThrow();
  expect(Object.isFrozen(p.rules![0].authority.operations)).toBe(true);
  expect(()=>parseChannelExecutionPolicy({...p,version:'2'})).toThrow();
  expect(()=>parseChannelExecutionPolicy({...p,version:1})).toThrow();
  expect(()=>parseChannelExecutionPolicy({...p,operations:[...p.operations,'query']})).toThrow();
 });
 it('matches MCP tool and parameter constraints inside the same rule',async()=>{
  const m=(tool:string,ns:string)=>({...leaf(['mcp']),mcp:[{serverId:'m',tools:[tool],resources:[],prompts:[],arguments:{namespace:[ns]}}]});
  const p=policy([rule('a','mcp',m('list_pods','a')),rule('b','mcp',m('query_metrics','b'))]);
  const config={transport:'streamable-http' as const,url:'https://mcp.invalid',siclawId:'m',env:{SICLAW_MCP_OPERATION_POLICY:JSON.stringify({version:1,tools:{list_pods:{effect:'read'},query_metrics:{effect:'read'}}})}};
  const registry=new ExecutionGrantRegistry(async()=>({clusters:[],hosts:[],policy:p}));
  const grant=await registry.open('a','s',{kind:'binding',id:'g'},{userId:'u'});
  const request=vi.fn(async(method:string)=>method==='config.getResources'?{mcp_server_ids:['m']}:method==='config.getMcpServers'?{mcpServers:{selected:config}}:{policy:p});
  const auth=new NativeMcpAuthorization({request},()=>'',()=>grant);
  const call=(name:string,namespace:string)=>auth.authorize({agentId:'a'} as any,'s',{server:'selected',kind:'tool',name,arguments:{namespace},callId:'call',configurationDigest:mcpConfigurationDigest(config)},new AbortController().signal,grant.grantId);
  await expect(call('list_pods','a')).resolves.toMatchObject({effect:'read'});
  await expect(call('query_metrics','b')).resolves.toMatchObject({effect:'read'});
  await expect(call('list_pods','b')).rejects.toThrow();
  await expect(call('query_metrics','a')).rejects.toThrow();
 });
});
