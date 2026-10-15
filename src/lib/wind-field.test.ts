import { describe, expect, it } from 'vitest';
import { decodeGrib2, gfsCycles, type WindField } from './wind-field';
import { sampleWind } from './wind-layer';

describe('gfsCycles', () => {
  it('starts with the newest run that has had five hours to land', () => {
    const cycles = gfsCycles(new Date('2026-10-15T10:30:00Z'));
    expect(cycles.map(c => c.refTime)).toEqual([
      '2026-10-15T00:00:00.000Z', '2026-10-14T18:00:00.000Z', '2026-10-14T12:00:00.000Z',
    ]);
    expect(cycles[0].url).toContain('dir=%2Fgfs.20261015%2F00%2Fatmos&file=gfs.t00z.pgrb2.1p00.f000');
  });
});

describe('decodeGrib2', () => {
  it('refuses what is not GRIB', () => {
    expect(() => decodeGrib2(new Uint8Array(32))).toThrow(/no message/);
  });
});

describe('sampleWind', () => {
  // A 4×3 grid from 90N at lon 0, 90° apart: u is the column, v the row.
  const field: WindField = {
    refTime: '', ni: 4, nj: 3, la1: 90, lo1: 0, dx: 90, dy: 90,
    u: [0, 10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30],
    v: [0, 0, 0, 0, 10, 10, 10, 10, 20, 20, 20, 20],
  };
  it('interpolates between grid points', () => {
    expect(sampleWind(field, 45, 45)).toEqual([0.5, 0.5]);
  });
  it('wraps across the antimeridian', () => {
    expect(sampleWind(field, -45, 0)![0]).toBeCloseTo(1.5);
  });
  it('has nothing beyond the poles', () => {
    expect(sampleWind(field, 0, 95)).toBeNull();
  });
});
