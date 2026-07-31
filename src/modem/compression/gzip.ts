/**
 * gzip.ts — general-purpose compression via the platform-native
 * CompressionStream/DecompressionStream (gzip). Available in browsers and
 * Node 18+, so no dependency. Async (the streams API is async), so callers
 * compress before framing and decompress after CRC-clean reassembly.
 *
 * This is the real workhorse: LZ77 + Huffman gets 5–10× on text/JSON/logs,
 * where the static dictionary schemes only shave a few percent.
 */

async function pipeThrough(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(data as BufferSource);
  void writer.close();
  const buf = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buf);
}

export function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new CompressionStream('gzip'));
}

export function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new DecompressionStream('gzip'));
}
