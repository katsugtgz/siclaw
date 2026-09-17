/**
 * A private Web principal needs an OS/filesystem boundary, not just a session ID.
 * Pack the Agent UUID and the 128-bit Web principal into a reversible, 50-character
 * lowercase base36 routing ID. It fits the existing Kubernetes label/pod naming
 * contract without truncation, a lookup table, or a second identity database.
 * This reserved namespace is internal: public Agent IDs remain UUIDs.
 */
export function webExecutionScope(agentId: string, userId?: string): string {
  if (!userId?.startsWith("web_")) return agentId;
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(agentId) || !/^web_[0-9a-f]{32}$/.test(userId)) {
    throw new Error("Invalid Web execution identity");
  }
  return BigInt(`0x${agentId.replaceAll("-", "")}${userId.slice(4)}`).toString(36).padStart(50, "0");
}

export function decodeWebExecutionScope(scope: string): { agentId: string; userId: string } | undefined {
  if (!/^[0-9a-z]{50}$/.test(scope)) return undefined;
  let value = 0n;
  for (const char of scope) value = value * 36n + BigInt(parseInt(char, 36));
  const hex = value.toString(16).padStart(64, "0");
  if (hex.length !== 64) throw new Error("Invalid Web execution scope");
  const a = hex.slice(0, 32);
  return { agentId: `${a.slice(0, 8)}-${a.slice(8, 12)}-${a.slice(12, 16)}-${a.slice(16, 20)}-${a.slice(20)}`, userId: `web_${hex.slice(32)}` };
}

export function sourceAgentId(scope: string): string {
  return decodeWebExecutionScope(scope)?.agentId ?? scope;
}
