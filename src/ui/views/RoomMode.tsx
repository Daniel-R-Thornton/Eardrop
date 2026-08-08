/**
 * RoomMode.tsx — full-screen "room mode": the chatter room, presentation-
 * style. Centrepiece is a hand-drawn constellation graph (this device at the
 * centre, each detected member placed around it by link quality); below it the
 * two actions that put something on the air, the roster, a per-node spectrum
 * sparkline, a live packet stream, and the room's chat. Reads only from the
 * Store and dispatches the same custom events ChatterPanel already uses —
 * join/leave, file selection, and now chat text — so no protocol logic lives
 * here.
 *
 * ONE VERTICAL COLUMN, at every width. This was a two-column grid with a fixed
 * 340px track, which on a 390px phone left the graph about 50px — and this mode
 * is largely driven from a phone, since that is what gets carried to the other
 * side of the room. A single column is responsive by construction: there is no
 * second layout tree to keep in step, and no fixed track to overrun. Width is
 * read once, via isWideViewport(), only to decide whether the debug sections
 * (roster/spectrum/packets) start open; after that the operator's toggles own
 * them and nothing re-reads it.
 *
 * The graph and spectrum canvases are sized from their container, not from
 * hardcoded pixels. Two halves make that survive collapsing, and BOTH are
 * required: CollapsibleSection unmounts its children when shut, so no canvas is
 * left measuring zero inside a hidden box; and useMeasuredSize hands out a
 * callback ref, so the box that mounts on the way back in is measured afresh.
 * Unmounting alone is not enough — with a ref object read once at mount, a
 * section that starts closed is never measured at all. See useMeasuredSize
 * below; there is a regression test for it in RoomMode.test.tsx.
 *
 * The column scrolls internally (overflowY on the stack below). BenchApp pins
 * this mode to exactly the viewport with overflow hidden, so a stack taller than
 * the screen has no page scroll to fall back on — without a scroll container
 * here, whatever does not fit is simply clipped away unreachably, and the chat
 * composer at the bottom is the first thing to go.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../Store';
import { T } from '../theme/labaccent/tokens';
import { Screen } from '../components/instrument/Screen';
import { PacketStream } from './RoomModePacketStream';
import { hex, formatAgo } from './roomModeFormat';
import { LogShare } from './LogShare';
import { CollapsibleSection } from './CollapsibleSection';
import { ChatMessageList } from './ChatMessageList';
import { ChatComposer } from './ChatComposer';
import { isWideViewport } from './viewport';
import { dlog } from '../../lib/debug/dlog';
import {
  NICKNAME_MAX_BYTES, defaultNickname, getNickname, labelFor, setNickname,
} from '../../lib/identity';

const dispatch = (type: string) => window.dispatchEvent(new CustomEvent(type));

/** Members past this age are shown dimmed/aged-out on the graph and roster —
 *  display-only; RoomProtocol owns its own membership timeout separately. */
const AGE_OUT_MS = 5 * 60 * 1000;

/**
 * Plain-English account of each protocol phase, with the rough duration where
 * one is bounded. Every phase here involves either silence or a burst that
 * takes seconds, so a bare state word ("LISTENING") reads as a hang — the
 * operator cannot tell a working join from a stuck one without knowing what
 * the radio is actually doing and roughly how long it takes.
 */
const PHASE_TEXT: Record<string, string> = {
  off: 'not joined',
  cold: 'not joined',
  listening: 'waiting for a clear moment on the air before announcing',
  announcing: 'announcing — playing the probe burst (~4 s of audio)',
  joinWait: 'announced; waiting for anyone already here to reply (~6 s)',
  idle: 'in the room — listening for probes and transfers',
  rollCall: 'roll call — playing the probe burst so peers can measure us (~4 s)',
  collecting: 'collecting channel reports from peers (~6 s)',
  sending: 'transmitting the file',
  receiving: 'receiving a file',
};

/** Safety ceiling on the Join/Leave button's disabled window — mirrors
 *  ChatterPanel's guard against double-clicking mid-join/leave. If the store
 *  never reaches the expected chatterOn state within this window, that's the
 *  only signal we have that the attempt stalled (e.g. the mic prompt never
 *  resolved) — chatterController does not (yet) report an in-flight state or
 *  a failure distinct from "still off", so this view surfaces its own local
 *  notice rather than relying on chatterError, which may never populate on
 *  that path. */
const PENDING_TIMEOUT_MS = 15000;

/** How long the "this device is transmitting" ring pulse plays after
 *  chatterLastTx updates. */
const TX_PULSE_MS = 1200;
/** How long a node stays highlighted after a packet arrives from it. */
const RX_HIGHLIGHT_MS = 900;

/** Link quality (dB, <=0, higher/closer-to-0 = stronger) → 0..1 for radius/color.
 *  Guards against NaN/undefined explicitly — a bad reading must park the node
 *  at a fixed, dim fallback position, never propagate NaN into radius/x/y and
 *  silently vanish it (the exact failure mode this is guarding against). */
function linkStrength(linkDb: number | undefined): number {
  if (linkDb === undefined || !Number.isFinite(linkDb)) return 0.15;
  // -2dB ≈ excellent (close to peak), -40dB ≈ barely there.
  const clamped = Math.max(-40, Math.min(0, linkDb));
  return (clamped + 40) / 40;
}

/** Deterministic pseudo-random angle from a device id (xorshift-ish mix),
 *  NOT the roster index — an index-based angle reshuffles every other node's
 *  position whenever anyone ages out or rejoins, which is exactly wrong for
 *  a live monitoring view. Same id always lands at the same angle. */
function hashAngle(deviceId: number): number {
  let h = (deviceId * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return ((h >>> 0) % 10000 / 10000) * Math.PI * 2;
}

/**
 * Floor for the chat panel, in px. Measured from the rendered page at 390px
 * wide, not chosen: 10px of panel padding top and bottom, a 17px CHAT title,
 * the 117px composer at its tallest (recipient picker + byte counter + disabled
 * notice + input row), and ~20px for one line of transcript. Anything less and
 * the panel cannot fit the send button.
 */
const CHAT_MIN_HEIGHT = 184;

/** Side of the invisible square hit-target laid over each node on the canvas.
 *  44px is the smallest comfortable touch target and a node is selected with a
 *  thumb. Shared with graphMetrics below, which has to reserve room for it. */
const NODE_TARGET_PX = 44;
/** Range of `radius` a node is given (see the nodes map in RoomMode): the
 *  strongest link sits closest in, the weakest/unmeasured furthest out.
 *  graphMetrics needs the maximum to know where the outermost node will
 *  actually land, so both ends live here rather than as literals at the site. */
const MIN_NODE_RADIUS = 0.22;
const MAX_NODE_RADIUS = 0.92;

/** Shared centre/radius geometry — used by both the canvas draw and the
 *  overlay hit-targets so they can never desync.
 *
 * R reserves room for a WHOLE hit-target inside the box, which is the load-
 * bearing part. At the bare `min(w,h) * 0.44` this used to return, the
 * outermost node (radius 0.92) lands 0.405 * min(w,h) from the centre — in the
 * 120px-tall box the graph floors at on a phone, that is y ~= 108.6, and its
 * 44px circle reaches ~130.6, about 11px BELOW the box. Those circles are
 * positioned elements, so CSS paints them above the later, non-positioned
 * action-button row whatever the DOM order, and they carry pointerEvents:auto
 * — so they overlaid `send file` and `JOIN ROOM` and swallowed the taps meant
 * for them. The two controls that put anything on the air were unreachable on
 * the device this page exists to be driven from.
 *
 * The clamp belongs HERE and nowhere else: the canvas draw and the overlay both
 * read their geometry from this function, so neither can drift from the other.
 * The graph box also clips its overflow now, but that is the safety net for a
 * stale measurement — not a substitute for placing nodes where they fit.
 */
function graphMetrics(w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.min(w, h) / 2;
  const R = Math.max(0, Math.min(
    half * 0.88,
    (half - NODE_TARGET_PX / 2) / MAX_NODE_RADIUS,
  ));
  return { cx, cy, R };
}
function nodeXY(w: number, h: number, angle: number, radius: number) {
  const { cx, cy, R } = graphMetrics(w, h);
  return { x: cx + Math.cos(angle) * R * radius, y: cy + Math.sin(angle) * R * radius };
}

/**
 * Tracks an element's content-box size so a canvas can be sized to fill its
 * container instead of a hardcoded pixel box.
 *
 * The first measurement is taken synchronously, the moment the node arrives,
 * rather than waiting for ResizeObserver's initial callback. RO delivers its
 * callbacks as part of the rendering steps, so a window that is occluded or
 * throttled can defer them indefinitely — the canvas then never gets a
 * non-zero size and simply never appears. Measuring up front makes the first
 * paint independent of that; the observer only handles later resizes.
 *
 * Returns a CALLBACK REF, not a ref object, and this is the load-bearing part.
 * It was a `useRef` + `useLayoutEffect(…, [])`, which read `ref.current` exactly
 * once at RoomMode mount and never again. Every box it measures now lives inside
 * a CollapsibleSection, and a closed section does not render its children — so
 * on a phone, where SPECTRUM seeds closed, `ref.current` was null at that one
 * moment, the effect bailed, and no observer was ever attached. Expanding the
 * section mounted a brand-new box that nothing re-measured: the size stayed
 * {0,0}, the `w > 0 && h > 0` render guard never passed, and the spectrum was a
 * blank strip for the rest of the session. The same mechanism spoiled any
 * collapse → resize → reopen on desktop, drawing at the stale pre-collapse size
 * with the observer left on a detached node.
 *
 * A callback ref fixes that at the root: React invokes it with the node on
 * attach and runs the returned cleanup on detach, so measurement is
 * re-established whenever the element changes for ANY reason. Threading each
 * section's `open` flag in as an effect dep would also work, but it would make
 * this hook know why its node comes and goes — and it would silently break again
 * the next time a box is made conditional on something else.
 */
function useMeasuredSize<T extends HTMLElement>(): [(el: T | null) => void, { w: number; h: number }] {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const attach = useCallback((el: T | null) => {
    if (!el) return;
    // Re-setting an identical size would re-render, and any render that can
    // nudge layout turns the observer into a feedback loop — so bail on no-ops.
    const apply = (rawW: number, rawH: number) => {
      const w = Math.max(0, Math.floor(rawW));
      const h = Math.max(0, Math.floor(rawH));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    ro.observe(el);
    // React 19 runs a ref callback's returned function on detach. Returning it
    // explicitly (rather than relying on the older callback-with-null contract)
    // keeps the observer's lifetime tied to the node that owns it.
    return () => ro.disconnect();
  }, []);
  return [attach, size];
}

export function RoomMode({ onExit }: { onExit: () => void }) {
  const s = useStore((x) => x);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Join/Leave pending guard — same discipline as ChatterPanel, plus a
  // distinct "awaiting" visual and a local fallback notice if the store
  // never reaches the expected state (see PENDING_TIMEOUT_MS doc above).
  const [pending, setPending] = useState<'join' | 'leave' | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  /** True while a file is being dragged over the mode — drives the drop overlay. */
  const [dragging, setDragging] = useState(false);
  /**
   * Who the next thing sent is addressed to: 0 for the whole room. Owned by the
   * composer's recipient picker, so text and files are addressed in one place.
   * A drag-and-drop still passes 0 explicitly — a drop on the whole mode is a
   * broadcast and must not silently inherit whatever the picker was left on.
   */
  const [sendTargetId, setSendTargetId] = useState(0);
  /** Session-log viewer — room mode is full-screen, and on a phone this is the
   *  only way to read what the radio actually did. */
  const [showLog, setShowLog] = useState(false);

  // Debug panels start open on a desktop-width viewport and shut on a phone,
  // then the operator's toggles own them. isWideViewport is read ONCE here for
  // that seed — the layout itself is one column at every width, so nothing
  // re-reads it (see viewport.ts). The graph starts open regardless: it is the
  // view's centrepiece, and a room page that opens showing nothing but a
  // collapsed strip and a chat box hides what the mode is for.
  const wide = isWideViewport();
  const [graphOpen, setGraphOpen] = useState(true);
  const [rosterOpen, setRosterOpen] = useState(wide);
  const [spectrumOpen, setSpectrumOpen] = useState(wide);
  const [packetsOpen, setPacketsOpen] = useState(wide);

  // Quiet the modem's per-symbol logging for as long as this mode is on
  // screen, so the room's own lines are readable in the console. Restored on
  // exit — this narrows the view, it does not permanently change logging.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('eardrop-room-focus', { detail: { focused: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent('eardrop-room-focus', { detail: { focused: false } }));
    };
  }, []);
  const wasOn = useRef(s.chatterOn);
  useEffect(() => {
    if (wasOn.current !== s.chatterOn) {
      wasOn.current = s.chatterOn;
      setPending(null);
      setLocalNotice(null);
    }
  }, [s.chatterOn]);
  useEffect(() => {
    if (!pending) return;
    const attempted = pending;
    const t = setTimeout(() => {
      setPending(null);
      setLocalNotice(
        attempted === 'join'
          ? 'Join did not complete — no room joined yet. Check microphone permission and try again.'
          : 'Leave did not complete — try again.',
      );
    }, PENDING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pending]);

  // tx pulse: chatterLastTx changed → animate a ring expanding from centre.
  const [txPulseAt, setTxPulseAt] = useState<number | null>(null);
  const lastTxSeen = useRef<number | null>(s.chatterLastTx);
  useEffect(() => {
    if (s.chatterLastTx !== null && s.chatterLastTx !== lastTxSeen.current) {
      lastTxSeen.current = s.chatterLastTx;
      setTxPulseAt(performance.now());
    }
  }, [s.chatterLastTx]);

  // rx highlight: newest packet's peer flashes briefly.
  const [rxHighlight, setRxHighlight] = useState<{ peerId: number; at: number } | null>(null);
  const lastPacketSeq = useRef<number | null>(null);
  useEffect(() => {
    const last = s.chatterPackets[s.chatterPackets.length - 1];
    if (last && last.seq !== lastPacketSeq.current) {
      lastPacketSeq.current = last.seq;
      if (last.dir === 'rx' && last.peerId !== undefined) {
        setRxHighlight({ peerId: last.peerId, at: performance.now() });
      }
    }
  }, [s.chatterPackets]);

  // Repaint the graph while a tx pulse or rx highlight is actually animating
  // (~1s bursts), rather than a continuous RAF loop that would re-render the
  // whole view at 60fps even when the room is quiet.
  const [, setAnimTick] = useState(0);
  const animating = txPulseAt !== null || rxHighlight !== null;
  useEffect(() => {
    if (!animating) return;
    let raf = 0;
    const loop = () => {
      const t = performance.now();
      if (txPulseAt !== null && t - txPulseAt >= TX_PULSE_MS) setTxPulseAt(null);
      if (rxHighlight !== null && t - rxHighlight.at >= RX_HIGHLIGHT_MS) setRxHighlight(null);
      setAnimTick((n) => (n + 1) % 100000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animating, txPulseAt, rxHighlight]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  // Seeded from storage, then this state is the source of truth for the field.
  // The nickname is not in the Store because nothing outside this input writes
  // it, and RoomProtocol reads it live off `deps.nickname()` at send time.
  const [nickname, setNicknameState] = useState(() => getNickname());
  const focusId = hoveredId ?? selectedId;

  const now = performance.now();
  const members = s.chatterMembers;
  const focusMember = members.find((m) => m.deviceId === focusId) ?? null;

  // A node the operator addressed can age out of the roster while selected.
  // Fall back to the room rather than leaving a target that no longer exists —
  // same discipline the file path already uses when it resets to 0 after a send.
  useEffect(() => {
    if (sendTargetId !== 0 && !members.some((m) => m.deviceId === sendTargetId)) {
      setSendTargetId(0);
    }
  }, [members, sendTargetId]);

  // Per-node geometry (angle, radius, strength) depends only on deviceId /
  // linkDb — genuinely cheap arithmetic, not worth memoizing against `now`
  // (which changes every render anyway and would make a memo pointless).
  // Age fields are recomputed fresh each render from the same `now`.
  const nodes = members.map((m) => {
    const angle = hashAngle(m.deviceId);
    const strength = linkStrength(m.linkDb);
    // radius: 0.22 (strong link, close) .. MAX_NODE_RADIUS (weak/unmeasured,
    // far). Derived from the constant rather than a second literal 0.92, so
    // graphMetrics's room-for-a-hit-target clamp stays true to what this emits.
    const radius = MIN_NODE_RADIUS + (1 - strength) * (MAX_NODE_RADIUS - MIN_NODE_RADIUS);
    const ageMs = now - m.lastHeardMs;
    const agedOut = ageMs > AGE_OUT_MS;
    return { m, angle, radius, strength, ageMs, agedOut };
  });

  const [graphBoxRef, graphSize] = useMeasuredSize<HTMLDivElement>();
  const [spectrumBoxRef, spectrumSize] = useMeasuredSize<HTMLDivElement>();

  const drawGraph = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const { cx, cy, R } = graphMetrics(w, h);

    // range rings
    ctx.strokeStyle = 'rgba(60,255,122,0.14)';
    ctx.lineWidth = 1;
    for (const f of [0.3, 0.55, 0.8, 1.0]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }

    // tx pulse ring
    if (txPulseAt !== null) {
      const elapsed = performance.now() - txPulseAt;
      if (elapsed >= 0 && elapsed < TX_PULSE_MS) {
        const p = elapsed / TX_PULSE_MS;
        ctx.strokeStyle = `rgba(60,255,122,${(1 - p) * 0.9})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.15 + p * R * 0.95, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // centre — this device
    ctx.fillStyle = s.chatterOn ? T.phosphor : 'rgba(210,210,200,0.4)';
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `bold 11px ${T.mono}`;
    ctx.fillStyle = T.phosphor;
    ctx.textAlign = 'center';
    ctx.fillText(s.chatterOn ? labelFor(s.chatterDeviceId, getNickname()) : 'you', cx, cy + 26);
    ctx.textAlign = 'left';

    if (nodes.length === 0) {
      ctx.font = `12px ${T.mono}`;
      ctx.fillStyle = 'rgba(210,210,200,0.5)';
      ctx.textAlign = 'center';
      ctx.fillText(s.chatterOn ? 'listening — no nodes yet' : 'join the room to scan for nodes', cx, cy + R + 20 > h - 8 ? h - 8 : cy - R - 12);
      ctx.textAlign = 'left';
      return;
    }

    for (const n of nodes) {
      const { x, y } = nodeXY(w, h, n.angle, n.radius);
      const isFocus = focusId === n.m.deviceId;
      const rxFlash = rxHighlight && rxHighlight.peerId === n.m.deviceId && performance.now() - rxHighlight.at < RX_HIGHLIGHT_MS;

      // spoke
      ctx.strokeStyle = n.agedOut ? 'rgba(210,210,200,0.08)' : 'rgba(60,255,122,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();

      const baseOpacity = n.agedOut ? 0.28 : 0.55 + n.strength * 0.45;
      const nodeR = 6 + n.strength * 5;

      if (rxFlash) {
        const p = (performance.now() - rxHighlight!.at) / RX_HIGHLIGHT_MS;
        ctx.strokeStyle = `rgba(73,208,255,${1 - p})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, nodeR + 6 + p * 10, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = n.agedOut
        ? `rgba(210,210,200,${baseOpacity})`
        : `rgba(60,255,122,${baseOpacity})`;
      ctx.beginPath();
      ctx.arc(x, y, nodeR, 0, Math.PI * 2);
      ctx.fill();

      if (isFocus) {
        ctx.strokeStyle = T.amber;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, nodeR + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.font = `10px ${T.mono}`;
      ctx.fillStyle = n.agedOut ? 'rgba(210,210,200,0.4)' : 'rgba(230,230,220,0.85)';
      ctx.textAlign = 'center';
      ctx.fillText(labelFor(n.m.deviceId, n.m.nickname), x, y - nodeR - 6);
      if (n.m.linkDb !== undefined) {
        ctx.font = `9px ${T.mono}`;
        ctx.fillStyle = 'rgba(210,210,200,0.6)';
        ctx.fillText(`${n.m.linkDb.toFixed(0)}dB`, x, y + nodeR + 12);
      }
      ctx.textAlign = 'left';
    }
  };

  const drawSpectrum = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const grid = focusMember?.grid;
    if (!grid || grid.length === 0) {
      ctx.font = `11px ${T.mono}`;
      ctx.fillStyle = 'rgba(210,210,200,0.5)';
      ctx.fillText('select a node to see its spectrum', 8, h / 2);
      return;
    }
    const base = h - 6;
    ctx.strokeStyle = T.cyan;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < grid.length; i++) {
      const x = (i / (grid.length - 1)) * w;
      const y = base - Math.max(0, Math.min(1, grid[i])) * (base - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  /** The two header navigation buttons (log, back to bench). minHeight 44 for
   *  the same reason CollapsibleSection, ChatComposer and actionBtn use it —
   *  this page is driven with a thumb. This replaced a `btn(active, tone)`
   *  factory whose padding of '3px 9px' at fontSize 11 rendered about 19px
   *  tall; its active/amber branches were dead, since both call sites only ever
   *  passed `false`. */
  const navBtn: CSSProperties = {
    fontFamily: T.mono, fontSize: 12, minHeight: 44, padding: '0 12px',
    borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${T.panelEdge}`, background: 'transparent', color: T.panelInk,
  };
  /** The two primary actions. `flex: 1 1 0` so they split the width evenly
   *  whatever their labels say, and minHeight 44 because this page is driven
   *  with a thumb — the same touch floor CollapsibleSection and ChatComposer
   *  use for their controls. */
  const actionBtn: CSSProperties = {
    fontFamily: T.mono, fontSize: 12, letterSpacing: 1, minHeight: 44,
    flex: '1 1 0', cursor: 'pointer',
    border: `1px solid ${T.panelEdge}`, borderRadius: T.radius,
    background: T.panel, color: T.panelInk,
  };
  /**
   * A section's box. Every consumer is a child of the one scrolling column, and
   * a panel that does not contain its own contents overflows onto whatever
   * follows it rather than growing the column.
   *
   * `overflow: hidden` + `minWidth: 0` are the containment half of that, and
   * both are needed. minWidth 0 because a flex child defaults to
   * `min-width: auto` and so refuses to shrink below its content — mono text
   * and canvases both happily demand more width than a 390px phone has.
   * overflow hidden because absolutely-positioned children (the spectrum
   * canvas) and unshrinkable rows (the packet stream) otherwise paint outside
   * the border, and being positioned they land ON their siblings.
   *
   * Callers that scroll re-declare the axis they need AFTER spreading this —
   * `overflowY: 'auto'` on the roster, for instance. A longhand after the
   * shorthand wins on that axis and leaves overflowX clipped, which is exactly
   * the wanted pairing: scroll vertically, never sideways.
   */
  const panel = (highlight = false): CSSProperties => ({
    background: T.panel,
    border: `1px solid ${highlight ? T.phosphor : T.panelEdge}`,
    borderRadius: T.radius,
    padding: 10,
    minWidth: 0,
    overflow: 'hidden',
    boxShadow: highlight ? `0 0 0 1px ${T.phosphorDim}` : undefined,
  });
  const title: CSSProperties = { fontFamily: T.mono, fontSize: 11, letterSpacing: 1, color: T.panelInk, opacity: 0.8, marginBottom: 6 };

  const joinLeaveLabel = pending === 'join' ? 'joining…' : pending === 'leave' ? 'leaving…' : s.chatterOn ? '⏏ LEAVE ROOM' : '☎ JOIN ROOM';
  const notice = s.chatterError ?? localNotice;

  /** Send a dropped/picked file. Goes out as the same `eardrop-file` event
   *  the bench's TxPanel dispatches, so app.ts's existing routing — which
   *  already sends to the room when chatterOn — stays the one place that
   *  decides what a chosen file means. `targetId` is passed explicitly rather
   *  than read from state: a drop is always a broadcast, and a cancelled
   *  file picker must not leave a stale address behind for the next one. */
  const offerFile = (f: File | undefined, targetId: number) => {
    setDragging(false);
    if (!f) return;
    // Say why nothing happened. Silently swallowing the drop when the room
    // isn't ready is indistinguishable from a broken drop target.
    if (!s.chatterOn) {
      dlog('UI', { fileRejected: 'notJoined', name: f.name }, { level: 'warn' });
      setLocalNotice('Join the room before broadcasting a file.');
      return;
    }
    if (s.chatterState !== 'idle') {
      dlog('UI', { fileRejected: 'busy', state: s.chatterState, name: f.name }, { level: 'warn' });
      setLocalNotice(`Busy (${s.chatterState}) — wait until the room is idle, then drop again.`);
      return;
    }
    // An empty file is not a cheap send, it is a full-price one that delivers
    // nothing: splitDataIntoFrames floors at one frame, so the room pays a roll
    // call, a FILE_COMING and the whole transfer's airtime to put a padded
    // empty payload on the air. On a hardware run that produced a receiver log
    // identical in shape to a real transfer that failed to decode — a band card,
    // a clean hop, then silence — and cost a session to tell the two apart.
    if (f.size === 0) {
      dlog('UI', { fileRejected: 'empty', name: f.name }, { level: 'warn' });
      setLocalNotice(`"${f.name}" is empty — nothing to send.`);
      return;
    }
    setLocalNotice(null);
    dlog('UI', {
      fileChosen: f.name, bytes: f.size, to: targetId || 'broadcast',
    }, { level: 'warn' });
    window.dispatchEvent(new CustomEvent('eardrop-file', { detail: { file: f, targetId } }));
    setSendTargetId(0); // next file is a broadcast unless a node is chosen again
  };

  /** Dispatch a chat message the same way a chosen file is dispatched — as an
   *  event app.ts routes, so this view keeps no protocol logic. Unlike a file,
   *  the target is NOT reset afterwards: a conversation with one node is a
   *  run of messages, and clearing the picker after each would make every
   *  follow-up an accidental broadcast. */
  const sendText = (text: string) => {
    setLocalNotice(null);
    dlog('UI', { textSend: text.length, to: sendTargetId || 'broadcast' }, { level: 'warn' });
    window.dispatchEvent(new CustomEvent('eardrop-chatter-text', {
      detail: { text, targetId: sendTargetId },
    }));
  };

  return (
    // Room mode replaces the whole bench, TxPanel's drop zone included — so
    // the mode itself has to accept files, or the "drop a file" affordance is
    // pointing at nothing. dragover must preventDefault or drop never fires.
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); offerFile(e.dataTransfer.files?.[0], 0); }}
      // paddingBottom clears the home indicator on a notched phone. BenchApp
      // pins this mode to the viewport with overflow hidden, so without it the
      // last thing in the column — the chat composer — sits under the system
      // gesture area, where a tap belongs to the OS rather than to us.
      style={{
        display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0,
        position: 'relative', paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <input
        id="roommode-file"
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => { offerFile(e.target.files?.[0], sendTargetId); e.target.value = ''; }}
      />
      {dragging && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.55)', border: `2px dashed ${T.phosphor}`, borderRadius: 6,
          fontFamily: T.mono, fontSize: 16, color: T.phosphor, letterSpacing: 1,
        }}>
          {s.chatterOn ? 'release to broadcast to the room' : 'join the room first to broadcast'}
        </div>
      )}
      {showLog && <LogShare onClose={() => setShowLog(false)} />}
      {/* WRAPS rather than switching layout at a breakpoint. Unwrapped, this
       *  row carried ~430px of content — a 15px-mono title, the state pill and
       *  two nav buttons — into a 390px phone viewport, and `space-between`
       *  simply overflowed it. flexWrap plus `marginLeft: auto` on the button
       *  group gives one space-between row at desktop width and two stacked
       *  rows on a phone, from a single declaration. A media query would mean a
       *  second layout tree to keep in step, which is exactly what this file's
       *  one-column-at-every-width rule exists to avoid. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, rowGap: 8,
        marginBottom: 10, flex: '0 0 auto',
      }}>
        <span style={{ fontFamily: T.mono, fontSize: 15, letterSpacing: 1, color: T.panelInk }}>ROOM MODE — nodes &amp; packets</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
          <span style={{
            fontFamily: T.mono, fontSize: 11, padding: '3px 10px', borderRadius: 4,
            border: `1px solid ${s.chatterOn ? T.phosphor : T.panelEdge}`,
            background: s.chatterOn ? T.phosphorDim : 'rgba(0,0,0,0.04)',
            color: s.chatterOn ? T.phosphor : T.panelInk,
            letterSpacing: 1,
          }}>
            {s.chatterOn ? s.chatterState.toUpperCase() : 'OFF'}
          </span>
          {/* Join/Leave lives in the action row further down, not up here:
              it is one of the two things that put something on the air, and it
              belongs at a thumb-sized target next to "send file" rather than
              squeezed into a header beside two navigation buttons. */}
          <button onClick={() => setShowLog(true)} style={navBtn}>▤ log</button>
          <button onClick={onExit} style={navBtn}>← back to bench</button>
        </div>
      </div>

      {/* What the radio is doing right now, and on which devices. Chatter is
       *  half duplex over real speakers and mics: if it plays out of the wrong
       *  output the room never hears it, so the devices in use belong on
       *  screen next to the phase rather than buried in the bench settings. */}
      {/* Wraps for the same reason as the header row: at phone width the phase
       *  sentence and the mic/out line together overrun a single row, and
       *  `space-between` crushed the phase text — the one line that says
       *  whether the radio is working. Wrapped, the device line drops beneath
       *  it instead. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between',
        alignItems: 'baseline', gap: 12, rowGap: 4,
        marginBottom: 10, flex: '0 0 auto', fontFamily: T.mono, fontSize: 11,
      }}>
        <span style={{ color: s.chatterOn ? T.phosphor : T.panelInk, opacity: s.chatterOn ? 1 : 0.7 }}>
          {pending === 'join'
            ? 'starting microphone and joining…'
            : PHASE_TEXT[s.chatterOn ? s.chatterState : 'off'] ?? s.chatterState}
        </span>
        <span style={{ color: T.panelInk, opacity: 0.7 }}>
          mic {s.selectedInputLabel || 'default'} · out {s.selectedOutputId ? 'selected' : 'system default'}
        </span>
      </div>

      {notice && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.led, marginBottom: 10, flex: '0 0 auto' }}>
          ⚠ {notice}
        </div>
      )}

      {/* One vertical column at every width — see the file header for why.
       *  overflowY is not optional: BenchApp pins this mode to 100vh with
       *  overflow hidden, so without a scroll container here anything past the
       *  fold is clipped with no way to reach it. The floors below are kept low
       *  enough that the composer fits on a phone-class viewport unscrolled;
       *  this is the safety net for the ones where it does not. */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
      }}>
        {/* Graph — grows into the column's surplus when open (via CollapsibleSection's
         *  `grow`, which has to be set on the section itself: a growing wrapper
         *  around it cannot push height through a default-basis flex item), and
         *  collapses to its header strip when shut. */}
        <CollapsibleSection
          title={`NODE GRAPH — ${s.chatterOn ? `this device is ${labelFor(s.chatterDeviceId, getNickname())}` : 'not joined'}`}
          summary={`${members.length} node${members.length === 1 ? '' : 's'}`}
          open={graphOpen}
          onToggle={() => setGraphOpen((v) => !v)}
          grow
        >
          {/* basis 0, not auto: the box's height must come from the flex
           *  line alone, never from what it contains. The floor is 120, not
           *  the 220 this started at — the column has to fit inside a pinned
           *  viewport, and a 220px floor here plus the other hard minimums
           *  pushed the chat composer past the clip line on a phone. 120px
           *  still gives the graph a ~53px radius, enough for the node labels. */}
          {/* overflow hidden is the safety net under graphMetrics's clamp, and
           *  it is not redundant with it. Every child here is absolutely
           *  positioned, so a measurement that lags a shrink — the canvas is
           *  sized in fixed px from the last measured box — leaves a child
           *  larger than the box it sits in. Positioned elements paint above
           *  the later, non-positioned action-button row whatever the DOM
           *  order says, so anything that escapes lands ON the two buttons
           *  that put something on the air. Clip once, here, and no
           *  measurement race can reach them. */}
          <div ref={graphBoxRef} style={{ position: 'relative', flex: '1 1 0', minHeight: 120, overflow: 'hidden' }}>
            {graphSize.w > 0 && graphSize.h > 0 && (
              <>
                {/* Absolutely positioned so the canvas contributes NOTHING to
                 *  this box's content size. In normal flow it fed its own
                 *  measured height back into the box's `flex: 1 1 auto`
                 *  basis, so every measurement grew the box and re-triggered
                 *  the observer — the panel visibly pulsed. */}
                <div style={{ position: 'absolute', inset: 0 }}>
                  <Screen width={graphSize.w} height={graphSize.h} draw={drawGraph} grid={false} />
                </div>
                {/* invisible hit-targets over each node, so the canvas graph stays hover/select-able */}
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  {nodes.map((n) => {
                    const { x, y } = nodeXY(graphSize.w, graphSize.h, n.angle, n.radius);
                    return (
                      <div
                        key={n.m.deviceId}
                        onMouseEnter={() => setHoveredId(n.m.deviceId)}
                        onMouseLeave={() => setHoveredId((h2) => (h2 === n.m.deviceId ? null : h2))}
                        onClick={() => setSelectedId((sel) => (sel === n.m.deviceId ? null : n.m.deviceId))}
                        // NODE_TARGET_PX (44), not the 24px this started as: a
                        // node is selected with a thumb on a phone, and 24px is
                        // well under a comfortable touch target. The offsets are
                        // half the size so the circle stays centred on the node
                        // the canvas drew at the same (x, y). The constant is
                        // shared with graphMetrics, which reserves exactly this
                        // much room at the edge — read from one place so the two
                        // cannot drift and start spilling onto the buttons.
                        style={{
                          position: 'absolute',
                          left: x - NODE_TARGET_PX / 2, top: y - NODE_TARGET_PX / 2,
                          width: NODE_TARGET_PX, height: NODE_TARGET_PX,
                          borderRadius: '50%', pointerEvents: 'auto', cursor: 'pointer',
                        }}
                        title={`${labelFor(n.m.deviceId, n.m.nickname)} · ${formatAgo(n.ageMs)}${n.m.linkDb !== undefined ? ` · ${n.m.linkDb.toFixed(0)}dB` : ''}`}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </CollapsibleSection>

        {/* The two actions that put something on the air. */}
        <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
          <button
            type="button"
            style={actionBtn}
            onClick={() => document.getElementById('roommode-file')?.click()}
          >
            send file
          </button>
          <button
            type="button"
            style={actionBtn}
            disabled={pending !== null}
            onClick={() => {
              // User actions belong in the log: without them a dump shows the
              // radio reacting to nothing, and there is no way to tell a
              // protocol that never started from one that started and failed.
              dlog('UI', { pressed: s.chatterOn ? 'leave' : 'join' }, { level: 'warn' });
              setPending(s.chatterOn ? 'leave' : 'join');
              setLocalNotice(null);
              dispatch(s.chatterOn ? 'eardrop-chatter-leave' : 'eardrop-chatter-join');
            }}
          >
            {joinLeaveLabel}
          </button>
        </div>

        <CollapsibleSection
          title="ROSTER"
          summary={`${members.length} nodes`}
          open={rosterOpen}
          onToggle={() => setRosterOpen((v) => !v)}
        >
          <div style={{ ...panel(false), overflowY: 'auto', minHeight: 0, maxHeight: 200 }}>
            {!s.chatterOn && (
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6 }}>
                Join the room to see who else is around.
              </div>
            )}
            {s.chatterOn && members.length === 0 && (
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6 }}>
                (no other members heard yet)
              </div>
            )}
            {s.chatterOn && members.length > 0 && (
              // No per-node "send file to" button any more: the composer's
              // recipient picker addresses files and text alike, so a second
              // way to choose a target would be a second source of truth.
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontFamily: T.mono, fontSize: 11 }}>
                {/* This device, and the only place its nickname can be set. The
                 *  name goes out in every WELCOME, so peers see it too — which
                 *  is the point: a room of hex ids cannot say which node is the
                 *  phone in your hand. Sanitizing on change (not on blur) means
                 *  the field always shows exactly what will go on the air,
                 *  including the byte cap. */}
                <li style={{ marginBottom: 8, minHeight: 44, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ opacity: 0.7, flex: '0 0 auto' }}>this device</span>
                  <input
                    aria-label="nickname for this device"
                    value={nickname}
                    placeholder={defaultNickname()}
                    onChange={(e) => setNicknameState(setNickname(e.target.value))}
                    style={{
                      flex: '1 1 auto', minWidth: 0, minHeight: 32,
                      fontFamily: T.mono, fontSize: 11,
                      color: T.phosphor, background: 'rgba(0,0,0,0.35)',
                      border: `1px solid ${T.phosphor}`, borderRadius: 3,
                      padding: '4px 6px',
                    }}
                  />
                  <span style={{ opacity: 0.5, flex: '0 0 auto' }}>
                    {`${new TextEncoder().encode(nickname).length}/${NICKNAME_MAX_BYTES}B`}
                  </span>
                </li>
                {nodes.map(({ m, ageMs, agedOut }) => (
                  <li
                    key={m.deviceId}
                    onMouseEnter={() => setHoveredId(m.deviceId)}
                    onMouseLeave={() => setHoveredId((h2) => (h2 === m.deviceId ? null : h2))}
                    onClick={() => setSelectedId((sel) => (sel === m.deviceId ? null : m.deviceId))}
                    style={{
                      marginBottom: 4, minHeight: 28, cursor: 'pointer',
                      opacity: agedOut ? 0.4 : 1,
                      textDecoration: agedOut ? 'line-through' : 'none',
                      color: selectedId === m.deviceId ? T.amber : undefined,
                    }}
                  >
                    <span style={{ color: T.phosphor }}>{labelFor(m.deviceId, m.nickname)}</span>
                    {` · ${formatAgo(ageMs)}`}
                    {m.linkDb !== undefined && <span style={{ opacity: 0.7 }}>{` · ${m.linkDb.toFixed(0)}dB`}</span>}
                    {agedOut && <span style={{ opacity: 0.7 }}> · aged out</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="SPECTRUM"
          summary={focusMember ? `node ${labelFor(focusMember.deviceId, focusMember.nickname)}` : 'no node selected'}
          open={spectrumOpen}
          onToggle={() => setSpectrumOpen((v) => !v)}
        >
          <div style={{ ...panel(false), display: 'flex', flexDirection: 'column' }}>
            {/* 90px basis, but shrinkable: the column lives inside a pinned
             *  viewport, so every box that CAN give height back should. The
             *  minHeight floors it at 60 either way. */}
            {/* overflow hidden for the same reason as the graph box: the canvas
             *  inside is absolutely positioned at a fixed px size taken from the
             *  last measurement, so any lag behind a shrink leaves it larger
             *  than this box — and a positioned child paints above the
             *  non-positioned siblings that follow. */}
            <div ref={spectrumBoxRef} style={{ position: 'relative', flex: '1 1 90px', minHeight: 60, overflow: 'hidden' }}>
              {spectrumSize.w > 0 && spectrumSize.h > 0 && (
                // Out of flow for the same reason as the graph canvas above.
                <div style={{ position: 'absolute', inset: 0 }}>
                  <Screen width={spectrumSize.w} height={spectrumSize.h} draw={drawSpectrum} grid={false} />
                </div>
              )}
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="PACKETS"
          summary={String(s.chatterPackets.length)}
          open={packetsOpen}
          onToggle={() => setPacketsOpen((v) => !v)}
        >
          <div style={{ ...panel(false), display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: 220 }}>
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
              <PacketStream packets={s.chatterPackets} now={now} />
            </div>
          </div>
        </CollapsibleSection>

        {/* Chat — flexes so it takes the space the collapsed panels give back.
         *  The composer plus one line of transcript is what has to survive on a
         *  phone, and anything above that is slack it can claim.
         *
         *  The floor is CHAT_MIN_HEIGHT, measured rather than guessed. At the
         *  120 it was, this panel could not fit its own contents: the composer
         *  alone renders 117px (recipient picker, byte counter, the disabled
         *  notice, then the input row), and with the title above it the panel
         *  needed 203. It was flexed down to 120 anyway and the send button was
         *  simply gone — clipped, once panel() started containing its overflow;
         *  painted over the section below, before that. Where the whole column
         *  no longer fits, the column scrolls; that is what its overflowY is
         *  for, and it is the right trade against an unreachable send button. */}
        <div style={{ ...panel(false), display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: CHAT_MIN_HEIGHT }}>
          <div style={title}>CHAT</div>
          <ChatMessageList
            messages={s.chatterMessages}
            roomState={s.chatterOn ? s.chatterState : 'off'}
            nowMs={now}
            onResend={sendText}
          />
          <ChatComposer
            targetId={sendTargetId}
            onTargetChange={setSendTargetId}
            nodeIds={members.map((m) => m.deviceId)}
            onSend={sendText}
            disabledReason={s.chatterOn ? null : 'join the room to send a message'}
          />
        </div>
      </div>
    </div>
  );
}
