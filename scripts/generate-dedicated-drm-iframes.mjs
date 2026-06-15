#!/usr/bin/env node
// Reads the existing _I-Frame.m3u8 playlists (byte-range format) for the
// 4k-20260611-drm stream on S3, downloads the referenced segments, extracts
// each I-frame into its own dedicated .cmfv file, and uploads the results to
// a new S3 prefix with rewritten playlists (no byte ranges).
//
// DRM note: each moof in this CBCS-encrypted stream contains senc, saio, and
// saiz boxes that the player needs to decrypt the sample. The standard
// buildIframeFragment drops these, so we preserve them — keeping senc/saiz
// verbatim (players only read the first sample's entry) and rebuilding saio
// with the correct offset into the newly-constructed moof.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileP = promisify(execFile);

const S3_SRC = 's3://pbs-video-dev/test-streams/outputs/4k-20260611-drm';
const S3_DST = 's3://pbs-video-dev/test-streams/outputs/4k-20260611-drm-dedicated-iframes';
const ORIGIN_BASE = 'https://static.drm.pbs.org/test-streams/outputs/4k-20260611-drm';

let TMP;

// ── S3 helpers ──────────────────────────────────────────────────────────────

async function s3GetText(key) {
  const local = join(TMP, key.replace(/\//g, '_'));
  await execFileP('aws', ['s3', 'cp', `${S3_SRC}/${key}`, local, '--quiet']);
  return readFile(local, 'utf8');
}

async function s3GetBuffer(key) {
  const local = join(TMP, key.replace(/\//g, '_'));
  await execFileP('aws', ['s3', 'cp', `${S3_SRC}/${key}`, local, '--quiet']);
  return readFile(local);
}

async function s3PutBuffer(dstKey, buf) {
  const local = join(TMP, 'out_' + dstKey.replace(/\//g, '_'));
  await writeFile(local, buf);
  await execFileP('aws', [
    's3', 'cp', local, `${S3_DST}/${dstKey}`,
    '--content-type', 'video/mp4',
    '--quiet',
  ]);
}

async function s3PutText(dstKey, text) {
  const local = join(TMP, 'out_' + dstKey.replace(/\//g, '_'));
  await writeFile(local, text, 'utf8');
  await execFileP('aws', [
    's3', 'cp', local, `${S3_DST}/${dstKey}`,
    '--content-type', 'application/x-mpegURL',
    '--quiet',
  ]);
}

async function s3CopyInit(key) {
  const buf = await s3GetBuffer(key);
  await s3PutBuffer(key, buf);
}

// ── Box I/O primitives ───────────────────────────────────────────────────────

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

// ── Box parsers ──────────────────────────────────────────────────────────────

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
  const tfhd = {
    flags,
    trackId: buffer.readUInt32BE(offset),
    defaultSampleDuration: null,
    defaultSampleSize: null,
    defaultSampleFlags: null,
  };
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

// ── Box builders ─────────────────────────────────────────────────────────────

function makeTfdt(version, baseMediaDecodeTime) {
  const payload = Buffer.alloc(version === 0 ? 8 : 12);
  payload[0] = version;
  payload.writeUIntBE(0, 1, 3);
  if (version === 0) {
    payload.writeUInt32BE(baseMediaDecodeTime, 4);
  } else {
    payload.writeBigUInt64BE(BigInt(baseMediaDecodeTime), 4);
  }
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

// Rebuild saio with a new single offset value, preserving version=1 for
// 64-bit offsets (matching the original box in this stream).
function makeSaio(offset) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write('saio', 4, 4, 'ascii');
  buf[8] = 1; // version 1 → 8-byte offsets
  buf.writeUIntBE(0, 9, 3); // flags
  buf.writeUInt32BE(1, 12); // count
  buf.writeBigUInt64BE(BigInt(offset), 16); // offset[0]
  return buf;
}

// ── Fragment helpers ─────────────────────────────────────────────────────────

function fragmentDuration(sidx, moofIndex, trun) {
  const refDuration = sidx?.references[moofIndex]?.subsegmentDuration;
  if (refDuration && trun.samples.length) {
    return Math.max(1, Math.round(refDuration / trun.samples.length));
  }
  return trun.samples[0]?.duration ?? 1;
}

// Build a standalone I-frame fragment from a multi-sample fMP4 segment.
// Preserves senc/saiz/saio encryption boxes so CBCS-encrypted content remains
// decryptable: senc and saiz are kept verbatim (players only look up the first
// sample's entry), saio is rebuilt with the correct offset into the new moof.
function buildIframeFragment(source, byteRange) {
  const topBoxes = findTopBoxes(source);
  const styp = topBoxes.find((box) => box.type === 'styp');
  const sidx = topBoxes.find((box) => box.type === 'sidx');
  const moofs = topBoxes.filter((box) => box.type === 'moof');
  const moof = moofs.find((box) => box.offset === byteRange.offset);
  if (!moof) throw new Error(`No moof found at offset ${byteRange.offset}`);

  const moofIndex = moofs.findIndex((box) => box.offset === moof.offset);
  const oldMoofChildren = children(source, moof);
  const mfhd = oldMoofChildren.find((box) => box.type === 'mfhd');
  const traf = oldMoofChildren.find((box) => box.type === 'traf');
  const trafChildren = children(source, traf);
  const tfhdBox = trafChildren.find((box) => box.type === 'tfhd');
  const tfdtBox = trafChildren.find((box) => box.type === 'tfdt');
  const trunBox = trafChildren.find((box) => box.type === 'trun');
  const sencBox = trafChildren.find((box) => box.type === 'senc');
  const saioBox = trafChildren.find((box) => box.type === 'saio');
  const saizBox = trafChildren.find((box) => box.type === 'saiz');

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

  // makeTrun always produces a fixed 36-byte box so we can pre-compute saio.
  const TRUN_SIZE = 36;

  // saio offset = distance from the start of the moof to the start of the
  // senc sample data (i.e. after senc's 16-byte box header).
  let sencBytes, saioBytes, saizBytes;
  if (sencBox) {
    sencBytes = source.subarray(sencBox.offset, sencBox.end);
    saizBytes = saizBox ? source.subarray(saizBox.offset, saizBox.end) : null;

    // moof header(8) + mfhd + traf header(8) + tfhd + tfdt + trun + senc header(16)
    const saioValue =
      8 + mfhdBytes.length +
      8 + tfhdBytes.length + tfdtBytes.length + TRUN_SIZE +
      16;
    saioBytes = makeSaio(saioValue);
  }

  // Build placeholder moof (dataOffset=0) just to get total size for final trun.
  const trunPlaceholder = makeTrun(sample, 0);
  const trafPieces = [tfhdBytes, tfdtBytes, trunPlaceholder];
  if (sencBytes) {
    trafPieces.push(sencBytes, saioBytes);
    if (saizBytes) trafPieces.push(saizBytes);
  }
  const placeholderMoof = makeBox('moof', [mfhdBytes, makeBox('traf', trafPieces)]);

  // Final trun: dataOffset = moof size + 8 (mdat box header).
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
  if (originalSidx) {
    pieces.push(makeSidx(originalSidx, baseMediaDecodeTime, moofBytes.length + mdatBytes.length, sample.duration));
  }
  pieces.push(moofBytes, mdatBytes);
  return Buffer.concat(pieces);
}

// ── Playlist parsing ─────────────────────────────────────────────────────────

// Returns { headerLines, entries } where headerLines are all non-segment lines
// before the first #EXTINF, and entries are { extinf, byteRange, uri }.
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
      const match = line.match(/^#EXT-X-BYTERANGE:(\d+)@(\d+)$/);
      if (!match) throw new Error(`Unsupported byte range: ${line}`);
      pendingByteRange = { length: Number(match[1]), offset: Number(match[2]) };
      continue;
    }
    if (!line.startsWith('#') && pendingExtinf && pendingByteRange) {
      entries.push({ extinf: pendingExtinf, byteRange: pendingByteRange, uri: line });
      pendingExtinf = null;
      pendingByteRange = null;
      continue;
    }
    if (!inBody) headerLines.push(line);
  }

  return { headerLines, entries };
}

// ── Per-playlist processing ──────────────────────────────────────────────────

async function processIframePlaylist(iframeName) {
  console.log(`\n[${iframeName}]`);
  const text = await s3GetText(iframeName);
  const { headerLines, entries } = parseIframePlaylist(text);

  // Extract init segment URI from #EXT-X-MAP and copy it to the destination.
  const mapLine = headerLines.find((l) => l.startsWith('#EXT-X-MAP:'));
  const initUri = mapLine?.match(/URI="([^"]+)"/)?.[1];
  if (initUri) {
    process.stdout.write(`  Copying init ${initUri}... `);
    await s3CopyInit(initUri);
    process.stdout.write('done\n');
  }

  // Download each unique source segment once.
  const segCache = new Map();
  const uniqueUris = [...new Set(entries.map((e) => e.uri))];
  for (const uri of uniqueUris) {
    process.stdout.write(`  Downloading ${uri}... `);
    segCache.set(uri, await s3GetBuffer(uri));
    process.stdout.write('done\n');
  }

  // Generate and upload a dedicated iframe file for each entry.
  const mediaLines = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const source = segCache.get(entry.uri);
    const base = basename(entry.uri, extname(entry.uri));
    const outName = `${base}_${String(i + 1).padStart(6, '0')}-iframe.cmfv`;

    const iframeBytes = buildIframeFragment(source, entry.byteRange);
    await s3PutBuffer(outName, iframeBytes);
    mediaLines.push(entry.extinf, outName);
    process.stdout.write(`  [${i + 1}/${entries.length}] ${outName} (${iframeBytes.length} bytes)\n`);
  }

  // Rewrite playlist: keep all header lines, replace byte-range entries with
  // dedicated file references.
  const newPlaylist = [...headerLines, ...mediaLines, '#EXT-X-ENDLIST', ''].join('\n');
  await s3PutText(iframeName, newPlaylist);
  console.log(`  Wrote ${iframeName} (${entries.length} dedicated iframe fragments)`);
  return entries.length;
}

// ── Master playlist rewrite ──────────────────────────────────────────────────

// In the new master: variant STREAM-INF and MEDIA entries point back to the
// original origin with absolute URLs (no need to copy segments/variant
// playlists). I-frame STREAM-INF entries keep their relative URIs so they
// resolve to the new dedicated-iframe playlists in this prefix.
function rewriteMaster(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      out.push(line);
      i++;
      const uri = lines[i] ?? '';
      out.push(/^https?:\/\//.test(uri) ? uri : `${ORIGIN_BASE}/${uri}`);
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      out.push(line.replace(/URI="([^"]+)"/, (_, uri) =>
        `URI="${/^https?:\/\//.test(uri) ? uri : `${ORIGIN_BASE}/${uri}`}"`,
      ));
      continue;
    }
    out.push(line);
  }
  if (out.at(-1) !== '') out.push('');
  return out.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  TMP = await mkdtemp(join(tmpdir(), 'drm-iframes-'));
  try {
    console.log(`Source: ${S3_SRC}`);
    console.log(`Destination: ${S3_DST}`);

    const masterText = await s3GetText('pbs-bars.m3u8');

    const iframeNames = [
      ...masterText.matchAll(/#EXT-X-I-FRAME-STREAM-INF:[^\n]*URI="([^"]+)"/g),
    ].map((m) => m[1]);

    console.log(`Found ${iframeNames.length} I-frame playlists`);

    let total = 0;
    for (const name of iframeNames) {
      total += await processIframePlaylist(name);
    }

    const newMaster = rewriteMaster(masterText);
    await s3PutText('pbs-bars.m3u8', newMaster);

    console.log(`\nDone. Wrote ${total} dedicated iframe fragments.`);
    console.log(`Master: ${S3_DST}/pbs-bars.m3u8`);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
