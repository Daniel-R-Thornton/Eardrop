/**
 * src/lib/debug/index.ts
 *
 * Debug and diagnostics utilities.
 * - Structured event logging
 * - State snapshots for UI/LLM export
 * - Compression for LLM analysis
 */

/**
 * Structured debug event for logging.
 */
export interface DebugEvent {
  timestamp: number;
  stage: string;
  eventType: string;
  data: any;
  level?: 'info' | 'warn' | 'error';
}

/**
 * Simple event logger with ring buffer.
 */
export class EventLogger {
  private events: DebugEvent[] = [];
  private readonly maxSize: number;

  constructor(maxEvents: number = 1000) {
    this.maxSize = maxEvents;
  }

  /**
   * Log an event.
   */
  log(
    stage: string,
    eventType: string,
    data: any,
    level: 'info' | 'warn' | 'error' = 'info',
  ): void {
    const event: DebugEvent = {
      timestamp: Date.now(),
      stage,
      eventType,
      data,
      level,
    };

    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift(); // Remove oldest
    }
  }

  /**
   * Get all logged events.
   */
  getEvents(): DebugEvent[] {
    return [...this.events];
  }

  /**
   * Get events from a specific stage.
   */
  getEventsByStage(stage: string): DebugEvent[] {
    return this.events.filter((e) => e.stage === stage);
  }

  /**
   * Clear all events.
   */
  clear(): void {
    this.events = [];
  }
}

/**
 * State snapshot for exporting current decoder/encoder state to UI or LLM.
 */
export interface StateSnapshot {
  timestamp: number;
  stage: string;
  metrics: Record<string, number | string | boolean>;
  buffers?: Record<string, Float32Array | Uint8Array>;
}

/**
 * Compress a state snapshot for LLM-friendly analysis.
 * Keeps essential metrics, summarizes large buffers.
 */
export function compressForLLM(snapshot: StateSnapshot): object {
  const compressed: any = {
    stage: snapshot.stage,
    metrics: snapshot.metrics,
  };

  if (snapshot.buffers) {
    compressed.bufferSummary = {};
    for (const [name, buffer] of Object.entries(snapshot.buffers)) {
      if (buffer instanceof Float32Array) {
        compressed.bufferSummary[name] = {
          type: 'float32',
          length: buffer.length,
          min: Math.min(...buffer),
          max: Math.max(...buffer),
          mean: buffer.reduce((a, b) => a + b, 0) / buffer.length,
          sample: buffer.slice(0, 32), // First 32 samples
        };
      } else {
        compressed.bufferSummary[name] = {
          type: 'uint8',
          length: buffer.length,
          sample: buffer.slice(0, 32),
        };
      }
    }
  }

  return compressed;
}

/**
 * Format a buffer as a hex string for debugging.
 */
export function bufferToHex(buffer: Uint8Array, maxBytes: number = 64): string {
  const truncated = buffer.slice(0, maxBytes);
  return Array.from(truncated)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/**
 * Format a buffer as ASCII for debugging.
 */
export function bufferToAscii(buffer: Uint8Array, maxBytes: number = 64): string {
  const truncated = buffer.slice(0, maxBytes);
  return Array.from(truncated)
    .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
    .join('');
}
