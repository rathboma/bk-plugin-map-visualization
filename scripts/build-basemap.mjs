// Builds the downloadable offline basemap from a Protomaps basemap extract.
//
//   pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles world-z6.pmtiles --maxzoom=6
//   yarn basemap world-z6.pmtiles basemaps/world-v1.pmtiles
//
// Layers a data map doesn't draw (land use, land cover, points of interest) are dropped, which
// roughly halves the file. Identical tiles (open ocean) are stored once.
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { PMTiles, zxyToTileId, tileIdToZxy } from "pmtiles";

const DROP = new Set(["landuse", "landcover", "pois"]);
const HEADER_BYTES = 127;
const ROOT_MAX_BYTES = 16384 - HEADER_BYTES;

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/build-basemap.mjs <input.pmtiles> <output.pmtiles>");
  process.exit(1);
}

const file = fs.readFileSync(input);
const source = {
  getKey: () => input,
  getBytes: async (offset, length) => ({ data: file.buffer.slice(file.byteOffset + offset, file.byteOffset + offset + length) }),
};
const archive = new PMTiles(source);
const header = await archive.getHeader();
const metadata = await archive.getMetadata();

// ---- MVT layer filtering. A tile is a sequence of `layers` fields (3, length-delimited); each
// layer's name is its field 1. Dropping a layer means skipping its bytes, no re-encoding needed.

function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, pos];
}

function layerName(layer) {
  let pos = 0;
  while (pos < layer.length) {
    let key;
    [key, pos] = readVarint(layer, pos);
    const wire = key & 7;
    if (wire === 2) {
      let len;
      [len, pos] = readVarint(layer, pos);
      if (key >> 3 === 1) return layer.subarray(pos, pos + len).toString("utf8");
      pos += len;
    } else if (wire === 0) {
      [, pos] = readVarint(layer, pos);
    } else {
      break;
    }
  }
  return "";
}

function filterTile(tile) {
  const kept = [];
  let pos = 0;
  while (pos < tile.length) {
    const start = pos;
    let key, len;
    [key, pos] = readVarint(tile, pos);
    [len, pos] = readVarint(tile, pos);
    const body = tile.subarray(pos, pos + len);
    pos += len;
    if (key >> 3 === 3 && DROP.has(layerName(body))) continue;
    kept.push(tile.subarray(start, pos));
  }
  return Buffer.concat(kept);
}

// ---- PMTiles v3 writer (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md)

function writeVarint(out, value) {
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  out.push(value);
}

function serializeDirectory(entries) {
  const out = [];
  writeVarint(out, entries.length);
  let lastId = 0;
  for (const e of entries) {
    writeVarint(out, e.tileId - lastId);
    lastId = e.tileId;
  }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    writeVarint(out, prev && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  });
  return zlib.gzipSync(Buffer.from(out), { level: 9 });
}

function buildDirectories(entries) {
  const root = serializeDirectory(entries);
  if (root.length <= ROOT_MAX_BYTES) return { root, leaves: Buffer.alloc(0) };
  for (let leafSize = 4096; ; leafSize *= 2) {
    const leaves = [];
    const rootEntries = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize);
      const leaf = serializeDirectory(chunk);
      rootEntries.push({ tileId: chunk[0].tileId, offset, length: leaf.length, runLength: 0 });
      leaves.push(leaf);
      offset += leaf.length;
    }
    const nextRoot = serializeDirectory(rootEntries);
    if (nextRoot.length <= ROOT_MAX_BYTES) return { root: nextRoot, leaves: Buffer.concat(leaves) };
  }
}

const entries = [];
const contents = [];
const stored = new Map(); // content hash -> { offset, length }
let dataLength = 0;
let rawBefore = 0;
let rawAfter = 0;

const lastTileId = zxyToTileId(header.maxZoom + 1, 0, 0);
for (let tileId = zxyToTileId(header.minZoom, 0, 0); tileId < lastTileId; tileId++) {
  const [z, x, y] = tileIdToZxy(tileId);
  const tile = await archive.getZxy(z, x, y);
  if (!tile) continue;
  const raw = Buffer.from(tile.data);
  const filtered = filterTile(raw);
  rawBefore += raw.length;
  rawAfter += filtered.length;
  if (!filtered.length) continue;

  const hash = crypto.createHash("sha1").update(filtered).digest("hex");
  if (!stored.has(hash)) {
    const gz = zlib.gzipSync(filtered, { level: 9 });
    stored.set(hash, { offset: dataLength, length: gz.length });
    contents.push(gz);
    dataLength += gz.length;
  }
  const { offset, length } = stored.get(hash);

  const prev = entries[entries.length - 1];
  if (prev && prev.offset === offset && prev.tileId + prev.runLength === tileId) prev.runLength++;
  else entries.push({ tileId, offset, length, runLength: 1 });
}

const meta = {
  ...metadata,
  vector_layers: (metadata.vector_layers || []).filter((l) => !DROP.has(l.id)),
  description: `${metadata.description || "Protomaps basemap"}. Trimmed for Beekeeper Studio Map Visualization (no ${[...DROP].join(", ")}).`,
};
const metaBytes = zlib.gzipSync(Buffer.from(JSON.stringify(meta)), { level: 9 });
const { root, leaves } = buildDirectories(entries);

const rootOffset = HEADER_BYTES;
const metaOffset = rootOffset + root.length;
const leafOffset = metaOffset + metaBytes.length;
const tileOffset = leafOffset + leaves.length;

const h = Buffer.alloc(HEADER_BYTES);
h.write("PMTiles", 0, "ascii");
h.writeUInt8(3, 7);
const u64 = (pos, v) => h.writeBigUInt64LE(BigInt(v), pos);
u64(8, rootOffset);
u64(16, root.length);
u64(24, metaOffset);
u64(32, metaBytes.length);
u64(40, leafOffset);
u64(48, leaves.length);
u64(56, tileOffset);
u64(64, dataLength);
u64(72, entries.reduce((n, e) => n + e.runLength, 0));
u64(80, entries.length);
u64(88, contents.length);
h.writeUInt8(1, 96); // clustered
h.writeUInt8(2, 97); // internal compression: gzip
h.writeUInt8(2, 98); // tile compression: gzip
h.writeUInt8(1, 99); // tile type: mvt
h.writeUInt8(header.minZoom, 100);
h.writeUInt8(header.maxZoom, 101);
const e7 = (deg) => Math.round(deg * 1e7);
h.writeInt32LE(e7(header.minLon), 102);
h.writeInt32LE(e7(header.minLat), 106);
h.writeInt32LE(e7(header.maxLon), 110);
h.writeInt32LE(e7(header.maxLat), 114);
h.writeUInt8(header.centerZoom, 118);
h.writeInt32LE(e7(header.centerLon), 119);
h.writeInt32LE(e7(header.centerLat), 123);

fs.writeFileSync(output, Buffer.concat([h, root, metaBytes, leaves, ...contents]));
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
console.log(
  `${output}: ${mb(fs.statSync(output).size)} (input ${mb(file.length)}), z${header.minZoom}-${header.maxZoom}, ` +
    `${entries.length} entries, ${contents.length} unique tiles, raw tile data ${mb(rawBefore)} -> ${mb(rawAfter)}`,
);
