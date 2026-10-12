import type {
  ChannelDeliverMessagePayload,
  DelegationAppendMessagePayload,
} from "../../shared/delegation-persistence.js";

// Process-local registry of live channel delivery handles, keyed by sessionId.
// This requires the Gateway to run single-replica (helm/siclaw/templates/
// gateway-deployment.yaml pins `replicas: 1`; see helm/siclaw/values.yaml for the
// rationale). With >1 replica an agent's channel_update could land on a replica
// that does not hold the session's handle, and the update would silently vanish —
// horizontal scale would require a shared pub/sub bus.
//
// Handles are TTL-bounded and the TTL is refreshed on each successful delivery, so
// a long-running turn (the channel_update milestone use case) keeps its handle
// alive as long as it keeps producing visible updates, rather than going dark
// after a fixed window mid-investigation.

export type ChannelDeliveryPayload = DelegationAppendMessagePayload | ChannelDeliverMessagePayload;
export type BackgroundChannelDelivery = (message: ChannelDeliveryPayload) => Promise<boolean>;

interface DeliveryEntry {
  deliver: BackgroundChannelDelivery;
  ttlMs: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const deliveries = new Map<string, Map<string, DeliveryEntry>>();

export function registerBackgroundChannelDelivery(
  sessionId: string,
  deliver: BackgroundChannelDelivery,
  ttlMs: number = DEFAULT_TTL_MS,
  requestId?: string,
): () => void {
  const key = requestId ?? "";
  const entries = deliveries.get(sessionId) ?? new Map<string, DeliveryEntry>();
  const prior = entries.get(key); if (prior) clearTimeout(prior.timer);
  const expiresAt = Date.now() + ttlMs;
  const clear = () => {
    if (deliveries.get(sessionId)?.get(key) !== entry) return;
    clearTimeout(entry.timer); entries.delete(key);
    if (!entries.size) deliveries.delete(sessionId);
  };
  const timer = setTimeout(clear, ttlMs);
  timer.unref?.();
  const entry = { deliver, ttlMs, expiresAt, timer };
  entries.set(key, entry); deliveries.set(sessionId, entries);
  return clear;
}

export function clearBackgroundChannelDelivery(sessionId: string): void {
  const existing = deliveries.get(sessionId);
  if (existing) for (const entry of existing.values()) clearTimeout(entry.timer);
  deliveries.delete(sessionId);
}

export function hasBackgroundChannelDelivery(sessionId: string | undefined): boolean {
  return Boolean(sessionId && [...(deliveries.get(sessionId)?.keys() ?? [])].some(key => getEntry(sessionId, key)));
}

export async function deliverBackgroundChannelMessage(
  message: DelegationAppendMessagePayload,
): Promise<boolean> {
  if (message.role !== "assistant" || !message.content.trim()) return false;
  const entry = getEntry(message.sessionId);
  if (!entry) return false;
  const delivered = await entry.deliver(message);
  if (delivered && deliveries.get(message.sessionId)?.get("") === entry) refreshEntry(message.sessionId, "", entry);
  return delivered;
}

export async function deliverChannelVisibleMessage(
  message: ChannelDeliverMessagePayload,
): Promise<boolean> {
  if (!message.text.trim()) return false;
  const key = message.requestId ?? "";
  const entry = getEntry(message.sessionId, key);
  if (!entry) return false;
  const delivered = await entry.deliver(message);
  if (delivered && deliveries.get(message.sessionId)?.get(key) === entry) refreshEntry(message.sessionId, key, entry);
  return delivered;
}

function getEntry(sessionId: string | undefined, key = ""): DeliveryEntry | undefined {
  if (!sessionId) return undefined;
  const entries = deliveries.get(sessionId);
  const entry = entries?.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    clearTimeout(entry.timer); entries!.delete(key);
    if (!entries!.size) deliveries.delete(sessionId);
    return undefined;
  }
  return entry;
}

/**
 * Slide the TTL window forward after a successful delivery so an actively
 * reporting turn keeps its handle. Without this a turn outliving the fixed TTL
 * (long investigations are exactly what channel_update targets) would silently
 * lose delivery mid-run.
 */
function refreshEntry(sessionId: string, key: string, entry: DeliveryEntry): void {
  clearTimeout(entry.timer);
  entry.expiresAt = Date.now() + entry.ttlMs;
  entry.timer = setTimeout(() => {
    if (deliveries.get(sessionId)?.get(key) !== entry) return;
    deliveries.get(sessionId)!.delete(key);
    if (!deliveries.get(sessionId)!.size) deliveries.delete(sessionId);
  }, entry.ttlMs);
  entry.timer.unref?.();
}
