/**
 * CollapsibleSection — a titled panel on the room page that can be shut to a
 * one-line strip.
 *
 * Controlled: the parent owns the boolean, because RoomMode seeds all four
 * sections from `isWideViewport()` at mount and needs them in its own state.
 *
 * Children are NOT rendered while closed, which matters beyond saving a few
 * nodes: the graph and spectrum canvases size themselves from a
 * ResizeObserver, and a canvas left mounted inside a hidden box measures zero
 * and does not recover when reopened. Unmounting means it re-measures cleanly.
 *
 * `summary` is what the section says while shut — a node count, a packet
 * count — so collapsing it costs the number but not the awareness.
 */
import { type CSSProperties, type ReactNode } from 'react';
import { T } from '../theme/labaccent/tokens';

/** Minimum header height. 44px is the smallest comfortable touch target, and
 *  this page is meant to be driven from a phone. */
const HEADER_MIN_HEIGHT = 44;

export function CollapsibleSection({
  title, summary, open, onToggle, children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const header: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    width: '100%', minHeight: HEADER_MIN_HEIGHT, padding: '4px 10px',
    background: T.panel, border: `1px solid ${T.panelEdge}`, borderRadius: T.radius,
    fontFamily: T.mono, fontSize: 11, letterSpacing: 1, color: T.panelInk,
    cursor: 'pointer', textAlign: 'left',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <button type="button" style={header} onClick={onToggle} aria-expanded={open}>
        {/* Caret and title live in separate spans rather than one
            `{caret} {title}` span: RTL's getByText matches a node by its OWN
            full text, so a shared span whose text is "▸ ROSTER" never
            satisfies getByText('ROSTER') — the title needs a node with
            nothing else in it. The wrapping span below still doesn't collide:
            getByText matches each element's own textContent, and among
            matches at different nesting depths only the most specific one
            is kept, so the inner title span wins the query on its own. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span>{title}</span>
        </span>
        {summary !== undefined && <span style={{ opacity: 0.7 }}>{summary}</span>}
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
          {children}
        </div>
      )}
    </div>
  );
}
