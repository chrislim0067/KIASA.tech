import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000203', color: '#faf5f0', fontFamily: 'PPMori, sans-serif', textAlign: 'center', padding: '2rem' }}>
      <div>
        <p style={{ fontSize: '1.4rem', marginBottom: '1rem' }}>404 — page not found</p>
        <Link href="/" style={{ color: '#faf5f0' }}>
          Back to kiasa.com
        </Link>
      </div>
    </div>
  );
}
