/**
 * Self-test controller — loopback encode→decode verification.
 *
 * Builds proper framed blocks (CONFIG + PAYLOAD + EOF), encodes through
 * the Encoder, then decodes through the Decoder in-memory. Reports pass/fail
 * to both the DOM and the React Store.
 */

import { setState, getState } from '../Store';
import { Encoder } from '../../modem/protocol/encoder';
import { Decoder } from '../../modem/protocol/decoder';
import { encodeBlock, BLOCK_TYPE, getSentinel } from '../../modem/protocol/framing';
import { bch3116Encode } from '../../modem/ecc/ecc';
import { DEFAULT_CONFIG } from '../../modem/types';

export async function runSelfTest(): Promise<void> {
  const cfg = {
    ...DEFAULT_CONFIG,
    toneCount: getState().toneCount,
    pilotFreqHz: getState().pilotFreqHz,
  };
  const testData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // 'Hello'
  setState({ sendStatus: { type: 'info', msg: '🧪 Running self-test…' } });

  // Build proper framed blocks (CONFIG + PAYLOAD + EOF)
  const sentinel = getSentinel(cfg.toneCount);
  const configPayload = new TextEncoder().encode('self-test.bin');
  const configData = new Uint8Array(2 + configPayload.length + 4 + 1);
  // Byte offset tracking through the config data buffer
  let offset = 0;
  configData[offset++] = configPayload.length & 0xff;
  configData[offset++] = (configPayload.length >> 8) & 0xff;
  configData.set(configPayload, offset);
  offset += configPayload.length;
  configData[offset++] = testData.length & 0xff;
  configData[offset++] = (testData.length >> 8) & 0xff;
  configData[offset++] = (testData.length >> 16) & 0xff;
  configData[offset++] = (testData.length >> 24) & 0xff;
  configData[offset++] = 0x00;
  // offset now points past last written byte; used only for sequential packing
  void offset;

  // ECC-encode block data before wrapping (decoder expects BCH-protected payloads)
  const configForWire = bch3116Encode(configData);
  const payloadForWire = bch3116Encode(testData);
  const cb = encodeBlock(BLOCK_TYPE.CONFIG, configForWire, sentinel);
  const pb = encodeBlock(BLOCK_TYPE.PAYLOAD, payloadForWire, sentinel);
  const eb = encodeBlock(BLOCK_TYPE.EOF, new Uint8Array(0), sentinel);
  const allFramed = new Uint8Array(cb.bytes.length + pb.bytes.length + eb.bytes.length);
  allFramed.set(cb.bytes, 0);
  allFramed.set(pb.bytes, cb.bytes.length);
  allFramed.set(eb.bytes, cb.bytes.length + pb.bytes.length);

  // Encode
  const encoder = new Encoder(cfg);
  const samples = encoder.encodeFramedBlocks(allFramed);

  // Decode
  const decoder = new Decoder(cfg);
  decoder.fastSync = true;
  decoder.reset();
  let decoded: Uint8Array | null = null;
  decoder.onFrame = (data: Uint8Array) => {
    decoded = data;
  };
  for (const s of samples) decoder.feedSample(s);
  decoder.flush();

  const blocksOk = decoder.framedDecoder.blocksDecoded;
  const crcFail = decoder.framedDecoder.blocksCrcFailed;
  const dataMatch = !!(
    decoded &&
    (decoded as Uint8Array).length === testData.length &&
    testData.every((b, i) => (decoded as Uint8Array)[i] === b)
  );
  const passed = !!dataMatch;

  const resultText = passed
    ? `✅ PASS: ${blocksOk} blocks, ${testData.length}B recovered`
    : `❌ FAIL: ${blocksOk} blocks/${crcFail} CRC fails, data=${dataMatch ? 'OK' : 'wrong'}`;

  const el = document.getElementById('selfTestResult');
  if (el) el.textContent = resultText;
  console.warn(`[SELF_TEST] ${resultText}`);

  setState({
    sendStatus: {
      type: passed ? 'success' : 'error',
      msg: passed ? '✅ Self-test PASS' : '❌ Self-test FAIL',
    },
    debugSamples: samples,
    txSamples: samples,
  });
}
