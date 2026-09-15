import type { CertificateIdentity } from "./cert-manager.js";

/** Ordinary Agent certificates must not access private Web principals either. */
export function matchesSessionPrincipal(identity: Pick<CertificateIdentity, "agentId" | "privateUserId">, owner: { agentId: string; userId: string }): boolean {
  return identity.agentId === owner.agentId && matchesPrivateUser(identity.privateUserId, owner.userId);
}

export function matchesPrivateUser(privateUserId: string | undefined, userId: string): boolean {
  return privateUserId ? privateUserId === userId : !userId.startsWith("web_");
}
