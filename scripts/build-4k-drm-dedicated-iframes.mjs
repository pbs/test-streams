#!/usr/bin/env node
// Mirror the 4k-20260615-3-drm CBCS-encrypted multicodec HLS output into a
// self-contained local copy under streams/pbs/4k-drm-dedicated-iframes/, with:
//   * every media file (init + video/audio/caption segments) downloaded so the
//     stream is fully self-hosted (relative URLs, no origin dependency);
//   * the native byte-range #EXT-X-I-FRAMES-ONLY playlists replaced by DEDICATED
//     standalone .cmfv I-frame fragments (no byte ranges), preserving the CBCS
//     senc/saiz/saio boxes so trick-play frames stay decryptable;
//   * a DRM key-signaling cleanup that makes the manifests match Axinom's
//     known-good cbcs reference (which plays in hls.js/Widevine). The verified
//     content crypto (schm=cbcs, tenc pattern 1:9, KID, constant IV) is already
//     identical to Axinom's; only the manifest key tags differed, so we:
//       - drop all #EXT-X-SESSION-KEY tags from the masters (Axinom has none —
//         it signals keys only in the media playlists);
//       - drop the PlayReady #EXT-X-KEY (a WRMHEADER data: URI, NOT cenc
//         init-data — it derails hls.js EME setup). PlayReady stays available
//         via the in-segment pssh box, exactly as Axinom delivers it;
//       - unquote KEYID (RFC 8216 hexadecimal-sequence; Axinom is unquoted);
//       - append the IV to the FairPlay skd:// content-id (skd://<kid>:<IV>),
//         the form Axinom's FairPlay license server expects.
//   * a filtered pbs-bars_hevc-avc.m3u8 master (HEVC+AVC variants only).
//
// Usage: node scripts/build-4k-drm-dedicated-iframes.mjs

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, basename, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_BASE = 'https://static.drm.pbs.org/test-streams/outputs/4k-20260615-3-drm';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'streams/pbs/4k-drm-dedicated-iframes');
const MASTER = 'pbs-bars.m3u8';
const HEVC_AVC_MASTER = 'pbs-bars_hevc-avc.m3u8';
const CONCURRENCY = 16;

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function fetchText(name) {
  const r = await fetch(`${SRC_BASE}/${name}`);
  if (!r.ok) throw new Error(`${name} -> ${r.status}`);
  return r.text();
}

async function fetchBuffer(name) {
  const r = await fetch(`${SRC_BASE}/${name}`);
  if (!r.ok) throw new Error(`${name} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function mapLimit(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
        onProgress?.(++done, items.length);
      }
    }),
  );
  return results;
}

// ── DRM key-tag cleanup (match Axinom's known-good cbcs signaling) ─────────────

// Detect the PlayReady #EXT-X-KEY: a data: URI whose payload is a PlayReady
// Object (UTF-16LE WRMHEADER). The SPEKE output mislabels it with
// KEYFORMAT="com.apple.streamingkeydelivery", so we identify it by CONTENT, not
// label. The Widevine key (data: URI = pssh) and the real FairPlay skd:// key
// do not decode to a WRMHEADER, so they're left alone.
function isPlayReadyKeyLine(line) {
  if (!line.startsWith('#EXT-X-KEY') || !/URI="data:/.test(line)) return false;
  const b64 = line.match(/URI="data:[^"]*base64,([^"]*)"/)?.[1] ?? '';
  return /playready|WRMHEADER/i.test(Buffer.from(b64, 'base64').toString('utf16le'));
}

function cleanKeyTags(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (line.startsWith('#EXT-X-SESSION-KEY')) return false; // Axinom: none
      if (isPlayReadyKeyLine(line)) return false; // PlayReady stays in the init pssh
      return true;
    })
    .map((line) => {
      if (!line.startsWith('#EXT-X-KEY')) return line;
      // KEYID is an HLS hexadecimal-sequence and must be unquoted (RFC 8216).
      line = line.replace(/KEYID="(0x[0-9a-fA-F]+)"/, 'KEYID=$1');
      // Match Axinom's FairPlay content-id: skd://<kid>:<IV>. The SPEKE output
      // emits a bare skd://<kid>; append the line's own IV as the :suffix so
      // Safari sends the form the Axinom FairPlay license server expects.
      if (/URI="skd:\/\//.test(line) && !/URI="skd:\/\/[^"]*:[^"]+"/.test(line)) {
        const iv = line.match(/IV=0x([0-9a-fA-F]+)/)?.[1];
        if (iv) line = line.replace(/(URI="skd:\/\/[^"]*)"/, `$1:${iv.toUpperCase()}"`);
      }
      return line;
    })
    .join('\n');
}

// ── Playlist parsing ─────────────────────────────────────────────────────────

// Plain (non-iframe) media playlist: collect the #EXT-X-MAP init URI (if any)
// and every segment URI. All URIs in this asset are already relative.
function parseMediaRefs(text) {
  const lines = text.split(/\r?\n/);
  let initUri = null;
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      initUri = line.match(/URI="([^"]+)"/)?.[1] ?? null;
    } else if (line && !line.startsWith('#')) {
      segments.push(line.trim());
    }
  }
  return { initUri, segments };
}

// Native byte-range I-frame playlist → { headerLines, entries }.
function parseIframePlaylist(text) {
  const lines = text.split(/\r?\n/);
  const headerLines = [];
  const entries = [];
  let pendingExtinf = null;
  let pendingByteRange = null;
  let inBody = false;
  for (const line of lines) {
    if (line === '' || line === '#EXT-X-ENDLIST') continue;
    if (line.startsWith('#EXTINF:')) {
      inBody = true;
      pendingExtinf = line;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const m = line.match(/^#EXT-X-BYTERANGE:(\d+)@(\d+)$/);
      if (!m) throw new Error(`Unsupported byte range: ${line}`);
      pendingByteRange = { length: Number(m[1]), offset: Number(m[2]) };
      continue;
    }
    if (!line.startsWith('#') && pendingExtinf && pendingByteRange) {
      entries.push({ extinf: pendingExtinf, byteRange: pendingByteRange, uri: line.trim() });
      pendingExtinf = null;
      pendingByteRange = null;
      continue;
    }
    if (!inBody) headerLines.push(line);
  }
  return { headerLines, entries };
}

// ── Master filtering (HEVC + AVC only) ─────────────────────────────────────────

function filterHevcAvcMaster(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const keep = (uri) => /pbs-bars-(HEVC|AVC)-/.test(uri);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = lines[i + 1] ?? '';
      if (keep(uri)) out.push(line, uri);
      i++;
      continue;
    }
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      if (keep(line)) out.push(line);
      continue;
    }
    out.push(line);
  }
  if (out.at(-1) !== '') out.push('');
  return out.join('\n');
}

// ── fMP4 box machinery (CBCS-aware I-frame fragment builder) ────────────────────

function readU64(buffer, offset) {
  return Number(buffer.readBigUInt64BE(offset));
}

function makeBox(type, payloads) {
  const payload = Buffer.concat(Array.isArray(payloads) ? payloads : [payloads]);
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function readBox(buffer, offset) {
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString('ascii', offset + 4, offset + 8);
  if (size32 === 1) {
    const size = readU64(buffer, offset + 8);
    return { offset, headerSize: 16, size, type, end: offset + size };
  }
  return { offset, headerSize: 8, size: size32, type, end: offset + size32 };
}

function children(buffer, box) {
  const boxes = [];
  let offset = box.offset + box.headerSize;
  while (offset < box.end) {
    const child = readBox(buffer, offset);
    boxes.push(child);
    offset = child.end;
  }
  return boxes;
}

function findTopBoxes(buffer) {
  const boxes = [];
  let offset = 0;
  while (offset < buffer.length) {
    const box = readBox(buffer, offset);
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

function parseSidx(buffer, box) {
  const version = buffer[box.offset + 8];
  let offset = box.offset + 12;
  const referenceId = buffer.readUInt32BE(offset); offset += 4;
  const timescale = buffer.readUInt32BE(offset); offset += 4;
  const earliestPresentationTime = version === 0 ? buffer.readUInt32BE(offset) : readU64(buffer, offset);
  offset += version === 0 ? 4 : 8;
  const firstOffset = version === 0 ? buffer.readUInt32BE(offset) : readU64(buffer, offset);
  offset += version === 0 ? 4 : 8;
  offset += 2;
  const referenceCount = buffer.readUInt16BE(offset); offset += 2;
  const references = [];
  for (let i = 0; i < referenceCount; i++) {
    const reference = buffer.readUInt32BE(offset); offset += 4;
    const subsegmentDuration = buffer.readUInt32BE(offset); offset += 4;
    const sap = buffer.readUInt32BE(offset); offset += 4;
    references.push({
      referencedSize: reference & 0x7fffffff,
      referenceType: reference >>> 31,
      subsegmentDuration,
      sap,
    });
  }
  return { version, referenceId, timescale, earliestPresentationTime, firstOffset, references };
}

function parseTfdt(buffer, box) {
  const version = buffer[box.offset + 8];
  const valueOffset = box.offset + 12;
  return version === 0 ? buffer.readUInt32BE(valueOffset) : readU64(buffer, valueOffset);
}

function parseTfhd(buffer, box) {
  const flags = buffer.readUIntBE(box.offset + 9, 3);
  let offset = box.offset + 12;
  const tfhd = { flags, trackId: buffer.readUInt32BE(offset), defaultSampleDuration: null, defaultSampleSize: null, defaultSampleFlags: null };
  offset += 4;
  if (flags & 0x000001) offset += 8;
  if (flags & 0x000002) offset += 4;
  if (flags & 0x000008) { tfhd.defaultSampleDuration = buffer.readUInt32BE(offset); offset += 4; }
  if (flags & 0x000010) { tfhd.defaultSampleSize = buffer.readUInt32BE(offset); offset += 4; }
  if (flags & 0x000020) { tfhd.defaultSampleFlags = buffer.readUInt32BE(offset); }
  return tfhd;
}

function parseTrun(buffer, box, tfhd, fallbackDuration) {
  const version = buffer[box.offset + 8];
  const flags = buffer.readUIntBE(box.offset + 9, 3);
  const sampleCount = buffer.readUInt32BE(box.offset + 12);
  let offset = box.offset + 16;
  let dataOffset = 0;
  let firstSampleFlags = null;
  if (flags & 0x000001) { dataOffset = buffer.readInt32BE(offset); offset += 4; }
  if (flags & 0x000004) { firstSampleFlags = buffer.readUInt32BE(offset); offset += 4; }
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const sample = {
      duration: tfhd.defaultSampleDuration ?? fallbackDuration,
      size: tfhd.defaultSampleSize,
      flags: i === 0 ? firstSampleFlags : tfhd.defaultSampleFlags,
      compositionOffset: 0,
    };
    if (flags & 0x000100) { sample.duration = buffer.readUInt32BE(offset); offset += 4; }
    if (flags & 0x000200) { sample.size = buffer.readUInt32BE(offset); offset += 4; }
    if (flags & 0x000400) { sample.flags = buffer.readUInt32BE(offset); offset += 4; }
    if (flags & 0x000800) {
      sample.compositionOffset = version === 0 ? buffer.readUInt32BE(offset) : buffer.readInt32BE(offset);
      offset += 4;
    }
    samples.push(sample);
  }
  return { version, flags, dataOffset, firstSampleFlags, samples };
}

function makeTfdt(version, baseMediaDecodeTime) {
  const payload = Buffer.alloc(version === 0 ? 8 : 12);
  payload[0] = version;
  payload.writeUIntBE(0, 1, 3);
  if (version === 0) payload.writeUInt32BE(baseMediaDecodeTime, 4);
  else payload.writeBigUInt64BE(BigInt(baseMediaDecodeTime), 4);
  return makeBox('tfdt', payload);
}

function makeTrun(sample, dataOffset) {
  const flags = 0x000f01;
  const payload = Buffer.alloc(28);
  payload[0] = 1;
  payload.writeUIntBE(flags, 1, 3);
  payload.writeUInt32BE(1, 4);
  payload.writeInt32BE(dataOffset, 8);
  payload.writeUInt32BE(sample.duration, 12);
  payload.writeUInt32BE(sample.size, 16);
  payload.writeUInt32BE(sample.flags, 20);
  payload.writeInt32BE(0, 24);
  return makeBox('trun', payload);
}

function makeSidx(template, earliestPresentationTime, referencedSize, subsegmentDuration) {
  const payload = Buffer.alloc(44);
  payload[0] = 1;
  payload.writeUIntBE(0, 1, 3);
  payload.writeUInt32BE(template.referenceId, 4);
  payload.writeUInt32BE(template.timescale, 8);
  payload.writeBigUInt64BE(BigInt(earliestPresentationTime), 12);
  payload.writeBigUInt64BE(0n, 20);
  payload.writeUInt16BE(0, 28);
  payload.writeUInt16BE(1, 30);
  payload.writeUInt32BE(referencedSize & 0x7fffffff, 32);
  payload.writeUInt32BE(subsegmentDuration, 36);
  payload.writeUInt32BE(0x90000000, 40);
  return makeBox('sidx', payload);
}

// version-1 (64-bit offset) saio with a single rebuilt offset value.
function makeSaio(offset) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write('saio', 4, 4, 'ascii');
  buf[8] = 1;
  buf.writeUIntBE(0, 9, 3);
  buf.writeUInt32BE(1, 12);
  buf.writeBigUInt64BE(BigInt(offset), 16);
  return buf;
}

function fragmentDuration(sidx, moofIndex, trun) {
  const refDuration = sidx?.references[moofIndex]?.subsegmentDuration;
  if (refDuration && trun.samples.length) return Math.max(1, Math.round(refDuration / trun.samples.length));
  return trun.samples[0]?.duration ?? 1;
}

// Build a standalone single-sample I-frame fragment. senc + saiz are kept
// verbatim (players read only the first sample's entry); saio is rebuilt to
// point at the senc sample data within the new moof.
function buildIframeFragment(source, byteRange) {
  const topBoxes = findTopBoxes(source);
  const styp = topBoxes.find((b) => b.type === 'styp');
  const sidx = topBoxes.find((b) => b.type === 'sidx');
  const moofs = topBoxes.filter((b) => b.type === 'moof');
  const moof = moofs.find((b) => b.offset === byteRange.offset);
  if (!moof) throw new Error(`No moof found at offset ${byteRange.offset}`);

  const moofIndex = moofs.findIndex((b) => b.offset === moof.offset);
  const moofChildren = children(source, moof);
  const mfhd = moofChildren.find((b) => b.type === 'mfhd');
  const traf = moofChildren.find((b) => b.type === 'traf');
  const trafChildren = children(source, traf);
  const tfhdBox = trafChildren.find((b) => b.type === 'tfhd');
  const tfdtBox = trafChildren.find((b) => b.type === 'tfdt');
  const trunBox = trafChildren.find((b) => b.type === 'trun');
  const sencBox = trafChildren.find((b) => b.type === 'senc');
  const saioBox = trafChildren.find((b) => b.type === 'saio');
  const saizBox = trafChildren.find((b) => b.type === 'saiz');

  const tfhd = parseTfhd(source, tfhdBox);
  const originalSidx = sidx ? parseSidx(source, sidx) : null;
  const trun = parseTrun(source, trunBox, tfhd, null);
  const sample = trun.samples[0];
  sample.duration ??= fragmentDuration(originalSidx, moofIndex, trun);
  sample.flags ??= tfhd.defaultSampleFlags ?? 0x02000000;

  const mfhdBytes = source.subarray(mfhd.offset, mfhd.end);
  const tfhdBytes = source.subarray(tfhdBox.offset, tfhdBox.end);
  const tfdtVersion = source[tfdtBox.offset + 8];
  const baseMediaDecodeTime = parseTfdt(source, tfdtBox) + sample.compositionOffset;
  const tfdtBytes = makeTfdt(tfdtVersion, baseMediaDecodeTime);

  const TRUN_SIZE = 36; // makeTrun is always 36 bytes → saio offset is precomputable
  let sencBytes, saioBytes, saizBytes;
  if (sencBox) {
    sencBytes = source.subarray(sencBox.offset, sencBox.end);
    saizBytes = saizBox ? source.subarray(saizBox.offset, saizBox.end) : null;
    const saioValue = 8 + mfhdBytes.length + 8 + tfhdBytes.length + tfdtBytes.length + TRUN_SIZE + 16;
    saioBytes = makeSaio(saioValue);
  }

  const trunPlaceholder = makeTrun(sample, 0);
  const trafPieces = [tfhdBytes, tfdtBytes, trunPlaceholder];
  if (sencBytes) {
    trafPieces.push(sencBytes, saioBytes);
    if (saizBytes) trafPieces.push(saizBytes);
  }
  const placeholderMoof = makeBox('moof', [mfhdBytes, makeBox('traf', trafPieces)]);

  const finalTrunBytes = makeTrun(sample, placeholderMoof.length + 8);
  const finalTrafPieces = [tfhdBytes, tfdtBytes, finalTrunBytes];
  if (sencBytes) {
    finalTrafPieces.push(sencBytes, saioBytes);
    if (saizBytes) finalTrafPieces.push(saizBytes);
  }
  const moofBytes = makeBox('moof', [mfhdBytes, makeBox('traf', finalTrafPieces)]);

  const payloadStart = moof.offset + trun.dataOffset;
  const payload = source.subarray(payloadStart, payloadStart + sample.size);
  if (payload.length !== sample.size) {
    throw new Error(`Could not read full sample at ${payloadStart} (expected ${sample.size} got ${payload.length})`);
  }

  const mdatBytes = makeBox('mdat', payload);
  const pieces = [];
  if (styp) pieces.push(source.subarray(styp.offset, styp.end));
  if (originalSidx) pieces.push(makeSidx(originalSidx, baseMediaDecodeTime, moofBytes.length + mdatBytes.length, sample.duration));
  pieces.push(moofBytes, mdatBytes);
  return Buffer.concat(pieces);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Source: ${SRC_BASE}`);
  console.log(`Output: ${OUT_DIR}`);
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const writeLocal = (name, buf) => writeFile(join(OUT_DIR, name), buf);

  // --- Master ---
  const masterText = await fetchText(MASTER);
  const variantUris = [...masterText.matchAll(/^#EXT-X-STREAM-INF:[^\n]*\n([^\n#]+)$/gm)].map((m) => m[1].trim());
  const iframeUris = [...masterText.matchAll(/#EXT-X-I-FRAME-STREAM-INF:[^\n]*URI="([^"]+)"/g)].map((m) => m[1]);
  const mediaUris = [...masterText.matchAll(/#EXT-X-MEDIA:[^\n]*URI="([^"]+)"/g)].map((m) => m[1]);

  await writeLocal(MASTER, cleanKeyTags(masterText));
  await writeLocal(HEVC_AVC_MASTER, cleanKeyTags(filterHevcAvcMaster(masterText)));
  console.log(`Master: ${variantUris.length} variants, ${iframeUris.length} I-frame, ${mediaUris.length} media`);

  // --- Plain media playlists (variants + audio + subtitles): download every
  //     init + segment so the copy is self-hosted; clean + write the playlist. ---
  const segmentFiles = new Set();
  const initFiles = new Set();
  for (const uri of [...variantUris, ...mediaUris]) {
    const text = await fetchText(uri);
    const { initUri, segments } = parseMediaRefs(text);
    if (initUri) initFiles.add(initUri);
    segments.forEach((s) => segmentFiles.add(s));
    await writeLocal(uri, cleanKeyTags(text));
  }

  const downloads = [...initFiles, ...segmentFiles];
  console.log(`Downloading ${downloads.length} media files...`);
  await mapLimit(
    downloads,
    CONCURRENCY,
    async (name) => writeLocal(name, await fetchBuffer(name)),
    (done, total) => process.stdout.write(`  ${done}/${total}\r`),
  );
  process.stdout.write('\n');

  // --- I-frame playlists: build dedicated fragments from the (already
  //     downloaded) variant segments, then rewrite the playlist. ---
  const { readFile } = await import('node:fs/promises');
  let totalFrames = 0;
  for (const iframeUri of iframeUris) {
    const text = cleanKeyTags(await fetchText(iframeUri));
    const { headerLines, entries } = parseIframePlaylist(text);

    const segCache = new Map();
    const mediaLines = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      let source = segCache.get(entry.uri);
      if (!source) {
        source = await readFile(join(OUT_DIR, entry.uri));
        segCache.set(entry.uri, source);
      }
      const base = basename(entry.uri, extname(entry.uri));
      const outName = `${base}_${String(i + 1).padStart(6, '0')}-iframe.cmfv`;
      await writeLocal(outName, buildIframeFragment(source, entry.byteRange));
      mediaLines.push(entry.extinf, outName);
    }

    const rewritten = [...headerLines, ...mediaLines, '#EXT-X-ENDLIST', ''].join('\n');
    await writeLocal(iframeUri, rewritten);
    totalFrames += entries.length;
    console.log(`  ${iframeUri}: ${entries.length} dedicated iframe fragments`);
  }

  console.log(`\nDone. ${totalFrames} dedicated iframe fragments across ${iframeUris.length} playlists.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
