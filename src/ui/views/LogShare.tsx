/**
 * LogShare.tsx — read the session log on a device with no reachable console.
 *
 * Desktop debugging leans on DevTools; a phone has none, and the two-device
 * chatter work is exactly where the phone's log matters most (whether the
 * browser honoured the capture constraints, what its real sample rate is,
 * how far a decode actually got). This shows the same dump the bench header
 * copies, on screen, plus the ways a phone can actually get text off itself:
 * the native share sheet, a downloaded file, or the clipboard.
 *
 * Everything is local — the text goes to the OS share sheet or a file the
 * user chooses to send. Nothing is uploaded anywhere.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { dlogDump, dlogRecords, DLOG_RING_MAX } from '../../lib/debug/dlog';
import { compressRecords } from '../../lib/debug/llmDump';
import { flushLogReporter, logReporterEnabled, onLogReporterChange } from '../../lib/debug/logReporter';
import { T } from '../theme/labaccent/tokens';

const btn = (accent = false): React.CSSProperties => ({
  fontFamily: T.mono, fontSize: 12, padding: '6px 12px', borderRadius: T.radius,
  cursor: 'pointer', border: `1px solid ${accent ? T.phosphor : T.panelEdge}`,
  background: accent ? T.phosphorDim : 'rgba(0,0,0,0.04)',
  color: accent ? T.phosphor : T.panelInk,
});

export function LogShare({ onClose }: { onClose: () => void }) {
  const [compact, setCompact] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  // onLogReporterChange is a stable module-level function (not a fresh lambda
  // per render), so passing it directly here doesn't resubscribe every
  // render. No getServerSnapshot: this view is never server-rendered.
  const pcConnected = useSyncExternalStore(onLogReporterChange, logReporterEnabled);

  // Snapshot per view/toggle rather than per render: the log keeps growing
  // while this panel is open, and text shifting under a finger mid-select is
  // maddening on a touch screen.
  const text = useMemo(
    () => (compact ? compressRecords(dlogRecords()) : dlogDump(DLOG_RING_MAX)),
    [compact],
  );

  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(null), 2000); };

  const share = useCallback(async () => {
    // The one route that actually gets text OFF a phone in one step —
    // straight into mail/messages/AirDrop. Absent on desktop browsers.
    if (!navigator.share) { flash('sharing not supported here — use download or copy'); return; }
    try {
      await navigator.share({ title: 'Eardrop log', text });
    } catch {
      /* user dismissed the sheet — not an error */
    }
  }, [text]);

  const download = useCallback(() => {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eardrop-log-${compact ? 'compact' : 'raw'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    flash('saved to your downloads');
  }, [text, compact]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      flash('copied');
    } catch {
      // Clipboard access needs a secure context and a user gesture, and is
      // refused often enough on mobile that a dead button would be confusing.
      flash('clipboard refused — select the text below instead');
    }
  }, [text]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50, background: T.panel,
      display: 'flex', flexDirection: 'column', padding: 12, gap: 10,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 14, color: T.panelInk, marginRight: 'auto' }}>
          SESSION LOG
        </span>
        <button style={btn(compact)} onClick={() => setCompact(true)}>compact</button>
        <button style={btn(!compact)} onClick={() => setCompact(false)}>raw</button>
        <button style={btn(true)} onClick={share}>share</button>
        <button style={btn()} onClick={download}>download</button>
        <button style={btn()} onClick={copy}>copy</button>
        <button style={btn()} onClick={onClose}>close</button>
        {pcConnected && (
          <>
            {/* Only rendered once startLogReporter's startup probe has
             *  succeeded — absent on GitHub Pages, where no LAN server
             *  exists to send to. */}
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.phosphor }}>
              PC: connected
            </span>
            <button
              type="button"
              style={btn(true)}
              onClick={() => {
                void flushLogReporter().then(
                  () => flash('sent to PC'),
                  () => flash('send failed'),
                );
              }}
            >
              send to PC
            </button>
          </>
        )}
      </div>
      {note && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.amber }}>{note}</div>
      )}
      {/* A textarea, not a <pre>: selection and scrolling inside one are far
       *  more reliable on mobile than long-pressing rendered text. */}
      <textarea
        readOnly
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        style={{
          flex: '1 1 auto', minHeight: 0, width: '100%', resize: 'none',
          fontFamily: T.mono, fontSize: 11, lineHeight: 1.45,
          background: T.screenBg, color: T.phosphor,
          border: `1px solid ${T.panelEdge}`, borderRadius: T.radius, padding: 8,
        }}
      />
      <div style={{ fontFamily: T.mono, fontSize: 10, color: T.panelInk, opacity: 0.7 }}>
        {text.length} chars · stays on this device unless you share or download it
      </div>
    </div>
  );
}
