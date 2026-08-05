// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { ChatComposer } from './ChatComposer';
import { TEXT_MAX_BYTES } from '../../modem/protocol/controlFrame';

const props = {
  targetId: 0,
  onTargetChange: () => {},
  nodeIds: [0xa7, 0x3f],
  onSend: () => {},
  disabledReason: null as string | null,
};

describe('ChatComposer', () => {
  // vitest.config.ts has no test.globals, so RTL's automatic afterEach(cleanup)
  // never registers itself. Every test here calls render(), so without this
  // the DOM leaks between tests and getByRole queries match stray elements
  // left over from earlier tests.
  afterEach(cleanup);

  it('sends the typed text and clears the input', () => {
    const onSend = vi.fn();
    const { getByRole } = render(<ChatComposer {...props} onSend={onSend} />);
    const input = getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello room' } });
    // fireEvent.click (not a bare .click()) matters here: vitest.config.ts has
    // no test.globals/setupFiles, so nothing installs React's act() environment
    // automatically. A native .click() dispatches the event but the resulting
    // setState is flushed through React 19's normal (async) scheduler, so the
    // input.value assertion below would race the re-render. fireEvent.click
    // wraps the dispatch in act() and flushes synchronously before returning.
    fireEvent.click(getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith('hello room');
    expect(input.value).toBe('');
  });

  it('will not send empty or whitespace-only text', () => {
    const onSend = vi.fn();
    const { getByRole } = render(<ChatComposer {...props} onSend={onSend} />);
    const send = getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(getByRole('textbox'), { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    send.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes rather than characters', () => {
    // 10 emoji are 40 bytes but only 10 (or 20) JS string units. Counting
    // characters would let a message through that packText then throws on.
    const { getByRole, getByText } = render(<ChatComposer {...props} />);
    fireEvent.change(getByRole('textbox'), { target: { value: '🦻'.repeat(10) } });
    expect(getByText(new RegExp(`40\\s*/\\s*${TEXT_MAX_BYTES}`))).toBeTruthy();
  });

  it('allows exactly the cap and refuses one byte more', () => {
    const { getByRole } = render(<ChatComposer {...props} />);
    const input = getByRole('textbox');
    const send = getByRole('button', { name: /send/i }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: 'x'.repeat(TEXT_MAX_BYTES) } });
    expect(send.disabled).toBe(false);

    fireEvent.change(input, { target: { value: 'x'.repeat(TEXT_MAX_BYTES + 1) } });
    expect(send.disabled).toBe(true);
  });

  it('disables send and shows why when the room is not ready', () => {
    const { getByRole, getByText } = render(
      <ChatComposer {...props} disabledReason="join the room first" />,
    );
    fireEvent.change(getByRole('textbox'), { target: { value: 'hi' } });
    expect((getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(getByText('join the room first')).toBeTruthy();
    // The INPUT stays enabled while send is blocked, deliberately: the outbox
    // queues a message and holds it until the transmitter is free, so blocking
    // typing would fight it and stop the operator drafting a reply while
    // another device is talking. Pinned because a refactor that gave the input
    // and the button one shared `disabled` prop would reintroduce that
    // silently, with a green suite.
    expect((getByRole('textbox') as HTMLInputElement).disabled).toBe(false);
  });

  it('offers the room plus every known node, and reports a change', () => {
    const onTargetChange = vi.fn();
    const { getByRole } = render(
      <ChatComposer {...props} onTargetChange={onTargetChange} />,
    );
    const picker = getByRole('combobox') as HTMLSelectElement;
    expect(picker.options.length).toBe(3); // room + two nodes
    fireEvent.change(picker, { target: { value: String(0xa7) } });
    expect(onTargetChange).toHaveBeenCalledWith(0xa7);
  });
});
