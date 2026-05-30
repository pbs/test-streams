#!/usr/bin/env node

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcDir = resolve(root, 'streams/pbs/test-pattern');
const outDir = resolve(root, 'streams/pbs/test-pattern-dedicated-iframes');
const masterPlaylistName = 'pbs-bars_hevc-avc.m3u8';

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
  const referenceId = buffer.readUInt32BE(offset);
  offset += 4;
  const timescale = buffer.readUInt32BE(offset);
  offset += 4;
  const earliestPresentationTime = version === 0 ? buffer.readUInt32BE(offset) : readU64(buffer, offset);
  offset += version === 0 ? 4 : 8;
  const firstOffset = version === 0 ? buffer.readUInt32BE(offset) : readU64(buffer, offset);
  offset += version === 0 ? 4 : 8;
  offset += 2;
  const referenceCount = buffer.readUInt16BE(offset);
  offset += 2;
  const references = [];
  for (let i = 0; i < referenceCount; i++) {
    const reference = buffer.readUInt32BE(offset);
    offset += 4;
    const subsegmentDuration = buffer.readUInt32BE(offset);
    offset += 4;
    const sap = buffer.readUInt32BE(offset);
    offset += 4;
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
  if (flags & 0x000008) {
    tfhd.defaultSampleDuration = buffer.readUInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x000010) {
    tfhd.defaultSampleSize = buffer.readUInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x000020) {
    tfhd.defaultSampleFlags = buffer.readUInt32BE(offset);
  }
  return tfhd;
}

function parseTrun(buffer, box, tfhd, fallbackDuration) {
  const version = buffer[box.offset + 8];
  const flags = buffer.readUIntBE(box.offset + 9, 3);
  const sampleCount = buffer.readUInt32BE(box.offset + 12);
  let offset = box.offset + 16;
  let dataOffset = 0;
  let firstSampleFlags = null;
  if (flags & 0x000001) {
    dataOffset = buffer.readInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x000004) {
    firstSampleFlags = buffer.readUInt32BE(offset);
    offset += 4;
  }
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const sample = {
      duration: tfhd.defaultSampleDuration ?? fallbackDuration,
      size: tfhd.defaultSampleSize,
      flags: i === 0 ? firstSampleFlags : tfhd.defaultSampleFlags,
      compositionOffset: 0,
    };
    if (flags & 0x000100) {
      sample.duration = buffer.readUInt32BE(offset);
      offset += 4;
    }
    if (flags & 0x000200) {
      sample.size = buffer.readUInt32BE(offset);
      offset += 4;
    }
    if (flags & 0x000400) {
      sample.flags = buffer.readUInt32BE(offset);
      offset += 4;
    }
    if (flags & 0x000800) {
      sample.compositionOffset = version === 0 ? buffer.readUInt32BE(offset) : buffer.readInt32BE(offset);
      offset += 4;
    }
    samples.push(sample);
  }
  return { version, flags, dataOffset, firstSampleFlags, samples };
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

function fragmentDuration(sidx, moofIndex, trun) {
  const refDuration = sidx?.references[moofIndex]?.subsegmentDuration;
  if (refDuration && trun.samples.length) {
    return Math.max(1, Math.round(refDuration / trun.samples.length));
  }
  return trun.samples[0]?.duration ?? 1;
}

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
  const tfhd = parseTfhd(source, tfhdBox);
  const originalSidx = sidx ? parseSidx(source, sidx) : null;
  const trun = parseTrun(source, trunBox, tfhd, null);
  const sample = trun.samples[0];
  sample.duration ??= fragmentDuration(originalSidx, moofIndex, trun);
  sample.flags ??= tfhd.defaultSampleFlags ?? 0x02000000;

  const mfhdBytes = source.subarray(mfhd.offset, mfhd.end);
  const tfhdBytes = source.subarray(tfhdBox.offset, tfhdBox.end);
  const tfdtVersion = source[tfdtBox.offset + 8];
  const trunBytes = makeTrun(sample, 0);
  const baseMediaDecodeTime = parseTfdt(source, tfdtBox) + sample.compositionOffset;
  const tfdtBytes = makeTfdt(tfdtVersion, baseMediaDecodeTime);
  const trafBytes = makeBox('traf', [tfhdBytes, tfdtBytes, trunBytes]);
  let moofBytes = makeBox('moof', [mfhdBytes, trafBytes]);
  const finalTrunBytes = makeTrun(sample, moofBytes.length + 8);
  const finalTrafBytes = makeBox('traf', [tfhdBytes, tfdtBytes, finalTrunBytes]);
  moofBytes = makeBox('moof', [mfhdBytes, finalTrafBytes]);

  const payloadStart = moof.offset + trun.dataOffset;
  const payload = source.subarray(payloadStart, payloadStart + sample.size);
  if (payload.length !== sample.size) {
    throw new Error(`Could not read full sample at ${payloadStart}`);
  }

  const mdatBytes = makeBox('mdat', payload);
  const pieces = [];
  if (styp) pieces.push(source.subarray(styp.offset, styp.end));
  if (originalSidx) {
    pieces.push(
      makeSidx(
        originalSidx,
        baseMediaDecodeTime,
        moofBytes.length + mdatBytes.length,
        sample.duration,
      ),
    );
  }
  pieces.push(moofBytes, mdatBytes);
  return Buffer.concat(pieces);
}

async function copyAvcOnlyFixture() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const names = await readdir(srcDir);
  for (const name of names) {
    if (
      name.startsWith('pbs-bars-AVC-') ||
      name.startsWith('pbs-bars-aac-192k') ||
      name.startsWith('pbs-bars-captions')
    ) {
      await copyFile(join(srcDir, name), join(outDir, name));
    }
  }

  const master = await readFile(join(srcDir, masterPlaylistName), 'utf8');
  await writeFile(join(outDir, masterPlaylistName), filterAvcMaster(master));
}

function filterAvcMaster(text) {
  const lines = text.split(/\r?\n/);
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = lines[i + 1] ?? '';
      if (uri.startsWith('pbs-bars-AVC-')) {
        output.push(line, uri);
      }
      i++;
      continue;
    }
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      if (/URI="pbs-bars-AVC-/.test(line)) output.push(line);
      continue;
    }
    if (line || i < lines.length - 1) output.push(line);
  }
  if (output.at(-1) !== '') output.push('');
  return output.join('\n');
}

function parseIframePlaylist(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const output = [];
  let pendingExtinf = null;
  let pendingByteRange = null;

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      pendingExtinf = line;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const match = line.match(/^#EXT-X-BYTERANGE:(\d+)@(\d+)$/);
      if (!match) throw new Error(`Unsupported byte range: ${line}`);
      pendingByteRange = { length: Number(match[1]), offset: Number(match[2]) };
      continue;
    }
    if (pendingExtinf && pendingByteRange && line && !line.startsWith('#')) {
      entries.push({ extinf: pendingExtinf, byteRange: pendingByteRange, uri: line });
      pendingExtinf = null;
      pendingByteRange = null;
      continue;
    }
    output.push(line);
  }

  return { output, entries };
}

async function rewritePlaylist(playlistPath) {
  const text = await readFile(playlistPath, 'utf8');
  const { output, entries } = parseIframePlaylist(text);
  const lines = output.filter((line) => line !== '');
  const insertAt = lines.findIndex((line) => line === '#EXT-X-ENDLIST');
  const mediaLines = [];
  const filesByUri = new Map();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let source = filesByUri.get(entry.uri);
    if (!source) {
      source = await readFile(join(dirname(playlistPath), entry.uri));
      filesByUri.set(entry.uri, source);
    }
    const base = basename(entry.uri, extname(entry.uri));
    const iframeName = `${base}_${String(i + 1).padStart(6, '0')}-iframe.cmfv`;
    const iframeBytes = buildIframeFragment(source, entry.byteRange);
    await writeFile(join(dirname(playlistPath), iframeName), iframeBytes);
    mediaLines.push(entry.extinf, iframeName);
  }

  if (insertAt === -1) throw new Error(`Missing ENDLIST in ${playlistPath}`);
  const rewritten = [...lines.slice(0, insertAt), ...mediaLines, ...lines.slice(insertAt), ''].join('\n');
  await writeFile(playlistPath, rewritten);
  return { playlistPath, entries: entries.length };
}

async function main() {
  await mkdir(dirname(outDir), { recursive: true });
  await copyAvcOnlyFixture();

  const names = (await readdir(outDir)).filter((name) => name.endsWith('_I-Frame.m3u8')).sort();
  let total = 0;
  for (const name of names) {
    const result = await rewritePlaylist(join(outDir, name));
    total += result.entries;
    console.log(`${name}: ${result.entries} dedicated iframe fragments`);
  }
  console.log(`Wrote ${total} iframe fragments in ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
