/**
 * Wraps a lazy loader so it can start downloading from a hover or focus
 * handler. A failure here is ignored: the real load that follows reports it.
 */
export function preloader(load: () => Promise<unknown>): () => void {
  return () => {
    load().catch(() => undefined);
  };
}
