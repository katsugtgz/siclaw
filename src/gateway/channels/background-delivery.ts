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
export type BackgroundChannelEvent = Record<string, unknown> & { type: string };
export type BackgroundChannelEventListener = (event: BackgroundChannelEvent) => Promise<void>;

interface DeliveryEntry {
  deliver: BackgroundChannelDelivery;
  onEvent?: BackgroundChannelEventListener;
  ttlMs: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const deliveries = new Map<string, DeliveryEntry>();

export function registerBackgroundChannelDelivery(
  sessionId: string,
  deliver: BackgroundChannelDelivery,
  options: number | { ttlMs?: number; onEvent?: BackgroundChannelEventListener } = DEFAULT_TTL_MS,
): () => void {
  const ttlMs = typeof options === "number" ? options : options.ttlMs ?? DEFAULT_TTL_MS;
  const onEvent = typeof options === "number" ? undefined : options.onEvent;
  clearBackgroundChannelDelivery(sessionId);
  const expiresAt = Date.now() + ttlMs;
  const timer = setTimeout(() => clearBackgroundChannelDelivery(sessionId), ttlMs);
  timer.unref?.();
  deliveries.set(sessionId, { deliver, onEvent, ttlMs, expiresAt, timer });
  return () => clearBackgroundChannelDelivery(sessionId);
}

/** Session-level lifecycle, independent of the current main prompt's SSE subscription. */
export async function deliverBackgroundChannelEvent(sessionId: string, event: BackgroundChannelEvent): Promise<void> {
  const entry = getEntry(sessionId);
  if (!entry?.onEvent) return;
  try {
    await entry.onEvent(event);
    if (deliveries.get(sessionId) === entry) refreshEntry(sessionId, entry);
  } catch (err) {
    // An IM rendering failure must not suppress Portal events or restart the agent.
    console.warn(`[background-delivery] event=${event.type} session=${sessionId} failed:`, err);
  }
}

export function clearBackgroundChannelDelivery(sessionId: string): void {
  const existing = deliveries.get(sessionId);
  if (existing) clearTimeout(existing.timer);
  deliveries.delete(sessionId);
}

export function hasBackgroundChannelDelivery(sessionId: string | undefined): boolean {
  return Boolean(sessionId && getEntry(sessionId));
}

export async function deliverBackgroundChannelMessage(
  message: DelegationAppendMessagePayload,
): Promise<boolean> {
  if (message.role !== "assistant" || !message.content.trim()) return false;
  const entry = getEntry(message.sessionId);
  if (!entry) return false;
  const delivered = await entry.deliver(message);
  if (delivered && deliveries.get(message.sessionId) === entry) refreshEntry(message.sessionId, entry);
  return delivered;
}

export async function deliverChannelVisibleMessage(
  message: ChannelDeliverMessagePayload,
): Promise<boolean> {
  if (!message.text.trim()) return false;
  const entry = getEntry(message.sessionId);
  if (!entry) return false;
  const delivered = await entry.deliver(message);
  if (delivered && deliveries.get(message.sessionId) === entry) refreshEntry(message.sessionId, entry);
  return delivered;
}

function getEntry(sessionId: string | undefined): DeliveryEntry | undefined {
  if (!sessionId) return undefined;
  const entry = deliveries.get(sessionId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    clearBackgroundChannelDelivery(sessionId);
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
function refreshEntry(sessionId: string, entry: DeliveryEntry): void {
  clearTimeout(entry.timer);
  entry.expiresAt = Date.now() + entry.ttlMs;
  entry.timer = setTimeout(() => clearBackgroundChannelDelivery(sessionId), entry.ttlMs);
  entry.timer.unref?.();
}
