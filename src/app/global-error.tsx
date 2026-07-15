'use client'

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body><main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'system-ui, sans-serif' }}><section style={{ maxWidth: 520, border: '1px solid #fecaca', borderRadius: 16, padding: 24 }}><h1 style={{ marginTop: 0 }}>Sublime could not start</h1><p>The application encountered an unexpected error. Your saved data was not changed.</p><button onClick={reset} style={{ border: 0, borderRadius: 999, padding: '10px 16px', background: '#062f33', color: 'white', cursor: 'pointer' }}>Try again</button></section></main></body></html>
}
