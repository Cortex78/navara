import { crc32 } from "../dem/png";

export type ZipEntry = { name: string; data: Uint8Array };

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
/** Bit 11: names are UTF-8. */
const UTF8_NAMES = 0x0800;
/** 1980-01-01, the zip epoch; field files carry no meaningful timestamp. */
const DOS_DATE = 0x0021;

const checksum = (data: Uint8Array) => (crc32(data) ^ 0xffffffff) >>> 0;

/**
 * A stored (uncompressed) zip archive. Shapefile parts are small, and
 * every farm tool and operating system opens a stored zip.
 */
export const zipStore = (entries: ZipEntry[]): Uint8Array => {
  const enc = new TextEncoder();
  const names = entries.map((e) => enc.encode(e.name));
  const crcs = entries.map((e) => checksum(e.data));
  const localSize = entries.reduce(
    (n, e, i) => n + 30 + names[i].length + e.data.length,
    0,
  );
  const centralSize = names.reduce((n, name) => n + 46 + name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  entries.forEach((e, i) => {
    offsets.push(at);
    view.setUint32(at, SIG_LOCAL, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, UTF8_NAMES, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_DATE, true);
    view.setUint32(at + 14, crcs[i], true);
    view.setUint32(at + 18, e.data.length, true);
    view.setUint32(at + 22, e.data.length, true);
    view.setUint16(at + 26, names[i].length, true);
    view.setUint16(at + 28, 0, true);
    out.set(names[i], at + 30);
    out.set(e.data, at + 30 + names[i].length);
    at += 30 + names[i].length + e.data.length;
  });
  const centralStart = at;
  entries.forEach((e, i) => {
    view.setUint32(at, SIG_CENTRAL, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, UTF8_NAMES, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, crcs[i], true);
    view.setUint32(at + 20, e.data.length, true);
    view.setUint32(at + 24, e.data.length, true);
    view.setUint16(at + 28, names[i].length, true);
    // Extra, comment, disk, internal and external attributes: all zero.
    view.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + 46);
    at += 46 + names[i].length;
  });
  view.setUint32(at, SIG_END, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
};

const inflateRaw = async (data: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([data as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw")),
    ).arrayBuffer(),
  );

/** Reads a zip's files (stored or deflated), keyed by their path in the archive. */
export const unzip = async (
  bytes: Uint8Array,
): Promise<Map<string, Uint8Array>> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === SIG_END) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("not a zip archive");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const dec = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== SIG_CENTRAL)
      throw new Error("damaged zip directory");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, raw.slice());
    else if (method === 8) files.set(name, await inflateRaw(raw));
    else throw new Error(`${name}: unsupported zip compression ${method}`);
  }
  return files;
};
