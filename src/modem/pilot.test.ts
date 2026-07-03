/**
 * Quick functional test: generate pilot tone → run PilotScanner
 * This bypasses the full encoder/decoder pipeline to isolate the issue.
 */

import { describe, it, expect } from "vitest";
import { PilotScanner } from "./pilot";

describe("PilotScanner", () => {
  it("should discover a 62.5 Hz pilot tone", () => {
    const sampleRate = 3200;
    const pilotFreq = 62.5;
    const pilotAmp = 0.125;
    const duration = 0.6; // seconds
    const numSamples = Math.floor(sampleRate * duration);

    // Generate pure pilot tone
    const samples: number[] = [];
    for (let i = 0; i < numSamples; i++) {
      const phase = 2 * Math.PI * pilotFreq * i / sampleRate;
      samples.push(Math.sin(phase) * pilotAmp);
    }

    // Feed to scanner
    const scanner = new PilotScanner({ sampleRate });
    let result = null;
    for (const s of samples) {
      result = scanner.feedSample(s);
      if (result) break;
    }

    // Force discovery if not already done
    if (!result) result = scanner.forceDiscover();

    console.log(`Scanner result:`, JSON.stringify(result));

    expect(result).not.toBeNull();
    if (result) {
      // Should be close to 62.5 Hz
      expect(Math.abs(result.freq - pilotFreq)).toBeLessThan(2);
      expect(result.confidence).toBeGreaterThan(0.5);
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
      result = scanner.feedSample(s);
      if (result) break;
    }
    if (!result) result = scanner.forceDiscover();

    // Should NOT find a pilot in silence
    expect(result).toBeNull();
  });
});
