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
  /** Left brand block (logo + `[data-brand-word]` wordmark). Optional. */
  brandRef?: RefObject<HTMLElement>;
  /** Number of nav buttons that can show a label. */
  itemCount: number;
  /** Changes when label text changes (language switch). */
  labelKey: string;
}

export interface HeaderNavLabels {
  /** How many nav buttons (left to right) show their label. */
  count: number;
  /** Whether the "Viber Switch" wordmark next to the logo fits. */
  showBrand: boolean;
}

/**
 * How many nav buttons (left to right) can show their label while AppSwitcher
 * still fits every app, and whether the brand wordmark fits on top of that.
 * The wordmark is the first thing to go: it is only shown when every label
 * still fits next to it. The budget (slot + gap + cluster, plus the wordmark
 * when it is currently shown) does not depend on the current label count or
 * wordmark state, so the result cannot feed back into itself.
 */
export function useHeaderNavLabels({
  rowRef,
  slotRef,
  clusterRef,
  brandRef,
  appsWidth,
  itemCount,
  labelKey,
}: HeaderNavLabelsOptions): HeaderNavLabels {
  const [state, setState] = useState<HeaderNavLabels>({
    count: itemCount,
    showBrand: true,
  });

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

      // Wordmark cost = its width + the gap to the logo. 0 = unmeasurable (brand block hidden).
      const brand = brandRef?.current ?? null;
      const word = brand?.querySelector<HTMLElement>("[data-brand-word]");
      const wordWidth = word?.getBoundingClientRect().width ?? 0;
      const wordCost =
        brand && wordWidth > 0
          ? wordWidth + (parseFloat(getComputedStyle(brand).columnGap) || 0)
          : 0;
      const wordShownNow = !!word && !word.hasAttribute("data-brand-hidden");

      const budget =
        slot.getBoundingClientRect().width +
        gap +
        clusterNow +
        (wordShownNow ? wordCost : 0);
      const shownNow = labels.filter(
        (l) => !l.hasAttribute("data-nav-hidden"),
      ).length;
      const extra = (n: number) =>
        widths.slice(0, n).reduce((sum, w) => sum + w + LABEL_EXTRA, 0);
      const base = clusterNow - extra(shownNow);

      const bestFor = (available: number) => {
        let best = 0;
        for (let n = 1; n <= Math.min(itemCount, labels.length); n += 1) {
          if (appsWidth + gap + base + extra(n) <= available - FIT_EPSILON)
            best = n;
        }
        return best;
      };

      const full = Math.min(itemCount, labels.length);
      const showBrand = wordCost > 0 && bestFor(budget - wordCost) === full;
      const count = showBrand ? full : bestFor(budget);
      setState((prev) =>
        prev.count === count && prev.showBrand === showBrand
          ? prev
          : { count, showBrand },
      );
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(slot);
    cluster
      .querySelectorAll("[data-nav-label]")
      .forEach((l) => observer.observe(l));
    const word = brandRef?.current?.querySelector("[data-brand-word]");
    if (word) observer.observe(word);
    return () => observer.disconnect();
  }, [rowRef, slotRef, clusterRef, brandRef, appsWidth, itemCount, labelKey]);

  return state;
}
