'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { acquireRuntime } from './runtime/singleton';

export type ExperienceStatus = 'booting' | 'ready' | 'started' | 'unsupported' | 'error';

const StatusContext = createContext<ExperienceStatus>('booting');

export const useExperienceStatus = (): ExperienceStatus => useContext(StatusContext);

/**
 * Boots the experience runtime once on the client (worker, audio, scroll, UI) and disposes
 * it when the experience layout unmounts. Rendered only on the client: the runtime touches
 * `window`, `document` and the Web Audio API.
 */
export function ExperienceRuntime({ children }: { children: ReactNode }) {
  const router = useRouter();
  const routerRef = useRef(router);
  const [status, setStatus] = useState<ExperienceStatus>('booting');

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
    const lease = acquireRuntime({
      router: { push: (href) => routerRef.current.push(href) },
      onStatus: (next) => setStatus(next),
    });
    return () => lease.release();
  }, []);

  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
}
