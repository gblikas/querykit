'use client';

import { useEffect, useState } from 'react';

export interface IViewportInfo {
  innerWidth: number;
  innerHeight: number;
  shortViewportHeightPx: number;
  isLessThanHeight: (px: number) => boolean;
  shortSidePx: number;
  isShortSideLessThan: (px: number) => boolean;
}

/**
 * Returns robust viewport dimensions using small viewport units (svh/svw) fallbacks.
 * Ensures height reflects the visual viewport on mobile, avoiding URL bar issues.
 */
export function useViewportInfo(): IViewportInfo {
  const readInnerHeight = (): number => {
    // Prefer visualViewport when available to avoid browser UI chrome affecting measurements
    const visual = window.visualViewport;
    if (visual && typeof visual.height === 'number')
      return Math.round(visual.height);
    // Fallbacks in order of reliability
    return Math.round(
      window.innerHeight || document.documentElement.clientHeight
    );
  };
  const readInnerWidth = (): number => {
    const visual = window.visualViewport;
    if (visual && typeof visual.width === 'number')
      return Math.round(visual.width);
    return Math.round(
      window.innerWidth || document.documentElement.clientWidth
    );
  };

  const [state, setState] = useState<IViewportInfo>((): IViewportInfo => {
    const w =
      typeof window !== 'undefined'
        ? typeof window.visualViewport?.width === 'number'
          ? Math.round(window.visualViewport.width)
          : window.innerWidth
        : 0;
    const h = typeof window !== 'undefined' ? readInnerHeight() : 0;
    const shortSide = Math.min(w, h);
    return {
      innerWidth: w,
      innerHeight: h,
      shortViewportHeightPx: h,
      isLessThanHeight: (px: number) => h < px,
      shortSidePx: shortSide,
      isShortSideLessThan: (px: number) => shortSide < px
    };
  });

  useEffect(() => {
    let frame = 0;
    const measure = (): void => {
      const w = readInnerWidth();
      const h = readInnerHeight();
      const shortSide = Math.min(w, h);
      setState({
        innerWidth: w,
        innerHeight: h,
        shortViewportHeightPx: h,
        isLessThanHeight: (px: number) => h < px,
        shortSidePx: shortSide,
        isShortSideLessThan: (px: number) => shortSide < px
      });
    };
    frame = requestAnimationFrame(measure);
    const onResize = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);
    return (): void => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  }, []);

  return state;
}
