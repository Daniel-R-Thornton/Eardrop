/**
 * Quick functional test: generate pilot tone → run PilotScanner
 * This bypasses the full encoder/decoder pipeline to isolate the issue.
 */

import { describe, it, expect } from "vitest";
import { PilotScanner } from "./pilot";
import { DEFAULT_CONFIG } from "./types";

describe("PilotScanner", () => {
  it("should discover a pilot tone at the configured default frequency", () => {
    const sampleRate = 3200;
    const pilotFreq = DEFAULT_CONFIG.pilotFreqHz; // 412.5
    const pilotAmp = DEFAULT_CONFIG.pilotAmplitude; // 0.4
    const duration = 0.6; // seconds
    const numSamples = Math.floor(sampleRate * duration);

    // Generate pure pilot tone
    const samples: number[] = [];
    for (let i = 0; i < numSamples; i++) {
      const phase = 2 * Math.PI * pilotFreq * i / sampleRate;
      samples.push(Math.sin(phase) * pilotAmp);
    }

    // Feed to scanner (configured with targetFreq matching the generated tone)
    // Note: feedSample reads from the ring buffer (feedSampleRT), not its argument.
    const scanner = new PilotScanner({ sampleRate, targetFreq: pilotFreq });
    let result = null;
    for (const s of samples) {
      scanner.feedSampleRT(s);
      result = scanner.feedSample(s);
      if (result) break;
    }

    // Force discovery if not already done
    if (!result) result = scanner.forceDiscover();

    console.log(`Scanner result:`, JSON.stringify(result));

    expect(result).not.toBeNull();
    if (result) {
      // Should be close to the pilot frequency
      expect(Math.abs(result.freq - pilotFreq)).toBeLessThan(2);
      expect(result.confidence).toBeGreaterThan(0.3);
    }
  });

  it("should NOT discover a pilot in silence", () => {
    const sampleRate = 3200;
    const duration = 0.6;
    const numSamples = Math.floor(sampleRate * duration);

    // Generate silence (very low noise)
    const samples: number[] = new Array(numSamples).fill(0);

    const scanner = new PilotScanner({ sampleRate, minSignalRatio: 5 });
    let result = null;
    for (const s of samples) {
      scanner.feedSampleRT(s);
      result = scanner.feedSample(s);
      if (result) break;
    }
    if (!result) result = scanner.forceDiscover();

    // Should NOT find a pilot in silence
    expect(result).toBeNull();
  });
});
