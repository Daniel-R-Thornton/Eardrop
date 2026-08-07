/**
 * CollapsibleSection — a titled panel on the room page that can be shut to a
 * one-line strip.
 *
 * Controlled: the parent owns the boolean, because RoomMode seeds all four
 * sections from `isWideViewport()` at mount and needs them in its own state.
 *
 * Children are NOT rendered while closed, which matters beyond saving a few
 * nodes: the graph and spectrum canvases size themselves from a ResizeObserver,
 * and a canvas left mounted inside a hidden box measures zero. Unmounting keeps
 * that from happening — but it only gets the canvas back if the consumer
 * re-measures the box that remounts. RoomMode's useMeasuredSize uses a callback
 * ref for exactly that reason; a ref read once at mount leaves a
 * initially-closed section permanently blank. Unmounting here is half of the
 * contract, not all of it.
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
  title, summary, open, onToggle, grow = false, children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  /**
   * Let this section grow into the surplus height of its flex line.
   *
   * Off by default, and it must stay that way: a collapsed section is a
   * fixed-height strip, and several growing siblings would divide the page
   * between their header bars. The one caller that needs it is RoomMode's graph.
   * Without it the root below is a flex item at the default `0 1 auto`, so its
   * height is its content height — a growing WRAPPER around this component
   * cannot pass that growth through, and the surplus shows up as dead space
   * above the section rather than a bigger canvas inside it.
   */
  grow?: boolean;
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
    <div style={{
      display: 'flex', flexDirection: 'column',
      // `0 0 auto` for a non-growing section — it must NOT shrink. This was
      // `undefined` (i.e. the default `0 1 auto`) alongside an unconditional
      // `minHeight: 0`, which together said "you may be squashed to nothing".
      // In RoomMode's height-constrained column that is exactly what happened
      // on a phone: every section was compressed below its own content height,
      // and since the root does not clip, its contents painted straight over
      // the section beneath. The roster's text landed under the SPECTRUM
      // header, the spectrum's under its canvas, the packet list's under CHAT.
      //
      // Refusing to shrink is right because the column that holds these
      // sections is `overflowY: auto`. Excess height is meant to become scroll,
      // not overlap. Only the growing section keeps minHeight 0, because it is
      // the one that is supposed to absorb and give back the surplus.
      // The growing section keeps no `minHeight: 0`, so its automatic minimum
      // size (min-height: auto) is content-based. It may still absorb surplus
      // height, but it can no longer be squashed below what it holds. With
      // minHeight 0 here, a tight column compressed this wrapper to ~42px while
      // the graph box inside kept its own 120px floor — and the 78px difference
      // painted over the send-file / join-room buttons directly beneath. That
      // was the "radar covers the buttons" report, one level up from the
      // per-node hit-targets. Excess now becomes scroll on the column, which is
      // what its overflowY is for.
      ...(grow && open
        ? { flex: '1 1 auto' }
        : { flex: '0 0 auto' }),
    }}>
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
