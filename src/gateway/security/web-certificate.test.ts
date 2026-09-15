import { it, expect } from "vitest";
import { CertificateManager } from "./cert-manager.js";
import forge from "node-forge";
it("signs the source Agent and private user into independently verified certificate fields",async()=>{
 const cm=await CertificateManager.create();const user=`web_${"a".repeat(32)}`;
 const bundle=cm.issueAgentBoxCertificate("agent","org","webbox-scope",user);
 const verified=cm.verifyCertificate(bundle.cert);
 const parsed=forge.pki.certificateFromPem(bundle.cert);
 expect(parsed.subject.getField("OU").valueTagClass).toBe(forge.asn1.Type.UTF8);
 expect(verified).toMatchObject({agentId:"agent",orgId:"org",boxId:"webbox-scope",privateUserId:user});
 const ordinary=cm.verifyCertificate(cm.issueAgentBoxCertificate("agent","org","agentbox-agent").cert);
 expect(ordinary?.privateUserId).toBeUndefined();
});
