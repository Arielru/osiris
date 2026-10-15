import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — the newest rain radar frame for the Rain layer.
 * Source: RainViewer's public radar mosaic — no key. A frame every ten
 * minutes; the browser pulls the tiles straight from RainViewer's cache.
 */

const TTL_MS = 5 * 60 * 1000;
let cached: { body: { time: number; tiles: string }; expiresAt: number } | null = null;

export async function GET() {
  if (!cached || Date.now() > cached.expiresAt) {
    try {
      const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
        signal: AbortSignal.timeout(10_000),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`RainViewer ${res.status}`);
      const maps = await res.json();
      const frame = maps?.radar?.past?.at(-1);
      if (!maps?.host || !frame?.path) throw new Error('RainViewer: no radar frame');
      // 256 px tiles, colour scheme 2, smoothed, snow shown in its own colour.
      const tiles = `${maps.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
      cached = { body: { time: frame.time, tiles }, expiresAt: Date.now() + TTL_MS };
    } catch (e) {
      console.warn('[OSIRIS] rain:', e);
      if (!cached) return NextResponse.json({ error: 'Rain radar unavailable' }, { status: 502 });
    }
  }
  return NextResponse.json(cached.body, { headers: { 'Cache-Control': 'public, max-age=120' } });
}
