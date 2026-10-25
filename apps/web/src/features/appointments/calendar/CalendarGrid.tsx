import type { AppointmentDto, AppointmentItemDto, AttendanceStatus } from '@salon/shared';
import { GripVertical } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Avatar } from '@/components/ui/display';
import { useNow } from '@/lib/hooks';
import { cn } from '@/lib/utils';

export const PX_PER_MIN = 1.15;
const HEADER_H = 56;
const GUTTER_W = 56;

export interface GridColumn {
  key: string;
  label: string;
  sublabel?: string;
  color?: string;
  photo?: string | null;
  date: string;
  staffId?: string;
  /** Working windows in minutes after midnight. Empty means not working. */
  shifts: Array<{ start: number; end: number }>;
  breaks: Array<{ start: number; end: number; label: string }>;
  blocks: Array<{ id: string; start: number; end: number; reason: string }>;
  leave: 'full' | 'first_half' | 'second_half' | null;
  attendance?: AttendanceStatus | null;
  closed?: string | null;
}

export interface GridItem {
  key: string;
  columnKey: string;
  startMin: number;
  endMin: number;
  appointment: AppointmentDto;
  item: AppointmentItemDto;
}

export interface MoveRequest {
  item: GridItem;
  column: GridColumn;
  startMin: number;
}
export interface ResizeRequest {
  item: GridItem;
  durationMinutes: number;
}

const STATUS_STYLE: Record<string, string> = {
  scheduled: 'bg-info-soft border-info text-fg',
  confirmed: 'bg-primary-soft border-primary text-fg',
  checked_in: 'bg-warning-soft border-warning text-fg',
  in_service: 'bg-success-soft border-success text-fg',
  completed: 'bg-surface-3 border-line-strong text-muted',
  waiting: 'bg-warning-soft border-warning text-fg',
};

const fmtMin = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const hh = h % 12 || 12;
  return `${hh}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

/** Side-by-side lanes for blocks that overlap in one column (service view; staff columns never overlap). */
function layout(items: GridItem[]): Map<string, { lane: number; lanes: number }> {
  const result = new Map<string, { lane: number; lanes: number }>();
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let cluster: GridItem[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    const placed = new Map<string, number>();
    for (const it of cluster) {
      let lane = laneEnds.findIndex((end) => end <= it.startMin);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = it.endMin;
      placed.set(it.key, lane);
    }
    for (const it of cluster) result.set(it.key, { lane: placed.get(it.key)!, lanes: Math.max(laneEnds.length, 1) });
    cluster = [];
  };
  for (const it of sorted) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) flush();
  return result;
}

interface DragState {
  item: GridItem;
  mode: 'move' | 'resize';
  grabOffset: number;
  columnKey: string;
  startMin: number;
  durationMin: number;
  moved: boolean;
  originX: number;
  originY: number;
}

export function CalendarGrid({ columns, items, rangeStart, rangeEnd, slotMinutes, canEdit, showNow, onSlotClick, onSelect, onMove, onResize, busyKey, emptyBanner }: {
  columns: GridColumn[];
  items: GridItem[];
  rangeStart: number;
  rangeEnd: number;
  slotMinutes: number;
  canEdit: boolean;
  showNow?: { date: string; minutes: number } | null;
  onSlotClick?: (column: GridColumn, minute: number) => void;
  onSelect: (a: AppointmentDto) => void;
  onMove?: (req: MoveRequest) => void;
  onResize?: (req: ResizeRequest) => void;
  busyKey?: string | null;
  emptyBanner?: string | null;
}) {
  useNow(60_000);
  const bodyRef = useRef<HTMLDivElement>(null);
  const colRefs = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const total = rangeEnd - rangeStart;
  const height = total * PX_PER_MIN;
  const hours = useMemo(() => Array.from({ length: Math.floor(total / 60) + 1 }, (_, i) => rangeStart + i * 60).filter((m) => m <= rangeEnd), [rangeStart, rangeEnd, total]);
  const byColumn = useMemo(() => {
    const m = new Map<string, GridItem[]>();
    for (const it of items) m.set(it.columnKey, [...(m.get(it.columnKey) ?? []), it]);
    return m;
  }, [items]);

  const snap = (min: number) => Math.round(min / slotMinutes) * slotMinutes;
  const minuteAt = (clientY: number) => rangeStart + (clientY - bodyRef.current!.getBoundingClientRect().top) / PX_PER_MIN;
  const columnAt = (clientX: number): string | null => {
    for (const [key, el] of colRefs.current) {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right) return key;
    }
    return null;
  };

  const editable = (it: GridItem) => canEdit && ['scheduled', 'confirmed', 'checked_in'].includes(it.appointment.status);
  const canResize = (it: GridItem) => canEdit && ['scheduled', 'confirmed'].includes(it.appointment.status);

  const begin = (e: ReactPointerEvent, it: GridItem, mode: 'move' | 'resize') => {
    if (e.button !== 0 || !editable(it)) return;
    if (mode === 'resize' && !canResize(it)) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ item: it, mode, grabOffset: minuteAt(e.clientY) - it.startMin, columnKey: it.columnKey, startMin: it.startMin, durationMin: it.endMin - it.startMin, moved: false, originX: e.clientX, originY: e.clientY });
  };

  const move = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const moved = d.moved || Math.abs(e.clientX - d.originX) > 5 || Math.abs(e.clientY - d.originY) > 5;
    if (!moved) return;
    const minute = minuteAt(e.clientY);
    if (d.mode === 'resize') {
      const dur = Math.max(slotMinutes, snap(minute - d.item.startMin));
      setDrag({ ...d, moved: true, durationMin: Math.min(dur, rangeEnd - d.item.startMin) });
    } else {
      const col = columnAt(e.clientX) ?? d.columnKey;
      const start = Math.min(Math.max(snap(minute - d.grabOffset), rangeStart), rangeEnd - (d.item.endMin - d.item.startMin));
      setDrag({ ...d, moved: true, columnKey: col, startMin: start });
    }
  };

  const end = () => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    if (!d.moved) {
      onSelect(d.item.appointment);
      return;
    }
    if (d.mode === 'resize') {
      const dur = d.durationMin;
      if (dur !== d.item.endMin - d.item.startMin) onResize?.({ item: d.item, durationMinutes: dur });
      return;
    }
    const column = columns.find((c) => c.key === d.columnKey);
    if (column && (d.startMin !== d.item.startMin || d.columnKey !== d.item.columnKey)) onMove?.({ item: d.item, column, startMin: d.startMin });
  };

  useEffect(() => {
    const cancel = (e: KeyboardEvent) => e.key === 'Escape' && setDrag(null);
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, []);

  const lanesByColumn = useMemo(() => {
    const m = new Map<string, Map<string, { lane: number; lanes: number }>>();
    for (const c of columns) m.set(c.key, layout(byColumn.get(c.key) ?? []));
    return m;
  }, [columns, byColumn]);

  const minColWidth = columns.length > 6 ? 150 : 170;
  const nowTop = showNow ? (showNow.minutes - rangeStart) * PX_PER_MIN : null;

  return (
    <div className="scroll-thin relative overflow-auto rounded-xl border border-line bg-surface" style={{ maxHeight: 'calc(100dvh - 15rem)', minHeight: 420 }} role="region" aria-label="Appointment calendar" tabIndex={0}>
      {emptyBanner && <div className="sticky left-0 top-0 z-30 bg-warning-soft px-4 py-2 text-sm font-medium text-warning">{emptyBanner}</div>}
      <div className="relative" style={{ minWidth: GUTTER_W + columns.length * minColWidth }}>
        {/* Column headers */}
        <div className="sticky top-0 z-20 flex border-b border-line bg-surface" style={{ height: HEADER_H }}>
          <div className="sticky left-0 z-30 shrink-0 border-r border-line bg-surface" style={{ width: GUTTER_W }} />
          {columns.map((c) => (
            <div key={c.key} className="flex flex-1 items-center gap-2 border-r border-line px-3 last:border-r-0" style={{ minWidth: minColWidth }}>
              {c.color && <Avatar name={c.label} color={c.color} src={c.photo} size="sm" />}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-fg">{c.label}</p>
                {c.sublabel && <p className="truncate text-xs text-muted">{c.sublabel}</p>}
              </div>
              {c.attendance === 'absent' && <span className="ml-auto rounded bg-danger-soft px-1.5 text-[10px] font-medium text-danger">Absent</span>}
              {c.attendance === 'late' && <span className="ml-auto rounded bg-warning-soft px-1.5 text-[10px] font-medium text-warning">Late</span>}
            </div>
          ))}
        </div>

        <div className="relative flex" ref={bodyRef} style={{ height }}>
          {/* Time gutter */}
          <div className="sticky left-0 z-10 shrink-0 border-r border-line bg-surface" style={{ width: GUTTER_W }}>
            {hours.map((m) => (
              <div key={m} className="absolute right-2 -translate-y-2 text-[11px] tabular-nums text-faint" style={{ top: (m - rangeStart) * PX_PER_MIN }}>
                {m === rangeStart ? '' : fmtMin(m).replace(':00', '')}
              </div>
            ))}
          </div>

          {columns.map((c) => {
            const lanes = lanesByColumn.get(c.key)!;
            return (
              <div
                key={c.key}
                data-col={c.key}
                ref={(el) => {
                  if (el) colRefs.current.set(c.key, el);
                  else colRefs.current.delete(c.key);
                }}
                className="relative flex-1 border-r border-line last:border-r-0"
                style={{ minWidth: minColWidth, backgroundImage: 'linear-gradient(var(--line) 1px, transparent 1px)', backgroundSize: `100% ${60 * PX_PER_MIN}px` }}
                onClick={(e) => {
                  if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.slot) return;
                  const minute = Math.floor(minuteAt(e.clientY) / slotMinutes) * slotMinutes;
                  if (!c.closed && c.leave !== 'full') onSlotClick?.(c, minute);
                }}
              >
                {/* Not working: hatched; working windows are drawn clear on top of it */}
                <div className="hatch absolute inset-0" data-slot="1" aria-hidden />
                {c.shifts.map((s, i) => (
                  <div key={i} data-slot="1" className="absolute inset-x-0 bg-surface" style={{ top: (Math.max(s.start, rangeStart) - rangeStart) * PX_PER_MIN, height: (Math.min(s.end, rangeEnd) - Math.max(s.start, rangeStart)) * PX_PER_MIN, backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${slotMinutes * PX_PER_MIN - 1}px, color-mix(in srgb, var(--line) 70%, transparent) ${slotMinutes * PX_PER_MIN - 1}px, color-mix(in srgb, var(--line) 70%, transparent) ${slotMinutes * PX_PER_MIN}px)` }} />
                ))}
                {c.breaks.map((b, i) => (
                  <div key={i} className="pointer-events-none absolute inset-x-0 bg-surface-3/70 px-2 text-[10px] font-medium text-muted" style={{ top: (b.start - rangeStart) * PX_PER_MIN, height: (b.end - b.start) * PX_PER_MIN }}>
                    {b.label}
                  </div>
                ))}
                {c.blocks.map((b) => (
                  <div key={b.id} className="hatch pointer-events-none absolute inset-x-0 border-y border-line-strong px-2 text-[10px] font-medium text-muted" style={{ top: Math.max(b.start - rangeStart, 0) * PX_PER_MIN, height: (Math.min(b.end, rangeEnd) - Math.max(b.start, rangeStart)) * PX_PER_MIN }}>
                    {b.reason}
                  </div>
                ))}
                {c.leave && (
                  <div className="pointer-events-none absolute inset-x-0 z-[1] flex items-start justify-center bg-info-soft/80 pt-2 text-xs font-semibold text-info" style={c.leave === 'full' ? { inset: 0 } : c.leave === 'first_half' ? { top: 0, height: '50%' } : { bottom: 0, height: '50%' }}>
                    On leave{c.leave === 'full' ? '' : ' (half day)'}
                  </div>
                )}
                {c.closed && <div className="pointer-events-none absolute inset-0 z-[1] grid place-items-start bg-surface-3/70 pt-3 text-center text-xs font-semibold text-muted">{c.closed}</div>}

                {(byColumn.get(c.key) ?? []).map((it) => {
                  const dragging = drag?.item.key === it.key;
                  const lane = lanes.get(it.key) ?? { lane: 0, lanes: 1 };
                  const dur = dragging && drag.mode === 'resize' ? drag.durationMin : it.endMin - it.startMin;
                  const a = it.appointment;
                  const compact = dur * PX_PER_MIN < 44;
                  const busy = busyKey === it.key;
                  return (
                    <div
                      key={it.key}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(a))}
                      onPointerDown={(e) => e.pointerType !== 'touch' && begin(e, it, 'move')}
                      onPointerMove={move}
                      onPointerUp={end}
                      onClick={(e) => {
                        // Mouse drags/clicks on editable blocks are handled on pointer-up; this covers keyboard, touch taps and read-only blocks.
                        const pointerType = (e.nativeEvent as PointerEvent).pointerType;
                        if (!editable(it) || pointerType === 'touch' || e.detail === 0) onSelect(a);
                        e.stopPropagation();
                      }}
                      className={cn('absolute z-[2] overflow-hidden rounded-lg border-l-4 px-2 py-1 text-left text-xs shadow-card outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring', STATUS_STYLE[a.status] ?? 'bg-surface-2 border-line', editable(it) ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer', dragging && drag.moved && 'opacity-40', busy && 'animate-pulse')}
                      style={{ top: (it.startMin - rangeStart) * PX_PER_MIN, height: Math.max(dur * PX_PER_MIN - 2, 22), left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`, width: `calc(${100 / lane.lanes}% - 4px)`, borderLeftColor: it.item.staffColor ?? 'var(--primary)', touchAction: editable(it) ? 'none' : undefined }}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <p className="truncate font-semibold">{a.customer.fullName}<span className="sr-only">, {a.status.replace('_', ' ')}</span></p>
                        {a.status === 'in_service' && <span className="pulse-dot mt-1 size-2 shrink-0 rounded-full bg-success" aria-hidden />}
                        {editable(it) && (
                          <span onPointerDown={(e) => e.pointerType === 'touch' && begin(e, it, 'move')} onPointerMove={move} onPointerUp={end} className="-mr-1 hidden touch-none rounded p-0.5 text-muted [@media(pointer:coarse)]:block" aria-hidden>
                            <GripVertical className="size-3.5" />
                          </span>
                        )}
                      </div>
                      {!compact && <p className="truncate text-muted">{it.item.serviceName}{it.item.staffName && columns.some((x) => !x.staffId) ? ` · ${it.item.staffName}` : ''}</p>}
                      {!compact && dur * PX_PER_MIN > 60 && <p className="text-[11px] text-muted">{fmtMin(it.startMin)} – {fmtMin(it.startMin + dur)}</p>}
                      {a.customer.outstanding > 0 && !compact && <span className="mt-0.5 inline-block rounded bg-warning-soft px-1 text-[10px] font-medium text-warning">Pending ₹</span>}
                      {canResize(it) && <div onPointerDown={(e) => begin(e, it, 'resize')} onPointerMove={move} onPointerUp={end} className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize" style={{ touchAction: 'none' }} aria-hidden />}
                    </div>
                  );
                })}

                {/* Drag ghost */}
                {drag?.moved && drag.mode === 'move' && drag.columnKey === c.key && (
                  <div className="pointer-events-none absolute inset-x-1 z-[5] rounded-lg border-2 border-dashed border-primary bg-primary/15 px-2 py-1 text-xs font-semibold text-primary-soft-fg" style={{ top: (drag.startMin - rangeStart) * PX_PER_MIN, height: Math.max((drag.item.endMin - drag.item.startMin) * PX_PER_MIN - 2, 22) }}>
                    {fmtMin(drag.startMin)} – {fmtMin(drag.startMin + drag.item.endMin - drag.item.startMin)}
                  </div>
                )}
                {drag?.moved && drag.mode === 'resize' && drag.item.columnKey === c.key && (
                  <div className="pointer-events-none absolute inset-x-1 z-[5] rounded-lg border-2 border-dashed border-primary bg-primary/15 px-2 text-xs font-semibold text-primary-soft-fg" style={{ top: (drag.item.startMin - rangeStart) * PX_PER_MIN, height: drag.durationMin * PX_PER_MIN }}>
                    {drag.durationMin} min · ends {fmtMin(drag.item.startMin + drag.durationMin)}
                  </div>
                )}
                {nowTop !== null && showNow && showNow.date === c.date && nowTop >= 0 && nowTop <= height && (
                  <div className="pointer-events-none absolute inset-x-0 z-[4] border-t-2 border-danger" style={{ top: nowTop }}>
                    <span className="absolute -left-1 -top-[5px] size-2 rounded-full bg-danger" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
