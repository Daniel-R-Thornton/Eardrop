// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatMessageList } from './ChatMessageList';
import type { ChatMessage } from '../Store';

const base: ChatMessage = {
  seq: 1, msgId: 3, senderId: 1, targetId: 0, text: 'hello room',
  tMs: 1000, dir: 'tx', ackedBy: [], state: 'sending',
};
const props = { ownDeviceId: 1, roomState: 'idle', nowMs: 5000, onResend: () => {} };

describe('ChatMessageList', () => {
  // vitest.config.ts has no test.globals, so RTL's automatic afterEach(cleanup)
  // never registers. Every test here renders, so without this every test after
  // the first would see DOM left over from earlier ones.
  afterEach(cleanup);

  it('shows an empty hint when there are no messages', () => {
    const { getByText } = render(<ChatMessageList messages={[]} {...props} />);
    expect(getByText(/no messages/i)).toBeTruthy();
  });

  it('shows air time and elapsed for a message being sent from an idle room', () => {
    const { getByText } = render(<ChatMessageList messages={[base]} {...props} />);
    expect(getByText('hello room')).toBeTruthy();
    // 4s elapsed (5000 - 1000), and 'hello room' is 10 bytes.
    expect(getByText(/sending/i).textContent).toMatch(/4s/);
  });

  it('says the message is waiting when the room cannot transmit', () => {
    // The outbox only drains in idle and joinWait. Anywhere else the message
    // is genuinely held, and saying "sending" would be a lie.
    const { getByText } = render(
      <ChatMessageList messages={[base]} {...props} roomState="collecting" />,
    );
    expect(getByText(/waiting for a clear moment/i)).toBeTruthy();
  });

  it('shows the ack count when delivered', () => {
    const delivered: ChatMessage = { ...base, state: 'delivered', ackedBy: [5, 6] };
    const { getByText } = render(<ChatMessageList messages={[delivered]} {...props} />);
    expect(getByText(/delivered to 2/i)).toBeTruthy();
  });

  it('offers a resend on a failed message and passes the original text back', () => {
    const onResend = vi.fn();
    const failed: ChatMessage = { ...base, state: 'failed' };
    const { getByRole } = render(
      <ChatMessageList messages={[failed]} {...props} onResend={onResend} />,
    );
    getByRole('button', { name: /resend/i }).click();
    expect(onResend).toHaveBeenCalledWith('hello room');
  });

  it('renders a received message with no status line', () => {
    // Delivery state is only meaningful for messages WE sent.
    const rx: ChatMessage = { ...base, dir: 'rx', senderId: 9, state: 'delivered' };
    const { getByText, queryByText } = render(<ChatMessageList messages={[rx]} {...props} />);
    expect(getByText('hello room')).toBeTruthy();
    expect(queryByText(/delivered to/i)).toBeNull();
  });

  it('labels a DM with its addressee', () => {
    const dm: ChatMessage = { ...base, targetId: 0xa7 };
    const { getByText } = render(<ChatMessageList messages={[dm]} {...props} />);
    expect(getByText(/a7/i)).toBeTruthy();
  });
});
