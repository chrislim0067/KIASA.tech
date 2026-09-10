'use client';

import { useEffect } from 'react';

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[kiasa] route error', error);
  }, [error]);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000203', color: '#faf5f0', fontFamily: 'PPMori, sans-serif', textAlign: 'center', padding: '2rem' }}>
      <div>
        <p style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>Something went wrong while loading this page.</p>
        <button type="button" onClick={reset} style={{ background: 'transparent', color: '#faf5f0', border: '1px solid #faf5f0', padding: '0.6rem 1.4rem', borderRadius: '2rem', cursor: 'pointer' }}>
          Try again
        </button>
      </div>
    </div>
  );
}
