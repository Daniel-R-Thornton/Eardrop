/**
 * RoomMode.tsx — full-screen "room mode": the chatter room, presentation-
 * style. Centrepiece is a hand-drawn constellation graph (this device at
 * the centre, each detected member placed around it by link quality), a live
 * packet stream, and a per-node spectrum sparkline. Mirrors the layout idiom
 * of PresentationMode.tsx (header with an onExit "back to bench" button,
 * beige panel sections) but reads only from the Store + dispatches the same
 * join/leave events ChatterPanel already uses — no protocol logic here.
 *
 * The graph and spectrum canvases are sized from their container via
 * ResizeObserver (see useMeasuredSize below), not hardcoded pixels, so the
 * graph is a genuine hero at any viewport width and the mode fills the
 * screen instead of stranding a small canvas in a sea of empty panel.
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useStore } from '../Store';
import { T } from '../theme/labaccent/tokens';
import { Screen } from '../components/instrument/Screen';
import { PacketStream } from './RoomModePacketStream';
import { hex, formatAgo } from './roomModeFormat';

const dispatch = (type: string) => window.dispatchEvent(new CustomEvent(type));

/** Members past this age are shown dimmed/aged-out on the graph and roster —
 *  display-only; RoomProtocol owns its own membership timeout separately. */
const AGE_OUT_MS = 5 * 60 * 1000;

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

/** Tracks an element's content-box size via ResizeObserver so a canvas can be
 *  sized to fill its container instead of a hardcoded pixel box. */
function useMeasuredSize<T extends HTMLElement>(): [RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({ w: Math.max(0, Math.floor(entry.contentRect.width)), h: Math.max(0, Math.floor(entry.contentRect.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
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
          <button
            style={btn(pending !== null ? true : !s.chatterOn, pending !== null ? 'amber' : 'phosphor')}
            disabled={pending !== null}
            onClick={() => {
              setPending(s.chatterOn ? 'leave' : 'join');
              setLocalNotice(null);
              dispatch(s.chatterOn ? 'eardrop-chatter-leave' : 'eardrop-chatter-join');
            }}
          >
            {joinLeaveLabel}
          </button>
          <button onClick={onExit} style={btn(false)}>← back to bench</button>
        </div>
      </div>

      {notice && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.led, marginBottom: 10, flex: '0 0 auto' }}>
          ⚠ {notice}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 12, flex: '1 1 auto', minHeight: 0 }}>
        {/* left column: the graph (hero) + spectrum */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, height: '100%' }}>
          <div style={{ ...panel(true), flex: '1 1 70%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, flex: '0 0 auto' }}>
              <span style={title as CSSProperties}>NODE GRAPH — {s.chatterOn ? `this device is ${hex(s.chatterDeviceId)}` : 'not joined'}</span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.7 }}>
                {members.length} node{members.length === 1 ? '' : 's'} detected
              </span>
            </div>
            <div ref={graphBoxRef} style={{ position: 'relative', flex: '1 1 auto', minHeight: 220 }}>
              {graphSize.w > 0 && graphSize.h > 0 && (
                <>
                  <Screen width={graphSize.w} height={graphSize.h} draw={drawGraph} grid={false} />
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
                          style={{
                            position: 'absolute', left: x - 12, top: y - 12, width: 24, height: 24,
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
          </div>

          <div style={{ ...panel(false), flex: '0 0 180px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...title, flex: '0 0 auto' }}>
              SPECTRUM {focusMember ? `— node ${hex(focusMember.deviceId)}` : ''}
            </div>
            <div ref={spectrumBoxRef} style={{ position: 'relative', flex: '1 1 auto', minHeight: 60 }}>
              {spectrumSize.w > 0 && spectrumSize.h > 0 && (
                <Screen width={spectrumSize.w} height={spectrumSize.h} draw={drawSpectrum} grid={false} />
              )}
            </div>
          </div>
        </div>

        {/* right column: roster + packet stream */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, height: '100%' }}>
          <div style={{ ...panel(false), flex: '0 1 40%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...title, flex: '0 0 auto' }}>ROSTER</div>
            <div style={{ overflowY: 'auto', minHeight: 0, flex: '1 1 auto' }}>
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
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontFamily: T.mono, fontSize: 11 }}>
                  {nodes.map(({ m, ageMs, agedOut }) => (
                    <li
                      key={m.deviceId}
                      onMouseEnter={() => setHoveredId(m.deviceId)}
                      onMouseLeave={() => setHoveredId((h2) => (h2 === m.deviceId ? null : h2))}
                      onClick={() => setSelectedId((sel) => (sel === m.deviceId ? null : m.deviceId))}
                      style={{
                        marginBottom: 4, cursor: 'pointer',
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
              {s.chatterOn && s.chatterState === 'idle' && (
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6, marginTop: 8 }}>
                  drop a file anywhere to broadcast
                </div>
              )}
            </div>
          </div>

          <div style={{ ...panel(false), flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...title, flex: '0 0 auto' }}>PACKETS {s.chatterPackets.length ? `(${s.chatterPackets.length})` : ''}</div>
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
              <PacketStream packets={s.chatterPackets} now={now} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
