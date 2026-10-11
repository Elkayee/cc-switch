import { useLayoutEffect, useState, type RefObject } from "react";

/** Width a nav button gains when it shows its label: px-2 + glyph 16 + gap-1 + label vs icon-only w-7 (28). */
const LABEL_EXTRA = 8;
/** Keep a sub-pixel margin so a layout that exactly fits does not flap. */
const FIT_EPSILON = 0.5;

interface HeaderNavLabelsOptions {
  /** Row that holds [profile][slot][cluster] and owns the column gap. */
  rowRef: RefObject<HTMLElement>;
  /** Flexible slot that hosts AppSwitcher. */
  slotRef: RefObject<HTMLElement>;
  /** Right cluster (nav island + utility). Contains `[data-nav-label]` spans. */
  clusterRef: RefObject<HTMLElement>;
  /** Width AppSwitcher needs to show every app without the overflow menu. 0 = not measured yet. */
  appsWidth: number;
  /** Number of nav buttons that can show a label. */
  itemCount: number;
  /** Changes when label text changes (language switch). */
  labelKey: string;
}

/**
 * How many nav buttons (left to right) can show their label while AppSwitcher
 * still fits every app. The budget (slot + gap + cluster) does not depend on
 * the current label count, so the result cannot feed back into itself.
 */
export function useHeaderNavLabels({
  rowRef,
  slotRef,
  clusterRef,
  appsWidth,
  itemCount,
  labelKey,
}: HeaderNavLabelsOptions): number {
  const [count, setCount] = useState(itemCount);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const slot = slotRef.current;
    const cluster = clusterRef.current;
    if (!row || !slot || !cluster) return;

    const compute = () => {
      if (appsWidth <= 0) return;
      const labels = Array.from(
        cluster.querySelectorAll<HTMLElement>("[data-nav-label]"),
      );
      const widths = labels.map((l) => l.getBoundingClientRect().width);
      // jsdom / pre-layout: keep the current state
      if (widths.length === 0 || widths.some((w) => w <= 0)) return;

      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const clusterNow = cluster.getBoundingClientRect().width;
      const budget = slot.getBoundingClientRect().width + gap + clusterNow;
      const shownNow = labels.filter(
        (l) => !l.hasAttribute("data-nav-hidden"),
      ).length;
      const extra = (n: number) =>
        widths.slice(0, n).reduce((sum, w) => sum + w + LABEL_EXTRA, 0);
      const base = clusterNow - extra(shownNow);

      let best = 0;
      for (let n = 1; n <= Math.min(itemCount, labels.length); n += 1) {
        if (appsWidth + gap + base + extra(n) <= budget - FIT_EPSILON) best = n;
      }
      setCount(best);
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(slot);
    cluster
      .querySelectorAll("[data-nav-label]")
      .forEach((l) => observer.observe(l));
    return () => observer.disconnect();
  }, [rowRef, slotRef, clusterRef, appsWidth, itemCount, labelKey]);

  return count;
}
