import type { BackgroundChannelEvent } from "./background-delivery.js";

/** One reply per background main turn; child completion is never a reply terminator.
 * The channel owns transport/card APIs. This layer only owns execution boundaries. */
export function createChannelFollowup<Card>(renderer: {
  open(): Promise<Card | null>;
  update(card: Card, text: string): Promise<unknown>;
  finish(card: Card | null, text: string): Promise<unknown>;
  emptyText: string;
  errorText: string;
  cancelledText: string;
}) {
  let active = false;
  let turnId: unknown;
  let card: Card | null = null;
  let text = "";
  let tail = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run);
    tail = next.then(() => {}, () => {});
    return next;
  };
  return {
    event(event: BackgroundChannelEvent): Promise<void> {
      return enqueue(async () => {
        if (event.type === "background_turn_start") {
          if (active && event.turnId === turnId) return;
          active = true;
          turnId = event.turnId;
          text = "";
          card = null;
          card = await renderer.open();
        } else if (active && (event.type === "background_turn_done" || event.type === "stream_error")) {
          if (event.turnId && event.turnId !== turnId) return;
          const final = event.type === "stream_error" || event.outcome === "error"
            ? renderer.errorText : event.outcome === "aborted" ? renderer.cancelledText
            : text || renderer.emptyText;
          active = false;
          await renderer.finish(card, final);
          card = null;
        }
      });
    },
    message(value: string): Promise<boolean> {
      return enqueue(async () => {
        if (!active) return false;
        text = value;
        if (card) await renderer.update(card, text);
        return true;
      });
    },
  };
}
