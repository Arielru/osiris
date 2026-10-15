import { NextResponse } from 'next/server';
import { decodeGrib2, gfsCycles, toWindField, type WindField } from '@/lib/wind-field';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — global surface wind for the Wind layer.
 * Source: NOAA GFS via NOMADS — public, no key. A new run every six hours,
 * so one copy is held in memory and shared; a failed refresh keeps the last.
 */

const TTL_MS = 60 * 60 * 1000;
let cached: { field: WindField; expiresAt: number } | null = null;
let inflight: Promise<WindField> | null = null;

async function fetchLatest(): Promise<WindField> {
  let lastError: unknown = null;
  for (const cycle of gfsCycles(new Date())) {
    try {
      const res = await fetch(cycle.url, { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
      if (!res.ok) { lastError = new Error(`NOMADS ${res.status}`); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      return toWindField(decodeGrib2(buf), cycle.refTime);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('No GFS run available');
}

export async function GET() {
  if (!cached || Date.now() > cached.expiresAt) {
    inflight ??= fetchLatest().finally(() => { inflight = null; });
    try {
      cached = { field: await inflight, expiresAt: Date.now() + TTL_MS };
    } catch (e) {
      console.warn('[OSIRIS] wind:', e);
      if (!cached) return NextResponse.json({ error: 'Wind data unavailable' }, { status: 502 });
    }
  }
  return NextResponse.json(cached.field, {
    headers: { 'Cache-Control': 'public, max-age=900, stale-while-revalidate=3600' },
  });
}
