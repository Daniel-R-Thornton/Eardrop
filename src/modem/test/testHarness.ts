/**
 * testHarness.ts — Full pipeline test harness for the Eardrop modem.
 *
 * Modes:
 *   clean:      encode → decode (no channel, verifies pipeline integrity)
 *   simulated:  encode → channel.simulate() → decode (tests robustness)
 *   batch:      sweep SNR from min to max, report BER per stage
 *   stress:     all channel impairments combined
 *
 * Each test returns a TestResult with pass/fail, metrics, and optional
 * compressed LLM summary.
 */

import { Encoder } from '../protocol/encoder';
import { Decoder } from '../protocol/decoder';
import { Channel, type ChannelConfig, DEFAULT_CHANNEL_CONFIG } from '../channel/channel';
import { type ModemConfig, DEFAULT_CONFIG } from '../types';
import { encodeBlock, BLOCK_TYPE, getSentinel } from '../protocol/framing';
import { bch3116Encode } from '../ecc/ecc';
import { BerTracker, TimingProfiler, buildSnapshot } from '../debug/diag';
import { debugLogger, STAGE, LOG_LEVEL } from '../debug/debugger';
import { compressForLLM, type CompressLevel } from '../debug/compressForLLM';

// ─── Test Results ────────────────────────────────────

export interface PassFailMetrics {
  /** Did the recovered data match the original exactly? */
  dataMatch: boolean;
  /** Number of bytes that differ */
  byteErrors: number;
  /** Total bytes compared */
  totalBytes: number;
  /** Raw BER (before ECC) */
  rawBer: number;
  /** Corrected BER (after ECC) */
  correctedBer: number;
  /** Blocks successfully decoded */
  blocksDecoded: number;
  /** Blocks that failed CRC */
  blocksCrcFailed: number;
  /** Decoder entered data mode */
  syncAcquired: boolean;
  /** Time to first sync (ms) */
  syncTimeMs: number;
  /** Did the decoder discover the pilot? */
  pilotDiscovered: boolean;
  /** Discovered pilot frequency */
  pilotFreq: number;
}

export interface TestResult {
  name: string;
  passed: boolean;
  timestamp: number;
  durationMs: number;
  metrics: PassFailMetrics;
  /** True if the entire payload was recovered */
  fileComplete: boolean;
  /** Number of squawks processed */
  squawkCount: number;
  /** Average squawk drift (degrees) */
  squawkAvgDrift: number;
  /** Channel config used (for simulated tests) */
  channelConfig?: Partial<ChannelConfig>;
  /** Compressed LLM summary */
  llmSummary?: string;
}

// ─── Test Harness ────────────────────────────────────

export interface TestOptions {
  /** Payload size in bytes (default: 128) */
  payloadBytes?: number;
  /** Modem config overrides */
  modemConfig?: Partial<ModemConfig>;
  /** Channel config overrides */
  channelConfig?: Partial<ChannelConfig>;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Whether to include compressed LLM summary */
  includeLlmSummary?: boolean;
  /** Compression level for LLM summary */
  llmLevel?: CompressLevel;
}

const DEFAULT_TEST_OPTIONS: TestOptions = {
  payloadBytes: 128,
  timeoutMs: 30000,
  includeLlmSummary: true,
  llmLevel: 'normal',
};

export class TestHarness {
  private encoder: Encoder;
  private decoder: Decoder;
  private channel: Channel;
  private timing: TimingProfiler;
  private berTracker: BerTracker;

  constructor() {
    this.encoder = new Encoder(DEFAULT_CONFIG);
    this.decoder = new Decoder(DEFAULT_CONFIG);
    this.channel = new Channel(DEFAULT_CONFIG.sampleRate);
    this.timing = new TimingProfiler();
    this.berTracker = new BerTracker();
  }

  /**
   * Generate a deterministic test payload with identifiable pattern.
   */
  generatePayload(size: number, seed = 12345): Uint8Array {
    const rng = this.createRng(seed);
    const data = new Uint8Array(size);
    // First byte is marker
    data[0] = 0xaa;
    data[1] = 0x55;
    // Fill with pseudo-random bytes
    for (let i = 2; i < size; i++) {
      data[i] = Math.floor(rng() * 256);
    }
    return data;
  }

  /**
   * Run a clean loopback test (no channel impairment).
   */
  async runCleanTest(options?: TestOptions): Promise<TestResult> {
    const opts = { ...DEFAULT_TEST_OPTIONS, ...options };
    return this.runTest('Clean Loopback', opts, null);
  }

  /**
   * Run a simulated test with configurable channel impairments.
   */
  async runSimulatedTest(
    label: string,
    channelConfig: Partial<ChannelConfig>,
    options?: TestOptions,
  ): Promise<TestResult> {
    const opts = { ...DEFAULT_TEST_OPTIONS, ...options };
    return this.runTest(label, opts, channelConfig);
  }

  /**
   * Run a batch sweep: vary SNR and collect BER curves.
   */
  async runSnrSweep(snrValues: number[], options?: TestOptions): Promise<TestResult[]> {
    const opts = { ...DEFAULT_TEST_OPTIONS, ...options };
    const results: TestResult[] = [];
    for (const snr of snrValues) {
      const result = await this.runTest(`SNR=${snr}dB`, opts, { snrDb: snr });
      results.push(result);
    }
    return results;
  }

  /**
   * Run a full stress test (all impairments combined).
   */
  async runStressTest(options?: TestOptions): Promise<TestResult> {
    const opts = { ...DEFAULT_TEST_OPTIONS, ...options };
    return this.runTest('Full Stress', opts, {
      attenuation: 0.8,
      snrDb: 10,
      dopplerHz: 3,
      echoes: [
        { delaySamples: 16, attenuation: 0.3 },
        { delaySamples: 32, attenuation: 0.1 },
      ],
      ampMod: { rateHz: 0.5, depth: 0.2 },
      phaseNoiseStd: 0.05,
      lowpassCutoffHz: 1500,
      impulseRate: 2,
      impulseAmplitude: 0.3,
    });
  }

  // ─── Private ──────────────────────────────────────

  private async runTest(
    name: string,
    opts_: Partial<TestOptions>,
    channelOverride: Partial<ChannelConfig> | null,
  ): Promise<TestResult> {
    const opts: TestOptions = { ...DEFAULT_TEST_OPTIONS, ...opts_ };
    const startTime = performance.now();
    const modemCfg = { ...DEFAULT_CONFIG, ...opts.modemConfig };
    const channelCfg = channelOverride
      ? { ...DEFAULT_CHANNEL_CONFIG, ...channelOverride }
      : { ...DEFAULT_CHANNEL_CONFIG, snrDb: 0 }; // clean = no impairments

    // Reset all components
    this.encoder = new Encoder(modemCfg);
    this.decoder = new Decoder(modemCfg);
    this.decoder.fastSync = true;
    this.decoder.logging = false;
    this.decoder.reset();
    this.channel = new Channel(modemCfg.sampleRate, channelCfg);
    this.timing.reset();
    this.berTracker.reset();
    debugLogger.clear();

    // Generate test payload
    const testData = this.generatePayload(opts.payloadBytes!);
    debugLogger.info(
      STAGE.CHANNEL,
      {
        test_name: name,
        payload_bytes: testData.length,
        channel_snr: channelCfg.snrDb,
        channel_doppler: channelCfg.dopplerHz,
      },
      `Test: ${name} payload=${testData.length}B SNR=${channelCfg.snrDb}dB`,
    );

    // Wrap payload in framed blocks (CONFIG + PAYLOAD + EOF)
    // BCH(31,16) encode config and payload data per the chosen eccScheme
    const sentinel = getSentinel(modemCfg.toneCount);
    const configPayload = new TextEncoder().encode(
      `test-${name.replace(/[^a-zA-Z0-9]/g, '_')}.bin`,
    );
    const configData = (() => {
      const buf = new Uint8Array(2 + configPayload.length + 4 + 1);
      let off = 0;
      buf[off++] = configPayload.length & 0xff;
      buf[off++] = (configPayload.length >> 8) & 0xff;
      buf.set(configPayload, off);
      off += configPayload.length;
      const totalSize = testData.length;
      buf[off++] = totalSize & 0xff;
      buf[off++] = (totalSize >> 8) & 0xff;
      buf[off++] = (totalSize >> 16) & 0xff;
      buf[off++] = (totalSize >> 24) & 0xff;
      // eslint-disable-next-line no-useless-assignment -- off tracks byte position through buffer
      buf[off++] = 0x00; // dictScheme = no compression
      return buf;
    })();
    const configDataForWire =
      modemCfg.eccScheme === 'bch3116' ? bch3116Encode(configData) : configData;
    const configBlock = encodeBlock(BLOCK_TYPE.CONFIG, configDataForWire, sentinel);

    const payloadDataForWire =
      modemCfg.eccScheme === 'bch3116' ? bch3116Encode(testData) : testData;
    const payloadBlock = encodeBlock(BLOCK_TYPE.PAYLOAD, payloadDataForWire, sentinel);
    const eofBlock = encodeBlock(BLOCK_TYPE.EOF, new Uint8Array(0), sentinel);

    // Concatenate all blocks into one byte stream for encoding
    const allFrameBytes = new Uint8Array(
      configBlock.bytes.length + payloadBlock.bytes.length + eofBlock.bytes.length,
    );
    allFrameBytes.set(configBlock.bytes, 0);
    allFrameBytes.set(payloadBlock.bytes, configBlock.bytes.length);
    allFrameBytes.set(eofBlock.bytes, configBlock.bytes.length + payloadBlock.bytes.length);

    // Encode — use encodeFramedBlocks since allFrameBytes is already framed
    this.timing.begin('encode');
    let audio: Float32Array;
    try {
      audio = this.encoder.encodeFramedBlocks(allFrameBytes);
    } catch (err: any) {
      return {
        name,
        passed: false,
        timestamp: startTime,
        durationMs: performance.now() - startTime,
        metrics: {
          dataMatch: false,
          byteErrors: testData.length,
          totalBytes: testData.length,
          rawBer: 1,
          correctedBer: 1,
          blocksDecoded: 0,
          blocksCrcFailed: 0,
          syncAcquired: false,
          syncTimeMs: 0,
          pilotDiscovered: false,
          pilotFreq: 0,
        },
        fileComplete: false,
        squawkCount: 0,
        squawkAvgDrift: 0,
        channelConfig: channelOverride || undefined,
        llmSummary: `ENCODE ERROR: ${err.message}`,
      };
    }
    this.timing.end('encode');

    // Apply channel impairments
    this.timing.begin('channel');
    const impaired = this.channel.process(audio);
    this.timing.end('channel');

    // Decode
    this.timing.begin('decode');
    let decodedData: Uint8Array | null = null;
    let syncAcquired = false;
    let syncTimeMs = 0;
    const syncStartTime = 0;

    this.decoder.onFrame = (data: Uint8Array) => {
      decodedData = data;
    };

    // Feed samples to decoder
    const totalSamples = impaired.length;
    for (let i = 0; i < totalSamples; i++) {
      this.decoder.feedSample(impaired[i]);

      // Track sync timing
      if (!syncAcquired && this.decoder.framedDecoder.blocksDecoded > 0) {
        syncAcquired = true;
        syncTimeMs = performance.now() - startTime;
      }
    }

    // Flush decoder
    const flushed = this.decoder.flush();
    if (flushed.length > 0 && !decodedData) {
      decodedData = flushed;
    }

    this.timing.end('decode');

    // Collect metrics
    const duration = performance.now() - startTime;
    const bpStats = this.decoder.blockProcessor.stats;
    const framedStats = this.decoder.framedDecoder;

    let byteErrors = 0;
    let dataMatch = false;
    if (decodedData && decodedData.length > 0) {
      const len = Math.min(decodedData.length, testData.length);
      for (let i = 0; i < len; i++) {
        if (decodedData[i] !== testData[i]) byteErrors++;
      }
      dataMatch = byteErrors === 0 && decodedData.length === testData.length;
    } else {
      byteErrors = testData.length;
    }

    const metrics: PassFailMetrics = {
      dataMatch,
      byteErrors,
      totalBytes: testData.length,
      rawBer: this.berTracker.getReport().rawBer,
      correctedBer: this.berTracker.getReport().correctedBer,
      blocksDecoded: framedStats.blocksDecoded,
      blocksCrcFailed: framedStats.blocksCrcFailed,
      syncAcquired,
      syncTimeMs,
      pilotDiscovered: this.decoder.getPilotFreq() > 0,
      pilotFreq: this.decoder.getPilotFreq(),
    };

    // Squawk stats
    const sqHistory = this.decoder.squawkProcessor.getHistory();

    // Generate LLM summary
    let llmSummary: string | undefined = undefined;
    if (opts.includeLlmSummary) {
      llmSummary = compressForLLM(debugLogger, {
        level: opts.llmLevel!,
        berReport: this.berTracker.getReport(),
      });
    }

    const result: TestResult = {
      name,
      passed: dataMatch,
      timestamp: startTime,
      durationMs: duration,
      metrics,
      fileComplete: decodedData !== null && decodedData.length > 0,
      squawkCount: sqHistory.length,
      squawkAvgDrift:
        sqHistory.length > 0
          ? sqHistory.reduce((a, c) => a + Math.abs(c.phaseCorrectionDeg), 0) / sqHistory.length
          : 0,
      channelConfig: channelOverride || undefined,
      llmSummary,
    };

    // Log result
    debugLogger.log(
      STAGE.CHANNEL,
      result.passed ? LOG_LEVEL.INFO : LOG_LEVEL.WARN,
      {
        test: name,
        passed: result.passed,
        duration_ms: duration.toFixed(0),
        byte_errors: byteErrors,
        total_bytes: testData.length,
        blocks_decoded: framedStats.blocksDecoded,
        crc_failed: framedStats.blocksCrcFailed,
        pilot_freq: metrics.pilotFreq.toFixed(1),
        squawks: sqHistory.length,
      },
      `${name}: ${result.passed ? 'PASS' : 'FAIL'} ${byteErrors}/${testData.length}B err ${duration.toFixed(0)}ms`,
    );

    return result;
  }

  private createRng(seed: number): () => number {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}
