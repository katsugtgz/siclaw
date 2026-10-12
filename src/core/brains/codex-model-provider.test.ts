import { expect, it } from "vitest";
import { nativeCodexModelProvider } from "./codex-model-provider.js";
const token=(claims: object)=>"header."+Buffer.from(JSON.stringify(claims)).toString("base64url")+".signature";
const valid=token({exp:Date.now()/1000+3600,"https://api.openai.com/auth":{chatgpt_account_id:"account-test"}});
it.each(["openai-responses","openai-codex-responses"])("maps %s to bounded subscription bearer authentication without persisting tokens",api=>{
 const p=nativeCodexModelProvider({baseUrl:"https://chatgpt.com/backend-api",apiKey:valid,authHeader:false},api);
 expect(p).toMatchObject({base_url:"https://chatgpt.com/backend-api/codex",env_key:"SICLAW_CODEX_MODEL_TOKEN",http_headers:{"ChatGPT-Account-Id":"account-test"}});
 expect(JSON.stringify(p)).not.toContain(valid);
});
it("does not redirect a subscription bearer to a custom or decorated endpoint",()=>{
 for(const baseUrl of ["https://example.com/v1","http://chatgpt.com/backend-api","https://chatgpt.com/backend-api?x=1","https://u:p@chatgpt.com/backend-api"]){
  expect(()=>nativeCodexModelProvider({baseUrl,apiKey:valid},"openai-codex-responses")).toThrow();
 }
});
it("refuses invalid, missing-account or expired access tokens without reflecting them",()=>{
 for(const apiKey of ["secret-canary",token({exp:1}),token({exp:Date.now()/1000+1000})]){
  let message="";try{nativeCodexModelProvider({baseUrl:"https://chatgpt.com/backend-api",apiKey})}catch(e){message=(e as Error).message}
  expect(message).toMatch(/Subscription/);expect(message).not.toContain(apiKey);
 }
});
it("preserves ordinary Responses authentication",()=>{
 expect(nativeCodexModelProvider({baseUrl:"https://models.example/v1",apiKey:"secret",headers:{"X-Test":"safe"}})).toMatchObject({base_url:"https://models.example/v1",env_key:"SICLAW_CODEX_MODEL_TOKEN",http_headers:{"X-Test":"safe"}});
});
