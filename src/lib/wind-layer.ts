import { LngLat, type Map as MlMap } from 'maplibre-gl';
import type { WindField } from './wind-field';

/**
 * OSIRIS — Wind drawn as it blows.
 *
 * Thousands of particles ride the GFS surface wind (see wind-field) and leave
 * fading trails, the way a weather map shows it. They live in lng/lat, so they
 * stay put as the map moves, curve with the globe, and the far side of the
 * planet hides them. Calm air is a faint white, strong wind turns gold.
 */

export const WIND_ATTRIBUTION = 'Wind: <a href="https://www.nco.ncep.noaa.gov/pmb/products/gfs/" target="_blank" rel="noopener">NOAA GFS</a>';

/** Speed bands, m/s, and the colour a trail takes in each. */
const BANDS: { below: number; color: string }[] = [
  { below: 3, color: 'rgba(255,255,255,0.35)' },
  { below: 7, color: 'rgba(255,255,255,0.6)' },
  { below: 12, color: 'rgba(230,211,163,0.85)' },
  { below: Infinity, color: 'rgba(212,175,55,0.95)' },
];
/** Screen pixels a 1 m/s wind moves a particle each frame. */
const SPEED = 0.12;
/** How much of last frame's trails is kept. */
const FADE = 0.92;
const MAX_AGE = 110;
/** One particle per this many CSS pixels of map, within bounds. */
const DENSITY = 450;
const MIN_PARTICLES = 800;
const MAX_PARTICLES = 5000;

/** Wind at a point, m/s, read bilinearly off the one-degree grid. */
export function sampleWind(field: WindField, lng: number, lat: number): [number, number] | null {
  const x = ((((lng - field.lo1) % 360) + 360) % 360) / field.dx;
  const y = (field.la1 - lat) / field.dy;
  if (y < 0 || y > field.nj - 1) return null;
  const i0 = Math.floor(x);
  const j0 = Math.min(Math.floor(y), field.nj - 2);
  const i1 = (i0 + 1) % field.ni;
  const fx = x - i0;
  const fy = y - j0;
  const at = (arr: number[], i: number, j: number) => arr[j * field.ni + i];
  const mix = (arr: number[]) =>
    (at(arr, i0, j0) * (1 - fx) + at(arr, i1, j0) * fx) * (1 - fy) +
    (at(arr, i0, j0 + 1) * (1 - fx) + at(arr, i1, j0 + 1) * fx) * fy;
  return [mix(field.u) / 10, mix(field.v) / 10];
}

export class WindOverlay {
  private map: MlMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private field: WindField | null = null;
  private frame = 0;
  private count = 0;
  private lng = new Float64Array(0);
  private lat = new Float64Array(0);
  private age = new Uint16Array(0);
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  /** Set when the map moved: the last screen positions are stale. */
  private moved = true;
  private width = 0;
  private height = 0;

  constructor(map: MlMap) {
    this.map = map;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'osiris-wind';
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
    map.getCanvasContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    map.on('resize', this.resize);
    map.on('move', this.onMove);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  setField(field: WindField): void {
    this.field = field;
    for (let k = 0; k < this.count; k++) this.spawn(k);
  }

  remove(): void {
    cancelAnimationFrame(this.frame);
    this.map.off('resize', this.resize);
    this.map.off('move', this.onMove);
    this.canvas.remove();
  }

  private resize = () => {
    const box = this.map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    this.width = box.clientWidth;
    this.height = box.clientHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, Math.round(this.width * this.height / DENSITY)));
    this.count = count;
    this.lng = new Float64Array(count);
    this.lat = new Float64Array(count);
    this.age = new Uint16Array(count);
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    for (let k = 0; k < count; k++) this.spawn(k);
    this.moved = true;
  };

  private onMove = () => { this.moved = true; };

  private occluded(at: LngLat): boolean {
    const transform = (this.map as unknown as { transform?: { isLocationOccluded?: (l: LngLat) => boolean } }).transform;
    return transform?.isLocationOccluded?.(at) ?? false;
  }

  /** A fresh particle somewhere on the visible map, at a random age. */
  private spawn(k: number): void {
    for (let tries = 0; tries < 6; tries++) {
      const x = Math.random() * this.width;
      const y = Math.random() * this.height;
      const at = this.map.unproject([x, y]);
      if (Math.abs(at.lat) > 85 || this.occluded(at)) continue;
      const back = this.map.project(at);
      if (Math.abs(back.x - x) > 2 || Math.abs(back.y - y) > 2) continue; // off the globe's edge
      this.lng[k] = at.lng;
      this.lat[k] = at.lat;
      this.px[k] = x;
      this.py[k] = y;
      this.age[k] = Math.floor(Math.random() * MAX_AGE);
      return;
    }
    this.age[k] = MAX_AGE; // nowhere to stand this frame; try again next
  }

  private tick = () => {
    this.frame = requestAnimationFrame(this.tick);
    const field = this.field;
    const ctx = this.ctx;
    if (!field || !this.width) return;

    if (this.moved) {
      ctx.clearRect(0, 0, this.width, this.height);
      for (let k = 0; k < this.count; k++) {
        const p = this.map.project([this.lng[k], this.lat[k]]);
        this.px[k] = p.x;
        this.py[k] = p.y;
      }
      this.moved = false;
    } else {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = `rgba(0,0,0,${FADE})`;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalCompositeOperation = 'source-over';
    }

    // Degrees per screen pixel at this zoom (512 px tiles).
    const degPerPx = 360 / (512 * 2 ** this.map.getZoom());
    const paths = BANDS.map(() => new Path2D());
    let drawn = false;
    for (let k = 0; k < this.count; k++) {
      if (this.age[k] >= MAX_AGE) { this.spawn(k); continue; }
      const wind = sampleWind(field, this.lng[k], this.lat[k]);
      if (!wind) { this.age[k] = MAX_AGE; continue; }
      const [u, v] = wind;
      const step = SPEED * degPerPx;
      const cos = Math.max(0.2, Math.cos(this.lat[k] * Math.PI / 180));
      const lng = this.lng[k] + u * step / cos;
      const lat = this.lat[k] + v * step;
      this.lng[k] = lng;
      this.lat[k] = lat;
      this.age[k]++;
      if (Math.abs(lat) > 85) { this.age[k] = MAX_AGE; continue; }
      const p = this.map.project([lng, lat]);
      const offscreen = p.x < 0 || p.y < 0 || p.x > this.width || p.y > this.height;
      if (offscreen || (k % 4 === this.age[k] % 4 && this.occluded(new LngLat(lng, lat)))) {
        this.age[k] = MAX_AGE;
        continue;
      }
      // A jump means the particle wrapped the antimeridian or crossed the
      // globe's limb; start its trail over rather than streak the screen.
      if (Math.abs(p.x - this.px[k]) < 30 && Math.abs(p.y - this.py[k]) < 30) {
        const speed = Math.hypot(u, v);
        const band = BANDS.findIndex(b => speed < b.below);
        paths[band].moveTo(this.px[k], this.py[k]);
        paths[band].lineTo(p.x, p.y);
        drawn = true;
      }
      this.px[k] = p.x;
      this.py[k] = p.y;
    }
    if (!drawn) return;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    BANDS.forEach((band, i) => {
      ctx.strokeStyle = band.color;
      ctx.stroke(paths[i]);
    });
  };
}
