'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect, type ReactNode } from 'react';
import type { ViewName } from './runtime/navigation';
import { getActiveNavigation } from './runtime/singleton';

/**
 * Wraps a page view of the experience (top / about / contact) and tells the navigation
 * controller when its DOM is on screen so the enter transition can run.
 */
export function ExperienceView({ view, children }: { view: ViewName; children: ReactNode }) {
  const pathname = usePathname();
  useLayoutEffect(() => {
    getActiveNavigation()?.viewMounted(pathname);
  }, [pathname]);
  return <div data-taxi-view={view}>{children}</div>;
}
