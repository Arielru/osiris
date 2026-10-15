'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Pause, Play, Power, SkipBack, SkipForward, SlidersHorizontal, Wind } from 'lucide-react';
import type { Map as MlMap } from 'maplibre-gl';
import type { WindField } from '@/lib/wind-field';
import { blendWind, bracketTime, WIND_BANDS, WIND_STYLE, WindOverlay, type WindGrid, type WindStyle } from '@/lib/wind-layer';

/**
 * OSIRIS — the Wind layer's time slider and controls.
 *
 * The slider runs from three days back to five days ahead of the newest GFS
 * run (see /api/wind), a frame every three hours. Between two frames the wind
 * is blended, so scrubbing and playing move smoothly instead of in three-hour
 * jumps. Frames are fetched as the slider nears them, never the whole run.
 * TUNE sets how the particles move: their speed, tail length and density.
 *
 * It sits as a small box on the left. Hiding it folds it to a chip that still
 * shows the time the wind is drawn at; the wind keeps blowing, and playing
 * keeps playing. The power button turns the Wind layer itself off.
 */

const HOUR = 3600_000;
/** Model hours played per second. */
const RATES = [1, 3, 6, 12];
const MAX_FETCHES = 3;
const RETRY_MS = 30_000;
const STORE = 'osiris.wind';
/** Bottom left, just above the 3D/2D and MAP/SAT strip, in line with it. */
const PLACE = 'absolute z-[240] left-3 bottom-[124px] md:left-[120px] md:bottom-[160px] pointer-events-auto font-mono';

const UNITS = { 'm/s': 1, 'km/h': 3.6, kn: 1.943844 } as const;
type Unit = keyof typeof UNITS;

interface Settings extends WindStyle {
  rate: number;
  unit: Unit;
  /** The box is open, rather than folded to its chip. */
  open: boolean;
}
const DEFAULTS: Settings = { ...WIND_STYLE, rate: 3, unit: 'km/h', open: true };

type Frame = Omit<WindField, 'u' | 'v'> & { u: Int16Array; v: Int16Array };

function readSettings(): Settings {
  const out = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (typeof saved?.speed === 'number') out.speed = saved.speed;
    if (typeof saved?.trail === 'number') out.trail = saved.trail;
    if (typeof saved?.density === 'number') out.density = saved.density;
    if (RATES.includes(saved?.rate)) out.rate = saved.rate;
    if (saved?.unit in UNITS) out.unit = saved.unit;
    if (typeof saved?.open === 'boolean') out.open = saved.open;
  } catch { /* storage blocked or corrupt */ }
  return out;
}

const iso = (t: number) => new Date(t).toISOString();
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "+1D 6H", "−18H" — how far the slider is from now. */
function relative(t: number, now: number): string {
  const hours = Math.round((t - now) / HOUR);
  if (Math.abs(t - now) < HOUR / 2 || hours === 0) return 'NOW';
  const sign = hours > 0 ? '+' : '−';
  const d = Math.floor(Math.abs(hours) / 24);
  const h = Math.abs(hours) % 24;
  return `${sign}${d ? `${d}D` : ''}${d && h ? ' ' : ''}${h ? `${h}H` : ''}`;
}

export default function WindBar({ mapRef, onOff }: { mapRef: React.RefObject<MlMap | null>; onOff?: () => void }) {
  const overlay = useRef<WindOverlay | null>(null);
  const frames = useRef(new Map<number, Frame>());
  const fetching = useRef(new Set<number>());
  const failed = useRef(new Map<number, number>());
  const blended = useRef<WindGrid | undefined>(undefined);
  const runRef = useRef(0);

  const [timeline, setTimeline] = useState<{ run: number; times: number[] } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loaded, setLoaded] = useState<ReadonlySet<number>>(() => new Set());
  const [time, setTime] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const timeRef = useRef(time);
  const [playing, setPlaying] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [settings, setSettings] = useState<Settings>(readSettings);

  const seek = useCallback((t: number) => {
    timeRef.current = t;
    setTime(t);
  }, []);

  // The particles, on their own canvas over the map, for as long as the bar is up.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const wind = new WindOverlay(map);
    overlay.current = wind;
    return () => { wind.remove(); overlay.current = null; };
  }, [mapRef]);

  useEffect(() => {
    overlay.current?.setStyle({ speed: settings.speed, trail: settings.trail, density: settings.density });
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* storage blocked */ }
  }, [settings]);

  // Which run, and so which times. A new run lands every six hours.
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/wind')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((index: { run: string; times: string[] }) => {
        if (cancelled) return;
        const run = Date.parse(index.run);
        setUnavailable(false);
        if (run === runRef.current) return;
        runRef.current = run;
        frames.current.clear();
        failed.current.clear();
        setLoaded(new Set());
        setTimeline({ run, times: index.times.map(Date.parse) });
      })
      .catch(() => { if (!cancelled && !runRef.current) setUnavailable(true); });
    load();
    const refresh = setInterval(load, 30 * 60_000);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => { cancelled = true; clearInterval(refresh); clearInterval(tick); };
  }, []);

  const want = useCallback((t: number | undefined) => {
    if (t === undefined || frames.current.has(t) || fetching.current.has(t)) return;
    if (fetching.current.size >= MAX_FETCHES || (failed.current.get(t) ?? 0) > Date.now()) return;
    const run = runRef.current;
    fetching.current.add(t);
    fetch(`/api/wind?run=${iso(run)}&t=${iso(t)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((field: WindField | null) => {
        if (run !== runRef.current) return;
        if (!field?.u) { failed.current.set(t, Date.now() + RETRY_MS); return; }
        frames.current.set(t, { ...field, u: Int16Array.from(field.u), v: Int16Array.from(field.v) });
        setLoaded(new Set(frames.current.keys()));
      })
      .catch(() => failed.current.set(t, Date.now() + RETRY_MS))
      .finally(() => fetching.current.delete(t));
  }, []);

  const first = timeline?.times[0] ?? 0;
  const last = timeline?.times.at(-1) ?? 0;
  const at = timeline ? Math.min(last, Math.max(first, time)) : time;
  const [i0, i1, w] = timeline ? bracketTime(timeline.times, at) : [0, 0, 0];

  // Draw the wind at the slider, and fetch what it needs next: the frames
  // either side of it first, then those it is heading towards.
  useEffect(() => {
    if (!timeline) return;
    const { times } = timeline;
    want(times[i0]);
    want(times[i1]);
    for (let d = 1; d <= (playing ? 4 : 1); d++) {
      want(times[i1 + d]);
      if (!playing) want(times[i0 - d]);
    }
    const a = frames.current.get(times[i0]);
    const b = frames.current.get(times[i1]);
    if (!a && !b) return; // keep showing the last wind until these arrive
    blended.current = blendWind(a ?? b!, b ?? a!, a && b ? w : 0, blended.current);
    overlay.current?.setField(blended.current);
  }, [timeline, i0, i1, w, loaded, playing, want]);

  // Play: the model clock runs at `rate` hours a second, and waits at a frame
  // that hasn't arrived rather than run ahead of the data.
  useEffect(() => {
    if (!playing || !timeline) return;
    const { times } = timeline;
    const end = times.at(-1)!;
    let raf = 0;
    let lastFrame = performance.now();
    const step = (frameAt: number) => {
      const dt = Math.min(frameAt - lastFrame, 100);
      lastFrame = frameAt;
      const next = Math.min(end, timeRef.current + dt * settings.rate * HOUR / 1000);
      const [a, b] = bracketTime(times, next);
      if (frames.current.has(times[a]) && frames.current.has(times[b])) {
        seek(next);
        if (next >= end) { setPlaying(false); return; }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline, settings.rate, seek]);

  const togglePlay = () => {
    if (!playing && timeline && at >= last) seek(first);
    setPlaying(p => !p);
  };
  const stepFrame = (dir: 1 | -1) => {
    if (!timeline) return;
    const { times } = timeline;
    const target = dir > 0 ? times.find(t => t > at + 1) : times.findLast(t => t < at - 1);
    if (target !== undefined) seek(target);
  };
  const update = (patch: Partial<Settings>) => setSettings(s => ({ ...s, ...patch }));

  const pct = (t: number) => (timeline && last > first ? ((t - first) / (last - first)) * 100 : 0);
  const date = new Date(at);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const rel = relative(at, now);
  const kind = rel === 'NOW' ? 'NOW' : at > now ? 'FORECAST' : 'PAST';
  const kindColor = kind === 'FORECAST' ? 'text-[var(--gold-primary)]' : kind === 'NOW' ? 'text-[var(--gold-light)]' : 'text-white/55';
  const waiting = timeline && !(loaded.has(timeline.times[i0]) && loaded.has(timeline.times[i1]));
  const days = timeline ? dayMarks(first, last) : [];

  // Folded: a chip with the time the wind is drawn at. The wind and play go on.
  if (!settings.open) {
    return (
      <motion.button
        type="button" onClick={() => update({ open: true })}
        initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}
        title="Show the wind controls" aria-label="Show the wind controls" aria-expanded={false}
        className={`${PLACE} flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-lg border border-[var(--border-primary)] bg-black/75 backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,0.55)] hover:border-[var(--gold-primary)]/40 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--gold-primary)]`}
      >
        <Wind className={`w-3.5 h-3.5 text-[var(--gold-primary)] ${playing ? 'animate-pulse' : ''}`} strokeWidth={1.7} />
        <span className="text-[9px] tracking-[0.22em] text-white/55">WIND</span>
        {timeline && (
          <>
            <span className="text-[10.5px] font-semibold tracking-wider text-[var(--gold-light)] tabular-nums">{DAYS[date.getDay()]} {clock}</span>
            <span className={`text-[9px] tracking-wider tabular-nums ${kindColor}`}>{rel}</span>
          </>
        )}
        <ChevronUp className="w-3.5 h-3.5 text-white/40" strokeWidth={1.6} />
      </motion.button>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}
      className={`${PLACE} w-[min(288px,calc(100vw-24px))] rounded-xl border border-[var(--border-primary)] bg-black/75 backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,0.55)]`}
      role="group" aria-label="Wind time and controls"
    >
      <div className="flex items-center gap-1.5 h-8 pl-2.5 pr-1 border-b border-white/[0.06]">
        <Wind className="w-3.5 h-3.5 text-[var(--gold-primary)]" strokeWidth={1.7} />
        <span className="text-[9.5px] tracking-[0.22em] text-[var(--gold-light)]">WIND</span>
        <span className="text-[8.5px] tracking-[0.16em] text-white/30">NOAA GFS</span>
        <div className="ml-auto flex items-center">
          <IconButton label="Tune the particles" onClick={() => setTuning(o => !o)} active={tuning} pressed={tuning}>
            <SlidersHorizontal className="w-3.5 h-3.5" strokeWidth={1.6} />
          </IconButton>
          <IconButton label="Hide the wind controls" onClick={() => { setTuning(false); update({ open: false }); }}>
            <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.6} />
          </IconButton>
          {onOff && (
            <IconButton label="Turn the Wind layer off" onClick={onOff}>
              <Power className="w-3.5 h-3.5" strokeWidth={1.6} />
            </IconButton>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {tuning && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}
            className="overflow-hidden border-b border-white/[0.06]"
          >
            <div className="px-3 py-2.5 flex flex-col gap-2">
              <Tune label="FLOW SPEED" value={settings.speed} min={0.25} max={3} step={0.05}
                format={v => `${v.toFixed(2)}×`} onChange={speed => update({ speed })} />
              <Tune label="TAIL" value={settings.trail} min={4} max={60} step={1}
                format={v => (v < 12 ? 'SHORT' : v < 30 ? 'MEDIUM' : 'LONG')} onChange={trail => update({ trail })} />
              <Tune label="DENSITY" value={settings.density} min={0.25} max={2.5} step={0.05}
                format={v => `${v.toFixed(2)}×`} onChange={density => update({ density })} />
              <Legend unit={settings.unit} />
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-[3px] p-[2px] rounded-md border border-white/10" role="radiogroup" aria-label="Wind speed unit">
                  {(Object.keys(UNITS) as Unit[]).map(unit => (
                    <button key={unit} type="button" role="radio" aria-checked={settings.unit === unit}
                      onClick={() => update({ unit })}
                      className={`px-1.5 py-0.5 rounded text-[9px] tracking-wider transition-colors ${settings.unit === unit ? 'bg-[var(--gold-primary)]/15 text-[var(--gold-light)]' : 'text-white/40 hover:text-white/70'}`}>
                      {unit.toUpperCase()}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setSettings(s => ({ ...DEFAULTS, unit: s.unit }))}
                  className="ml-auto text-[9px] tracking-[0.18em] text-white/35 hover:text-[var(--gold-light)] transition-colors">
                  RESET
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="px-3 pt-2 pb-1">
        <div className="min-h-[34px]" aria-live="off">
          {timeline ? (
            <>
              <div className="text-[13px] leading-tight font-semibold tracking-wider text-[var(--gold-light)] tabular-nums">
                {DAYS[date.getDay()]} {date.getDate()} {MONTHS[date.getMonth()]} {clock}
              </div>
              <div className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap text-[9px] tracking-[0.14em] tabular-nums">
                <span className="text-white/35">{pad(date.getUTCHours())}:{pad(date.getUTCMinutes())}Z</span>
                <span className={kindColor}>{rel}{rel !== 'NOW' && ` · ${kind}`}</span>
                {waiting && <span className="text-white/35 animate-pulse">LOADING</span>}
              </div>
            </>
          ) : (
            <div className="pt-1 text-[10px] tracking-[0.18em] text-white/40">{unavailable ? 'WIND DATA UNAVAILABLE — RETRYING' : 'LOADING NOAA GFS…'}</div>
          )}
        </div>

        <div className="mt-1 flex items-center gap-0.5">
          <IconButton label="Back three hours" onClick={() => stepFrame(-1)} disabled={!timeline || at <= first}><SkipBack className="w-3.5 h-3.5" strokeWidth={1.6} /></IconButton>
          <IconButton label={playing ? 'Pause' : 'Play'} onClick={togglePlay} disabled={!timeline} active={playing}>
            {playing ? <Pause className="w-3.5 h-3.5" strokeWidth={1.8} /> : <Play className="w-3.5 h-3.5" strokeWidth={1.8} />}
          </IconButton>
          <IconButton label="Forward three hours" onClick={() => stepFrame(1)} disabled={!timeline || at >= last}><SkipForward className="w-3.5 h-3.5" strokeWidth={1.6} /></IconButton>
          <div className="ml-auto flex items-center gap-0.5">
            {timeline && rel !== 'NOW' && (
              <button type="button" onClick={() => seek(Math.min(last, Math.max(first, Date.now())))}
                className="px-1.5 h-6 rounded-md text-[9px] tracking-[0.16em] text-white/50 hover:text-[var(--gold-light)] hover:bg-[var(--hover-accent)] transition-colors">
                NOW
              </button>
            )}
            <button type="button" onClick={() => update({ rate: RATES[(RATES.indexOf(settings.rate) + 1) % RATES.length] })}
              title="Playback speed: model hours per second"
              className="px-1.5 h-6 rounded-md text-[9px] tracking-wider text-white/50 hover:text-[var(--gold-light)] hover:bg-[var(--hover-accent)] transition-colors tabular-nums">
              {settings.rate}H/S
            </button>
          </div>
        </div>

        {/* The track: past solid, forecast dashed, a dot per frame (lit once
            loaded), a tick at each midnight and the day named under it. */}
        <div className="relative h-[34px] mx-1 mt-0.5">
          <div className="absolute inset-x-0 top-[11px] h-[3px] rounded-full overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${pct(Math.min(now, last))}%` }} />
            <div className="absolute inset-y-0 right-0"
              style={{ left: `${pct(Math.max(now, first))}%`, background: 'repeating-linear-gradient(90deg, rgba(var(--gold-rgb),0.45) 0 5px, transparent 5px 8px)' }} />
            {timeline && (
              <div className="absolute inset-y-0 bg-[var(--gold-primary)]/60"
                style={{ left: `${Math.min(pct(at), pct(now))}%`, width: `${Math.abs(pct(at) - pct(now))}%` }} />
            )}
          </div>
          {timeline?.times.map(t => (
            <span key={t} aria-hidden="true"
              className={`absolute top-[5px] w-[2px] h-[2px] -ml-px rounded-full ${loaded.has(t) ? 'bg-white/60' : 'bg-white/12'}`}
              style={{ left: `${pct(t)}%` }} />
          ))}
          {days.map(d => (
            <span key={d.at} aria-hidden="true">
              {d.at > first && <span className="absolute top-[8px] h-[9px] w-px bg-white/25" style={{ left: `${pct(d.at)}%` }} />}
              {d.label && (
                <span className="absolute top-[19px] -translate-x-1/2 text-[8px] tracking-[0.1em] text-white/40 whitespace-nowrap"
                  style={{ left: `${pct(d.mid)}%` }}>{d.label}</span>
              )}
            </span>
          ))}
          {timeline && now >= first && now <= last && (
            <span aria-hidden="true" className="absolute top-[4px] h-[17px] w-px bg-[var(--gold-light)]/80" style={{ left: `${pct(now)}%` }} />
          )}
          {timeline && (
            <>
              <input
                type="range" min={first} max={last} step={HOUR} value={at}
                onChange={e => { setPlaying(false); seek(Number(e.target.value)); }}
                onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); togglePlay(); } }}
                aria-label="Wind time"
                aria-valuetext={`${date.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}, ${rel === 'NOW' ? 'now' : `${rel} ${kind.toLowerCase()}`}`}
                className="peer absolute inset-x-0 top-0 h-[26px] w-full opacity-0 cursor-pointer"
              />
              <span aria-hidden="true"
                className="pointer-events-none absolute top-[6px] -ml-[6px] w-[12px] h-[12px] rounded-full bg-[var(--gold-primary)] border-2 border-black/60 shadow-[0_0_10px_rgba(var(--gold-rgb),0.55)] peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--gold-light)]"
                style={{ left: `${pct(at)}%` }} />
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** Local midnights in range, and a day label centred on each day's stretch when there's room. */
function dayMarks(first: number, last: number): { at: number; mid: number; label: string | null }[] {
  const out: { at: number; mid: number; label: string | null }[] = [];
  const start = new Date(first);
  start.setHours(0, 0, 0, 0);
  for (let d = start; d.getTime() < last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const at = d.getTime();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const from = Math.max(at, first);
    const to = Math.min(end, last);
    const roomy = to - from >= 14 * HOUR;
    out.push({ at: from, mid: (from + to) / 2, label: roomy ? DAYS[d.getDay()] : null });
  }
  return out;
}

function IconButton({ label, onClick, disabled, active, pressed, children }: {
  label: string; onClick: () => void; disabled?: boolean; active?: boolean; pressed?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled} aria-pressed={pressed}
      className={`flex w-6 h-6 shrink-0 rounded-md items-center justify-center transition-colors disabled:opacity-25 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--gold-primary)] ${active ? 'text-[var(--gold-light)] bg-[var(--gold-primary)]/15' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-accent)]'}`}>
      {children}
    </button>
  );
}

function Tune({ label, value, min, max, step, format, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="flex items-baseline justify-between text-[8.5px] tracking-[0.18em] text-white/40">
        {label}
        <span className="text-[9px] tracking-wider text-[var(--gold-light)]/80 tabular-nums">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1 rounded-full bg-white/10 cursor-pointer" />
    </label>
  );
}

/** The colours the tails are drawn in, and the speed each starts at. */
function Legend({ unit }: { unit: Unit }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[8.5px] tracking-[0.18em] text-white/40">WIND SPEED · {unit.toUpperCase()}</span>
      <div className="flex">
        {WIND_BANDS.map(band => (
          <div key={band.from} className="flex flex-col items-start gap-0.5 flex-1 min-w-0" title={band.name}>
            <span className="h-[5px] w-full" style={{ background: `rgba(${band.rgb.join(',')},${band.alpha})` }} />
            <span className="text-[8.5px] tabular-nums text-white/45">{Math.round(band.from * UNITS[unit])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
