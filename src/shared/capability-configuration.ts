/**
 * An Agent Type whose capability groups come from its host (not from AGENT_TYPES)
 * and was delivered no selection. Refused rather than resolved: an empty
 * selection means "unrestricted" for legacy Custom agents, and a configurable
 * built-in type that silently gets every tool is not a weaker version of that
 * type, it is a different one.
 */
export type HostConfiguredAgentType = "ticket" | "coding";

const MESSAGES: Record<HostConfiguredAgentType, string> = {
  ticket: "Ticket Agent requires explicit tool capabilities from its host",
  coding: "Coding Agent requires explicit tool capabilities from its released type definition",
};

/** Configuration failures are actionable refusals, not legacy tool defaults. */
export class CapabilitiesRequiredError extends Error {
  readonly code: string;
  readonly status = 409;
  readonly retriable = false;

  constructor(readonly agentType: HostConfiguredAgentType) {
    super(MESSAGES[agentType]);
    this.name = "CapabilitiesRequiredError";
    this.code = `${agentType.toUpperCase()}_CAPABILITIES_REQUIRED`;
  }

  toJSON() {
    return { code: this.code, message: this.message, status: this.status, retriable: this.retriable };
  }
}
