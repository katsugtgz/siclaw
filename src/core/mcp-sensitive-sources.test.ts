import {describe,expect,it} from "vitest";
import {McpModelSecurity,mcpSensitiveValues} from "./mcp-security.js";

describe("MCP configured credential sources",()=>{
  it("registers argv authorization bodies, URL credentials and path-shaped password values",()=>{
    const basic=Buffer.from("fixture-user:argv-basic-canary").toString("base64");
    const configs={fixture:{transport:"stdio",command:"fixture-not-executed",args:["--header","Authorization: Bearer argv-bearer-canary",
      "--header=Authorization: Basic "+basic,"--password","/path-shaped-password-canary",
      "--endpoint=https://fixture-user:url-password-canary@example.invalid/mcp?token=url-query-canary"]}};
    const source=mcpSensitiveValues(configs);
    for(const value of ["argv-bearer-canary","argv-basic-canary","/path-shaped-password-canary","url-password-canary","url-query-canary"])
      expect(source).toContain(value);
    const security=new McpModelSecurity(()=>source);
    const result=security.result({content:[{type:"text",text:"argv-bearer-canary argv-basic-canary /path-shaped-password-canary url-password-canary url-query-canary"}]});
    const wire=JSON.stringify(result);
    for(const value of ["argv-bearer-canary","argv-basic-canary","/path-shaped-password-canary","url-password-canary","url-query-canary"])
      expect(wire).not.toContain(value);
  });
});
