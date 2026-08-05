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

/** Shared centre/radius geometry — used by both the canvas draw and the
 *  overlay hit-targets so they can never desync. */
function graphMetrics(w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.44;
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
    // radius: 0.22 (strong link, close) .. 0.92 (weak/unmeasured, far)
    const radius = 0.22 + (1 - strength) * 0.70;
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
    ctx.fillText(s.chatterOn ? hex(s.chatterDeviceId) : 'you', cx, cy + 26);
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
      ctx.fillText(hex(n.m.deviceId), x, y - nodeR - 6);
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

  const btn = (active: boolean, tone: 'phosphor' | 'amber' = 'phosphor'): CSSProperties => {
    const color = tone === 'amber' ? T.amber : T.phosphor;
    return {
      fontFamily: T.mono, fontSize: 11, padding: '3px 9px', borderRadius: 4, cursor: 'pointer',
      border: `1px solid ${active ? color : T.panelEdge}`,
      background: active ? (tone === 'amber' ? 'rgba(255,176,58,0.18)' : T.phosphorDim) : 'transparent',
      color: active ? color : T.panelInk,
    };
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
  const panel = (highlight = false): CSSProperties => ({
    background: T.panel,
    border: `1px solid ${highlight ? T.phosphor : T.panelEdge}`,
    borderRadius: T.radius,
    padding: 10,
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
      style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, position: 'relative' }}
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flex: '0 0 auto' }}>
        <span style={{ fontFamily: T.mono, fontSize: 15, letterSpacing: 1, color: T.panelInk }}>ROOM MODE — nodes &amp; packets</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
          <button onClick={() => setShowLog(true)} style={btn(false)}>▤ log</button>
          <button onClick={onExit} style={btn(false)}>← back to bench</button>
        </div>
      </div>

      {/* What the radio is doing right now, and on which devices. Chatter is
       *  half duplex over real speakers and mics: if it plays out of the wrong
       *  output the room never hears it, so the devices in use belong on
       *  screen next to the phase rather than buried in the bench settings. */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
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
          title={`NODE GRAPH — ${s.chatterOn ? `this device is ${hex(s.chatterDeviceId)}` : 'not joined'}`}
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
          <div ref={graphBoxRef} style={{ position: 'relative', flex: '1 1 0', minHeight: 120 }}>
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
                        // 44px, not the 24px this started as: a node is
                        // selected with a thumb on a phone, and 24px is well
                        // under a comfortable touch target. The offsets are
                        // half the size so the circle stays centred on the
                        // node the canvas drew at the same (x, y).
                        style={{
                          position: 'absolute', left: x - 22, top: y - 22, width: 44, height: 44,
                          borderRadius: '50%', pointerEvents: 'auto', cursor: 'pointer',
                        }}
                        title={`${hex(n.m.deviceId)} · ${formatAgo(n.ageMs)}${n.m.linkDb !== undefined ? ` · ${n.m.linkDb.toFixed(0)}dB` : ''}`}
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
                    <span style={{ color: T.phosphor }}>{hex(m.deviceId)}</span>
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
          summary={focusMember ? `node ${hex(focusMember.deviceId)}` : 'no node selected'}
          open={spectrumOpen}
          onToggle={() => setSpectrumOpen((v) => !v)}
        >
          <div style={{ ...panel(false), display: 'flex', flexDirection: 'column' }}>
            {/* 90px basis, but shrinkable: the column lives inside a pinned
             *  viewport, so every box that CAN give height back should. The
             *  minHeight floors it at 60 either way. */}
            <div ref={spectrumBoxRef} style={{ position: 'relative', flex: '1 1 90px', minHeight: 60 }}>
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
         *  The floor is 120, down from 160, for the same budget reason as the
         *  graph box: the composer plus one line of transcript is what has to
         *  survive on a phone, and anything above that is slack it can claim. */}
        <div style={{ ...panel(false), display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 120 }}>
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
