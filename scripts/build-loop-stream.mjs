#!/usr/bin/env node
// Builds the "audio gap" loop-repro stream from the muxed AVC 720p output of
// build-muxed-fmp4-stream.mjs. Every segment from AUDIO_GAP_FROM onward has
// its first ~1s of audio samples dropped: the trun entries are removed (the
// box is shrunk with a trailing `free` box so no other offset moves), the
// audio tfdt is advanced, and the run's data_offset skips the orphaned mdat
// bytes. Video is untouched, so each segment's parsed PTS range still spans
// the full EXTINF window while the muxed SourceBuffer's buffered range
// (audio∩video) starts ~1s late.
//
// Purpose: a fragment like that is permanently PARTIAL in hls.js — buffered
// never covers the fragment window, no append is ever empty, and no load
// ever errors — which exercises fragment-selection loop protection.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(
  __dirname,
  '..',
  'streams',
  'pbs',
  'test-pattern-muxed-fmp4',
);
const OUT_DIR = resolve(
  __dirname,
  '..',
  'streams',
  'pbs',
  'test-pattern-loop-fmp4',
);
const SRC_BASE = 'pbs-bars-muxed-AVC-720p';
const OUT_BASE = 'pbs-bars-muxed-AVC-720p-audio-gaps';
const AUDIO_TRACK_ID = 2;
const AUDIO_GAP_FROM = 3; // leave a few clean segments so playback can start
const GAP_SECONDS = 1;

const fourcc = (buf, o) => buf.toString('latin1', o + 4, o + 8);

function* boxes(buf, start, end) {
  let o = start;
  while (o + 8 <= end) {
    const size = buf.readUInt32BE(o);
    if (size < 8 || o + size > end) {
      throw new Error(`bad box size ${size} at ${o}`);
    }
    yield { offset: o, size, type: fourcc(buf, o) };
    o += size;
  }
}

function findBox(buf, start, end, type) {
  for (const box of boxes(buf, start, end)) {
    if (box.type === type) {
      return box;
    }
  }
  return null;
}

function dropLeadingAudioSamples(buf) {
  const moof = findBox(buf, 0, buf.length, 'moof');
  for (const traf of boxes(buf, moof.offset + 8, moof.offset + moof.size)) {
    if (traf.type !== 'traf') {
      continue;
    }
    const trafEnd = traf.offset + traf.size;
    const tfhd = findBox(buf, traf.offset + 8, trafEnd, 'tfhd');
    if (buf.readUInt32BE(tfhd.offset + 12) !== AUDIO_TRACK_ID) {
      continue;
    }
    const tfhdFlags = buf.readUInt32BE(tfhd.offset + 8) & 0xffffff;
    if (!(tfhdFlags & 0x8)) {
      throw new Error('expected default-sample-duration in audio tfhd');
    }
    let at = tfhd.offset + 16;
    if (tfhdFlags & 0x1) at += 8;
    if (tfhdFlags & 0x2) at += 4;
    const frameDuration = buf.readUInt32BE(at);

    const tfdt = findBox(buf, traf.offset + 8, trafEnd, 'tfdt');
    if (buf[tfdt.offset + 8] !== 1) {
      throw new Error('expected version 1 tfdt');
    }

    const trun = findBox(buf, traf.offset + 8, trafEnd, 'trun');
    const trunFlags = buf.readUInt32BE(trun.offset + 8) & 0xffffff;
    if (!(trunFlags & 0x1) || !(trunFlags & 0x200)) {
      throw new Error(`expected data-offset + sample-size trun, got 0x${trunFlags.toString(16)}`);
    }
    const durationInEntry = trunFlags & 0x100;
    const sizeAt = durationInEntry ? 4 : 0;
    const entrySize =
      4 *
      [0x100, 0x200, 0x400, 0x800].filter((flag) => trunFlags & flag).length;
    const count = buf.readUInt32BE(trun.offset + 12);
    // 96kHz timescale, 1024-tick AAC frames: ~94 frames ≈ 1s
    const timescale = 96000;
    const drop = Math.round((GAP_SECONDS * timescale) / frameDuration);
    if (drop < 2 || drop >= count) {
      throw new Error(`cannot drop ${drop} of ${count} samples`);
    }

    let droppedBytes = 0;
    let droppedTicks = 0;
    const entries = trun.offset + 20;
    for (let i = 0; i < drop; i++) {
      droppedBytes += buf.readUInt32BE(entries + i * entrySize + sizeAt);
      droppedTicks += durationInEntry
        ? buf.readUInt32BE(entries + i * entrySize)
        : frameDuration;
    }
    buf.writeBigUInt64BE(
      buf.readBigUInt64BE(tfdt.offset + 12) + BigInt(droppedTicks),
      tfdt.offset + 12,
    );
    buf.writeUInt32BE(count - drop, trun.offset + 12);
    buf.writeInt32BE(buf.readInt32BE(trun.offset + 16) + droppedBytes, trun.offset + 16);
    buf.copyWithin(
      entries,
      entries + drop * entrySize,
      entries + count * entrySize,
    );
    // Shrink the trun and fill the tail with a free box so that no offset
    // outside this traf changes and the file size stays identical
    const newTrunSize = trun.size - drop * entrySize;
    buf.writeUInt32BE(newTrunSize, trun.offset);
    buf.writeUInt32BE(drop * entrySize, trun.offset + newTrunSize);
    buf.write('free', trun.offset + newTrunSize + 4, 'latin1');
    return droppedTicks / timescale;
  }
  throw new Error('no audio traf found');
}

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(
  join(SRC_DIR, `${SRC_BASE}_init.mp4`),
  join(OUT_DIR, `${OUT_BASE}_init.mp4`),
);

const playlist = readFileSync(join(SRC_DIR, `${SRC_BASE}.m3u8`), 'utf8');
const segments = [...playlist.matchAll(new RegExp(`${SRC_BASE}_\\d+\\.m4s`, 'g'))].map(
  (m) => m[0],
);
segments.forEach((name, index) => {
  const outName = name.replace(SRC_BASE, OUT_BASE);
  if (index < AUDIO_GAP_FROM) {
    copyFileSync(join(SRC_DIR, name), join(OUT_DIR, outName));
    return;
  }
  const buf = readFileSync(join(SRC_DIR, name));
  const gap = dropLeadingAudioSamples(buf);
  writeFileSync(join(OUT_DIR, outName), buf);
  console.log(`${outName}: dropped ${gap.toFixed(3)}s of leading audio`);
});

writeFileSync(
  join(OUT_DIR, 'pbs-bars_muxed-avc-audio-gaps.m3u8'),
  playlist.replaceAll(SRC_BASE, OUT_BASE),
);
console.log(`wrote ${segments.length} segments + init + playlist to ${OUT_DIR}`);
