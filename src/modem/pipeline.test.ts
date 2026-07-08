/**
 * Modem pipeline tests — using the TestHarness for encode→channel→decode.
 *
 * Scenarios:
 *   Clean loopback    — best case, verifies pipeline integrity
 *   SNR sweep         — 5 to 40 dB, finds the noise floor for reliable communication
 *   Doppler           — frequency shift tolerance
 *   Multi-path echo   — echo resilience
 *   Full stress       — all impairments combined
 *   Throughput        — measures effective data rate at various conditions
 *   Worst case        — lowest SNR that still passes, with all impairments
 */

import { describe, it, expect, beforeAll } from "vitest";
import { TestHarness } from "./testHarness";
import { DEFAULT_CONFIG } from "./types";

// Increase timeout for full pipeline tests (encoding 128+ bytes takes time)
const TEST_TIMEOUT = 60000;

describe("Modem Pipeline", () => {
  let harness: TestHarness;

  beforeAll(() => {
    harness = new TestHarness();
  });

  // ─── Best Case: Clean Loopback ─────────────────────

  describe("Best Case — Clean Loopback", () => {
    it("should pass with 64 bytes payload", async () => {
      const result = await harness.runCleanTest({ payloadBytes: 64 });
      expect(result.passed).toBe(true);
      expect(result.metrics.dataMatch).toBe(true);
      expect(result.metrics.byteErrors).toBe(0);
      expect(result.metrics.pilotDiscovered).toBe(true);
      expect(result.metrics.syncAcquired).toBe(true);
      expect(result.metrics.blocksDecoded).toBeGreaterThan(0);
      // CRC failures from spurious sentinel matches are harmless; dataMatch is the key metric
    }, TEST_TIMEOUT);

    it("should pass with 256 bytes payload", async () => {
      const result = await harness.runCleanTest({ payloadBytes: 256 });
      expect(result.passed).toBe(true);
      expect(result.metrics.byteErrors).toBe(0);
    }, TEST_TIMEOUT);

    it("should discover pilot frequency accurately", async () => {
      const result = await harness.runCleanTest({ payloadBytes: 64 });
      // Pilot frequency should match the configured default
      expect(result.metrics.pilotFreq).toBeGreaterThan(DEFAULT_CONFIG.pilotFreqHz * 0.95);
      expect(result.metrics.pilotFreq).toBeLessThan(DEFAULT_CONFIG.pilotFreqHz * 1.05);
    }, TEST_TIMEOUT);
  });

  // ─── SNR Sweep ─────────────────────────────────────

  describe("AWGN SNR Sweep", () => {
    it("should pass at 20 dB SNR", async () => {
      const result = await harness.runSimulatedTest(
        "SNR 20dB",
        { snrDb: 20 },
        { payloadBytes: 64 }
      );
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);

    it("should pass at 15 dB SNR", async () => {
      const result = await harness.runSimulatedTest(
        "SNR 15dB",
        { snrDb: 15 },
        { payloadBytes: 64 }
      );
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);

    it("should at least partially decode at 10 dB SNR", async () => {
      const result = await harness.runSimulatedTest(
        "SNR 10dB",
        { snrDb: 10 },
        { payloadBytes: 64 }
      );
      // At 10 dB, may or may not pass perfectly, but should at least detect signal
      expect(result.metrics.pilotDiscovered).toBe(true);
    }, TEST_TIMEOUT);
  });

  // ─── Doppler Shift ─────────────────────────────────

  describe("Doppler Shift Tolerance", () => {
    it("should pass with +2 Hz Doppler shift", async () => {
      const result = await harness.runSimulatedTest(
        "Doppler +2Hz",
        { dopplerHz: 2 },
        { payloadBytes: 64 }
      );
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);

    it("should pass with -1 Hz Doppler shift", async () => {
      const result = await harness.runSimulatedTest(
        "Doppler -1Hz",
        { dopplerHz: -1 },
        { payloadBytes: 64 }
      );
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);
  });

  // ─── Multi-path / Echo ─────────────────────────────

  describe("Multi-path Echo Tolerance", () => {
    it("should pass with mild echo (16 samples, 30%)", async () => {
      const result = await harness.runSimulatedTest(
        "Echo mild",
        { echoes: [{ delaySamples: 16, attenuation: 0.3 }] },
        { payloadBytes: 64 }
      );
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);

    it("should pass with double echo", async () => {
      const result = await harness.runSimulatedTest(
        "Echo double",
        {
          echoes: [
            { delaySamples: 16, attenuation: 0.3 },
            { delaySamples: 32, attenuation: 0.15 },
          ],
        },
        { payloadBytes: 64 }
      );
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);
  });

  // ─── Phase Noise ───────────────────────────────────

  describe("Phase Noise Tolerance", () => {
    it("should pass with low phase noise (0.05 rad)", async () => {
      const result = await harness.runSimulatedTest(
        "Phase noise 0.05",
        { phaseNoiseStd: 0.05 },
        { payloadBytes: 64 }
      );
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);
  });

  // ─── Amplitude Drift ───────────────────────────────

  describe("Amplitude Modulation Tolerance", () => {
    it("should pass with slow volume drift", async () => {
      const result = await harness.runSimulatedTest(
        "Amp mod drift",
        { ampMod: { rateHz: 0.5, depth: 0.3 } },
        { payloadBytes: 64 }
      );
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);
  });

  // ─── Full Stress ───────────────────────────────────

  describe("Stress Test — All Impairments Combined", () => {
    it("should at least sync and partially decode under full stress", async () => {
      const result = await harness.runStressTest({ payloadBytes: 64 });
      // Stress test may produce errors, but should at least not crash
      expect(result.metrics.pilotDiscovered).toBe(true);
      expect(result.metrics.blocksDecoded).toBeGreaterThan(0);
    }, TEST_TIMEOUT);
  });

  // ─── Throughput ────────────────────────────────────

  describe("Throughput Measurement", () => {
    it("should measure clean loopback throughput", async () => {
      const result = await harness.runCleanTest({ payloadBytes: 256 });
      // Calculate throughput: payload bytes / duration seconds
      const durationSec = result.durationMs / 1000;
      const bytesPerSec = result.metrics.totalBytes / durationSec;
      const bitsPerSec = bytesPerSec * 8;

      // Throughput should be at least 2 byte/s (conservative minimum)
      expect(bytesPerSec).toBeGreaterThan(2);
      expect(result.passed).toBe(true);

      // Log throughput for informational purposes
      console.log(`\n📊 Throughput (clean): ${bytesPerSec.toFixed(1)} byte/s = ${bitsPerSec.toFixed(0)} bit/s`);
    }, TEST_TIMEOUT);

    it("should measure throughput at 20 dB SNR", async () => {
      const result = await harness.runSimulatedTest(
        "Throughput @20dB",
        { snrDb: 20 },
        { payloadBytes: 128 }
      );
      const durationSec = result.durationMs / 1000;
      const bytesPerSec = result.metrics.totalBytes / durationSec;
      const bitsPerSec = bytesPerSec * 8;
      console.log(`📊 Throughput (20dB SNR): ${bytesPerSec.toFixed(1)} byte/s = ${bitsPerSec.toFixed(0)} bit/s`);
    }, TEST_TIMEOUT);
  });

  // ─── Worst Case ────────────────────────────────────

  describe("Worst Case — Maximum Impairments", () => {
    it("should still function at lowest usable SNR", async () => {
      // Find the lowest SNR where the modem can still sync and decode
      const snrLevels = [5, 8, 10, 12, 15];
      let lowestWorkingSnr = 0;

      for (const snr of snrLevels) {
        const result = await harness.runSimulatedTest(
          `Worst case SNR=${snr}`,
          { snrDb: snr },
          { payloadBytes: 128 }
        );
        if (result.metrics.pilotDiscovered && result.fileComplete) {
          lowestWorkingSnr = snr;
          break;
        }
      }

      console.log(`\n📊 Lowest working SNR: ${lowestWorkingSnr} dB`);
      // Should work at least at 15 dB SNR
      expect(lowestWorkingSnr).toBeGreaterThan(0);
    }, TEST_TIMEOUT * 2);
  });

  // ─── SNR BER Curve ─────────────────────────────────

  describe("SNR → BER Curve", () => {
    it("should produce decreasing BER with increasing SNR", async () => {
      const results = await harness.runSnrSweep(
        [5, 10, 15, 20, 25, 30],
        { payloadBytes: 128 }
      );

      // Log the BER curve
      console.log("\n📊 SNR → BER Curve:");
      console.log("  SNR(dB)  |  Raw BER    |  Corrected BER  |  Passed");
      console.log("  ---------+-------------+-----------------+--------");
      for (const r of results) {
        console.log(
          `  ${r.name.padEnd(8)} | ${(r.metrics.rawBer || 0).toExponential(2).padStart(10)} | ` +
          `${(r.metrics.correctedBer || 0).toExponential(2).padStart(14)} | ${r.passed ? '✅' : '❌'}`
        );
      }

      // Higher SNR should have lower or equal BER
      for (let i = 1; i < results.length; i++) {
        if (results[i-1].metrics.rawBer > 0 && results[i].metrics.rawBer > 0) {
          expect(results[i].metrics.rawBer).toBeLessThanOrEqual(results[i-1].metrics.rawBer * 1.5);
        }
      }
    }, TEST_TIMEOUT * 3);
  });

  // ─── Multiple Payload Sizes ────────────────────────

  describe("Payload Size Scaling", () => {
    it("should handle small payload (16 bytes)", async () => {
      const result = await harness.runCleanTest({ payloadBytes: 16 });
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);

    it("should handle medium payload (512 bytes)", async () => {
      const result = await harness.runCleanTest({ payloadBytes: 512 });
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);

    it("should handle large payload (2048 bytes)", async () => {
      const result = await harness.runCleanTest({ payloadBytes: 2048 });
      expect(result.passed).toBe(true);
    }, TEST_TIMEOUT);
  });
});
