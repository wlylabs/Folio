"use client";

import { useEffect, useRef } from "react";

/**
 * Publishes the trade dock's height as `--dock-h`, and marks the document as
 * having a dock at all, so the page can reserve exactly that much room at its
 * bottom edge (see globals.css).
 *
 * The height has to be measured rather than assumed: the bar grows a line for a
 * faucet warning, another for a transaction status, another for a pause notice,
 * so a constant would either waste a strip of every article or let the bar cover
 * the last of one.
 */
export function useDockHeight() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const root = document.documentElement;
    const publish = () => root.style.setProperty("--dock-h", `${node.offsetHeight}px`);

    root.dataset.dock = "true";
    publish();

    const cleanup = () => {
      delete root.dataset.dock;
      root.style.removeProperty("--dock-h");
    };

    // ResizeObserver is everywhere the wallet connectors are, but the first
    // measurement above still stands if it happens to be missing.
    if (typeof ResizeObserver === "undefined") return cleanup;

    const observer = new ResizeObserver(publish);
    observer.observe(node);

    return () => {
      observer.disconnect();
      cleanup();
    };
  }, []);

  return ref;
}
