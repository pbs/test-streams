#!/usr/bin/env node
// Package the pbs-bars mezzanine (scripts/generate-pbs-bars.py) into MUXED
// fMP4 HLS — audio and video tracks together in one init.mp4 and one set of
// .m4s segments per variant, the way ffmpeg's HLS muxer packages by default.
// Then synthesize #EXT-X-I-FRAME-STREAM-INF variants with moof-anchored
// byte ranges (moof start -> end of the IDR sample's bytes in the mdat).
//
// This output exists to exercise HLS clients against muxed fMP4 I-Frame
// playlists: the init segment referenced by the I-frame playlists contains
// BOTH tracks, and each byte range covers the full moof (audio + video
// track fragments) with a truncated mdat.
//
// Usage: node scripts/build-muxed-fmp4-stream.mjs
//
// Requires: ffmpeg in PATH, pbs-bars.mp4 in the repo root (generate it with
// scripts/generate-pbs-bars.py first).
// Optional: Apple's mediafilesegmenter (in PATH or via MEDIAFILESEGMENTER env)
// adds an HEVC variant packaged by Apple's own tool, whose interleaved track
// runs (many truns per traf) exercise client multi-trun handling; skipped
// with a note when the binary is missing.
// Optional: Bento4's mp4encrypt (brew install bento4, or MP4ENCRYPT env) and
// mediafilesegmenter also produce CBCS-encrypted muxed variants keyed with the
// Axinom public test vector (licenses through Axinom's public servers; see
// README). The encrypted I-Frame playlists exercise the hls.js muxed+encrypted
// I-Frame gap and are not expected to play there yet.

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const root = resolve(import.meta.dirname, '..');
const MEZZANINE = resolve(root, 'pbs-bars.mp4');
const OUT_DIR = resolve(root, 'streams/pbs/test-pattern-muxed-fmp4');
const MASTER_NAME = 'pbs-bars_muxed-avc.m3u8';

const FPS = '30000/1001';
const GOP_FRAMES = 90; // 3.003s at 29.97 — one IDR per segment
const SEGMENT_SECONDS = 3.003;

const VARIANTS = [
  {
    name: 'pbs-bars-muxed-AVC-720p',
    encoder: 'libx264',
    width: 1280,
    height: 720,
    crf: 23,
    profile: 'main',
    level: '3.1',
    videoCodec: 'avc1.4d401f',
  },
  {
    name: 'pbs-bars-muxed-AVC-432p',
    encoder: 'libx264',
    width: 768,
    height: 432,
    crf: 25,
    profile: 'main',
    level: '3.0',
    videoCodec: 'avc1.4d401e',
  },
  {
    name: 'pbs-bars-muxed-HEVC-720p',
    encoder: 'libx265',
    width: 1280,
    height: 720,
    crf: 26,
    videoCodec: 'hvc1.1.6.L93.B0',
  },
  {
    name: 'pbs-bars-muxed-HEVC-720p-apple',
    encoder: 'libx265',
    packager: 'mediafilesegmenter',
    width: 1280,
    height: 720,
    crf: 26,
    videoCodec: 'hvc1.1.6.L93.B0',
  },
];

// One master per packaging flavor so clients can be pointed at each in isolation
const MASTERS = {
  avc: { name: MASTER_NAME, match: (v) => v.encoder === 'libx264' },
  hevc: {
    name: 'pbs-bars_muxed-hevc.m3u8',
    match: (v) => v.encoder === 'libx265' && !v.packager,
  },
  hevcApple: {
    name: 'pbs-bars_muxed-hevc-apple.m3u8',
    match: (v) => v.packager === 'mediafilesegmenter',
  },
};

const MEDIAFILESEGMENTER =
  process.env.MEDIAFILESEGMENTER || 'mediafilesegmenter';
const MP4ENCRYPT = process.env.MP4ENCRYPT || 'mp4encrypt';

// Axinom public test vector: encrypted variants license through Axinom's
// public servers with the X-AxDRM-Message JWT in the README. Encrypted muxed
// I-Frame ranges are not yet supported by hls.js — those playlists are the
// test vectors for that work.
const DRM = {
  kid: '302f80dd411e4886bca5bb1f8018a024',
  kidUuid: '302f80dd-411e-4886-bca5-bb1f8018a024',
  key: '15b2aaf906ebec6309d40f91289127b8',
  iv: '77FD1889AAF4143B085548B3C0F95B9A',
  wvPssh:
    'AAAAOHBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAABgSEDAvgN1BHkiGvKW7H4AYoCRI88aJmwY=',
};

const AUDIO_BITRATE = '96k';
const AUDIO_CODEC = 'mp4a.40.2';

// ---------------------------------------------------------------------------
// Minimal ISO BMFF box reading (see generate-dedicated-pbs-iframes.mjs)
// ---------------------------------------------------------------------------

function readU64(buffer, offset) {
  return Number(buffer.readBigUInt64BE(offset));
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

function findChild(buffer, box, type) {
  return children(buffer, box).find((b) => b.type === type);
}

function findPath(buffer, box, path) {
  let current = box;
  for (const type of path) {
    current = current && findChild(buffer, current, type);
  }
  return current;
}

// Track IDs by handler type ('vide' | 'soun') from an init segment's moov
function parseInitTracks(buffer) {
  const moov = findTopBoxes(buffer).find((b) => b.type === 'moov');
  const tracks = {};
  for (const trak of children(buffer, moov).filter((b) => b.type === 'trak')) {
    const tkhd = findChild(buffer, trak, 'tkhd');
    const version = buffer[tkhd.offset + 8];
    const trackId = buffer.readUInt32BE(
      tkhd.offset + tkhd.headerSize + 4 + (version === 1 ? 16 : 8),
    );
    const hdlr = findPath(buffer, trak, ['mdia', 'hdlr']);
    const handler = buffer.toString(
      'ascii',
      hdlr.offset + hdlr.headerSize + 8,
      hdlr.offset + hdlr.headerSize + 12,
    );
    tracks[handler] = trackId;
  }
  return tracks;
}

// For the track fragment matching trackId: data offset of the first sample
// (relative to moof start with default-base-is-moof) and its size.
function parseFirstSample(buffer, moof, trackId) {
  for (const traf of children(buffer, moof).filter((b) => b.type === 'traf')) {
    const tfhd = findChild(buffer, traf, 'tfhd');
    const tfhdFlags = buffer.readUInt32BE(tfhd.offset + 8) & 0xffffff;
    const tfhdTrackId = buffer.readUInt32BE(tfhd.offset + 12);
    if (tfhdTrackId !== trackId) {
      continue;
    }
    let tfhdOffset = tfhd.offset + 16;
    if (tfhdFlags & 0x01) tfhdOffset += 8; // base_data_offset
    if (tfhdFlags & 0x02) tfhdOffset += 4; // sample_description_index
    if (tfhdFlags & 0x08) tfhdOffset += 4; // default_sample_duration
    const defaultSampleSize =
      tfhdFlags & 0x10 ? buffer.readUInt32BE(tfhdOffset) : 0;

    const trun = findChild(buffer, traf, 'trun');
    const trunFlags = buffer.readUInt32BE(trun.offset + 8) & 0xffffff;
    let offset = trun.offset + 16; // header + fullbox + sample_count
    let dataOffset = 0;
    if (trunFlags & 0x01) {
      dataOffset = buffer.readInt32BE(offset);
      offset += 4;
    }
    if (trunFlags & 0x04) offset += 4; // first_sample_flags
    if (trunFlags & 0x100) offset += 4; // first sample_duration
    const firstSampleSize =
      trunFlags & 0x200 ? buffer.readUInt32BE(offset) : defaultSampleSize;
    return { dataOffset, firstSampleSize };
  }
  return null;
}

// ffmpeg < 8.0 movenc writes an empty sdtp box into fragmented init segments
// when the encoder flags disposable B-frames (libx265 does, libx264 does not);
// Safari/CoreMedia refuses to decode HEVC fMP4 whose init contains it.
async function stripEmptySdtp(path) {
  const buffer = await readFile(path);
  const moov = findTopBoxes(buffer).find((b) => b.type === 'moov');
  for (const trak of children(buffer, moov).filter((b) => b.type === 'trak')) {
    const mdia = findChild(buffer, trak, 'mdia');
    const minf = mdia && findChild(buffer, mdia, 'minf');
    const stbl = minf && findChild(buffer, minf, 'stbl');
    const sdtp = stbl && findChild(buffer, stbl, 'sdtp');
    if (!sdtp || sdtp.size !== 12) {
      continue;
    }
    for (const box of [moov, trak, mdia, minf, stbl]) {
      buffer.writeUInt32BE(box.size - sdtp.size, box.offset);
    }
    await writeFile(
      path,
      Buffer.concat([buffer.subarray(0, sdtp.offset), buffer.subarray(sdtp.end)]),
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

function encodeArgs(variant) {
  const gopParams = `keyint=${GOP_FRAMES}:min-keyint=${GOP_FRAMES}:scenecut=0:open-gop=0`;
  const videoArgs =
    variant.encoder === 'libx265'
      ? [
          '-c:v', 'libx265',
          '-preset', 'fast',
          '-crf', String(variant.crf),
          '-tag:v', 'hvc1',
          '-x265-params', `${gopParams}:info=0`,
        ]
      : [
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', String(variant.crf),
          '-profile:v', variant.profile,
          '-level:v', variant.level,
          '-x264-params', gopParams,
        ];
  return [
    '-y',
    '-i', MEZZANINE,
    '-map', '0:v:0', '-map', '0:a:0',
    ...videoArgs,
    '-vf', `scale=${variant.width}:${variant.height}`,
    '-r', FPS,
    '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '2',
  ];
}

async function packageVariant(variant) {
  const args = [
    ...encodeArgs(variant),
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments',
    '-hls_fmp4_init_filename', `${variant.name}_init.mp4`,
    '-hls_segment_filename', resolve(OUT_DIR, `${variant.name}_%05d.m4s`),
    resolve(OUT_DIR, `${variant.name}.m3u8`),
  ];
  console.log(`[${variant.name}] ffmpeg packaging...`);
  await execFileP('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 });
  if (await stripEmptySdtp(resolve(OUT_DIR, `${variant.name}_init.mp4`))) {
    console.log(`[${variant.name}] stripped empty sdtp from init`);
  }
}

// Encode an intermediate muxed MP4 and let Apple's mediafilesegmenter package
// it, including its own I-frame index (-z). Returns null when the tool is
// missing so the ffmpeg-packaged variants still build without it.
async function packageAppleVariant(variant) {
  try {
    await execFileP(MEDIAFILESEGMENTER, ['--version']);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(
        `[${variant.name}] skipped: mediafilesegmenter not found ` +
          '(add to PATH or set MEDIAFILESEGMENTER)',
      );
      return null;
    }
  }
  const source = resolve(OUT_DIR, `${variant.name}_source.mp4`);
  console.log(`[${variant.name}] ffmpeg encoding source...`);
  await execFileP('ffmpeg', [...encodeArgs(variant), source], {
    maxBuffer: 16 * 1024 * 1024,
  });
  console.log(`[${variant.name}] mediafilesegmenter packaging...`);
  await execFileP(
    MEDIAFILESEGMENTER,
    [
      '--format', 'iso',
      '-t', '3',
      '-f', OUT_DIR,
      '-B', `${variant.name}_`,
      '-i', `${variant.name}.m3u8`,
      '-z', `${variant.name}_I-Frame.m3u8`,
      source,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  await packageAppleEncrypted(variant, source);
  await rm(source);
  return appleVariantInfo(variant);
}

// Apple-authored SAMPLE-AES (cbcs) flavor of the mediafilesegmenter variant.
// The segmenter generates its own constant IV and leaves URI="(null)" in the
// key tags, so both playlists are patched in a second pass with the IV read
// from the init's tenc box and Axinom's skd://<KID>:<IV> content id.
async function packageAppleEncrypted(variant, source) {
  const name = `${variant.name}-cbcs`;
  const keyFile = resolve(OUT_DIR, `${name}_key.bin`);
  await writeFile(keyFile, Buffer.from(DRM.key, 'hex'));
  console.log(`[${name}] mediafilesegmenter SAMPLE-AES packaging...`);
  await execFileP(
    MEDIAFILESEGMENTER,
    [
      '--format', 'iso',
      '-t', '3',
      '-S',
      '-k', keyFile,
      '-J', 'sequence',
      '-f', OUT_DIR,
      '-B', `${name}_`,
      '-i', `${name}.m3u8`,
      '-z', `${name}_I-Frame.m3u8`,
      source,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  await rm(keyFile);
  const { map } = parseMediaPlaylist(
    await readFile(resolve(OUT_DIR, `${name}.m3u8`), 'utf8'),
  );
  // tenc payload: version/flags(4) reserved(1) pattern(1) isProtected(1)
  // ivSize(1) KID(16) constantIVSize(1) constantIV(16)
  const init = await readFile(resolve(OUT_DIR, map));
  const tenc = init.indexOf('tenc');
  const iv = init
    .subarray(tenc + 4 + 25, tenc + 4 + 41)
    .toString('hex')
    .toUpperCase();
  const skd = `URI="skd://${DRM.kidUuid}:${iv}",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"`;
  for (const f of [`${name}.m3u8`, `${name}_I-Frame.m3u8`]) {
    const path = resolve(OUT_DIR, f);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replaceAll('URI="(null)"', skd));
  }
  const info = await appleVariantInfo({ ...variant, name });
  await writeVariantMaster(
    'pbs-bars_muxed-hevc-apple-cbcs.m3u8',
    { ...variant, name },
    info,
  );
}

function drmKeyLines(iv) {
  return [
    `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,${DRM.wvPssh}",KEYID=0x${DRM.kid},IV=0x${iv.toLowerCase()},KEYFORMATVERSIONS="1",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"`,
    `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://${DRM.kidUuid}:${iv.toUpperCase()}",KEYFORMATVERSIONS="1",KEYFORMAT="com.apple.streamingkeydelivery"`,
  ];
}

async function writeVariantMaster(masterName, variant, info) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-STREAM-INF:BANDWIDTH=${info.bandwidth},CODECS="${variant.videoCodec},${AUDIO_CODEC}",` +
      `RESOLUTION=${variant.width}x${variant.height},FRAME-RATE=29.970`,
    `${variant.name}.m3u8`,
    `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=${info.iframeBandwidth},CODECS="${variant.videoCodec}",` +
      `RESOLUTION=${variant.width}x${variant.height},URI="${info.iframeName}"`,
    '',
  ];
  await writeFile(resolve(OUT_DIR, masterName), lines.join('\n'));
  console.log(`Wrote ${resolve(OUT_DIR, masterName)}`);
}

// CBCS-encrypt a clear ffmpeg variant with Bento4 mp4encrypt into a
// single-file byterange asset (media + I-Frame playlists point into one
// encrypted fMP4; mp4encrypt keeps styp segment boundaries).
async function buildEncryptedByterangeVariant(clearVariant) {
  const name = `${clearVariant.name}-cbcs`;
  try {
    await execFileP(MP4ENCRYPT, []);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(
        `[${name}] skipped: mp4encrypt not found (brew install bento4 or set MP4ENCRYPT)`,
      );
      return;
    }
    // no-args usage error means the tool exists
  }
  const { map, segments } = parseMediaPlaylist(
    await readFile(resolve(OUT_DIR, `${clearVariant.name}.m3u8`), 'utf8'),
  );
  const parts = [await readFile(resolve(OUT_DIR, map))];
  for (const seg of segments) {
    parts.push(await readFile(resolve(OUT_DIR, seg.uri)));
  }
  const concatFile = resolve(OUT_DIR, `${name}_tmp-concat.mp4`);
  const psshFile = resolve(OUT_DIR, `${name}_tmp-pssh.bin`);
  await writeFile(concatFile, Buffer.concat(parts));
  await writeFile(psshFile, Buffer.from(DRM.wvPssh, 'base64').subarray(32));
  console.log(`[${name}] mp4encrypt cbcs packaging...`);
  const fileName = `${name}.mp4`;
  await execFileP(MP4ENCRYPT, [
    '--method', 'MPEG-CBCS',
    '--key', `1:${DRM.key}:${DRM.iv}`,
    '--property', `1:KID:${DRM.kid}`,
    '--key', `2:${DRM.key}:${DRM.iv}`,
    '--property', `2:KID:${DRM.kid}`,
    '--pssh', `edef8ba979d64acea3c827dcd51d21ed:${psshFile}`,
    concatFile,
    resolve(OUT_DIR, fileName),
  ]);
  await rm(concatFile);
  await rm(psshFile);

  const buffer = await readFile(resolve(OUT_DIR, fileName));
  const tops = findTopBoxes(buffer);
  const moovEnd = tops.find((b) => b.type === 'moov').end;
  const bounds = tops.filter((b) => b.type === 'styp').map((b) => b.offset);
  bounds.push(buffer.byteLength);
  const moofs = tops.filter((b) => b.type === 'moof');
  if (moofs.length !== segments.length) {
    throw new Error(
      `${name}: ${moofs.length} moofs for ${segments.length} segments`,
    );
  }
  const trackIds = parseInitTracks(buffer);
  const maxDur = Math.ceil(Math.max(...segments.map((s) => s.duration)));

  const media = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${maxDur}`,
    ...drmKeyLines(DRM.iv),
    `#EXT-X-MAP:URI="${fileName}",BYTERANGE="${moovEnd}@0"`,
  ];
  const iframe = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-I-FRAMES-ONLY',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${maxDur}`,
    ...drmKeyLines(DRM.iv),
    `#EXT-X-MAP:URI="${fileName}",BYTERANGE="${moovEnd}@0"`,
  ];
  let iframeBytes = 0;
  for (let i = 0; i < segments.length; i++) {
    const duration = segments[i].duration;
    media.push(`#EXTINF:${duration.toFixed(3)},`);
    media.push(`#EXT-X-BYTERANGE:${bounds[i + 1] - bounds[i]}@${bounds[i]}`);
    media.push(fileName);
    const video = parseFirstSample(buffer, moofs[i], trackIds.vide);
    if (!video?.firstSampleSize) {
      throw new Error(`${name}: could not parse video track run in moof ${i}`);
    }
    const length = video.dataOffset + video.firstSampleSize;
    iframeBytes += length;
    iframe.push(`#EXTINF:${duration.toFixed(3)},`);
    iframe.push(`#EXT-X-BYTERANGE:${length}@${moofs[i].offset}`);
    iframe.push(fileName);
  }
  media.push('#EXT-X-ENDLIST', '');
  iframe.push('#EXT-X-ENDLIST', '');
  await writeFile(resolve(OUT_DIR, `${name}.m3u8`), media.join('\n'));
  const iframeName = `${name}_I-Frame.m3u8`;
  await writeFile(resolve(OUT_DIR, iframeName), iframe.join('\n'));

  const totalDuration = segments.reduce((s, seg) => s + seg.duration, 0);
  const info = {
    bandwidth: Math.round((buffer.byteLength * 8) / totalDuration),
    iframeBandwidth: Math.round((iframeBytes * 8) / totalDuration),
    iframeName,
  };
  console.log(
    `[${name}] ${segments.length} I-frames, ${(iframeBytes / 1024).toFixed(0)} KiB over ${totalDuration.toFixed(2)}s -> ${info.iframeBandwidth} bps`,
  );
  await writeVariantMaster(
    'pbs-bars_muxed-avc-cbcs.m3u8',
    { ...clearVariant, name },
    info,
  );
}

function parseIframePlaylist(text) {
  const entries = [];
  let duration = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice('#EXTINF:'.length));
    } else if (line.startsWith('#EXT-X-BYTERANGE:') && duration !== null) {
      entries.push({
        duration,
        length: parseInt(line.slice('#EXT-X-BYTERANGE:'.length), 10),
      });
      duration = null;
    }
  }
  return entries;
}

function countVideoTruns(buffer, moof, trackId) {
  for (const traf of children(buffer, moof).filter((b) => b.type === 'traf')) {
    const tfhd = findChild(buffer, traf, 'tfhd');
    if (buffer.readUInt32BE(tfhd.offset + 12) !== trackId) {
      continue;
    }
    return children(buffer, traf).filter((b) => b.type === 'trun').length;
  }
  return 0;
}

async function appleVariantInfo(variant) {
  const { map, segments } = parseMediaPlaylist(
    await readFile(resolve(OUT_DIR, `${variant.name}.m3u8`), 'utf8'),
  );
  const initBuffer = await readFile(resolve(OUT_DIR, map));
  const trackIds = parseInitTracks(initBuffer);
  if (!trackIds.vide || !trackIds.soun) {
    throw new Error(
      `${variant.name}: expected muxed init with video and audio tracks, got ${JSON.stringify(trackIds)}`,
    );
  }
  // This variant exists to exercise interleaved runs — fail loudly if the
  // segmenter stopped producing them
  const firstSegment = await readFile(resolve(OUT_DIR, segments[0].uri));
  const moof = findTopBoxes(firstSegment).find((b) => b.type === 'moof');
  const truns = countVideoTruns(firstSegment, moof, trackIds.vide);
  if (truns < 2) {
    throw new Error(
      `${variant.name}: expected multiple video truns per traf, got ${truns}`,
    );
  }

  const iframeName = `${variant.name}_I-Frame.m3u8`;
  const entries = parseIframePlaylist(
    await readFile(resolve(OUT_DIR, iframeName), 'utf8'),
  );
  if (!entries.length) {
    throw new Error(`${variant.name}: ${iframeName} has no byterange entries`);
  }
  const totalBytes = entries.reduce((s, e) => s + e.length, 0);
  const totalDuration = entries.reduce((s, e) => s + e.duration, 0);
  const iframeBandwidth = Math.round((totalBytes * 8) / totalDuration);
  console.log(
    `[${variant.name}] ${entries.length} I-frames, ` +
      `${(totalBytes / 1024).toFixed(0)} KiB over ${totalDuration.toFixed(2)}s -> ${iframeBandwidth} bps ` +
      `(${truns} video truns/traf)`,
  );
  return {
    variant,
    iframeName,
    iframeBandwidth,
    bandwidth: await variantBandwidth(variant, segments),
  };
}

function parseMediaPlaylist(text) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let map = null;
  let pendingDur = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      map = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(line.slice('#EXTINF:'.length));
    } else if (!line.startsWith('#') && line.trim() && pendingDur !== null) {
      segments.push({ duration: pendingDur, uri: line.trim() });
      pendingDur = null;
    }
  }
  return { map, segments };
}

async function buildIframePlaylist(variant) {
  const playlistText = await readFile(
    resolve(OUT_DIR, `${variant.name}.m3u8`),
    'utf8',
  );
  const { map, segments } = parseMediaPlaylist(playlistText);
  if (!map) {
    throw new Error(`${variant.name}: media playlist has no EXT-X-MAP`);
  }
  const initBuffer = await readFile(resolve(OUT_DIR, map));
  const trackIds = parseInitTracks(initBuffer);
  if (!trackIds.vide || !trackIds.soun) {
    throw new Error(
      `${variant.name}: expected muxed init with video and audio tracks, got ${JSON.stringify(trackIds)}`,
    );
  }

  const entries = [];
  let maxDur = 0;
  for (const seg of segments) {
    const buffer = await readFile(resolve(OUT_DIR, seg.uri));
    const moofs = findTopBoxes(buffer).filter((b) => b.type === 'moof');
    if (moofs.length !== 1) {
      throw new Error(`${seg.uri}: expected 1 moof, found ${moofs.length}`);
    }
    const moof = moofs[0];
    const video = parseFirstSample(buffer, moof, trackIds.vide);
    if (!video?.firstSampleSize) {
      throw new Error(`${seg.uri}: could not parse video track run`);
    }
    // moof start -> end of the IDR's bytes (data offsets are moof-relative:
    // ffmpeg writes tfhd with default-base-is-moof)
    const length = video.dataOffset + video.firstSampleSize;
    entries.push({ length, offset: moof.offset, duration: seg.duration, uri: seg.uri });
    maxDur = Math.max(maxDur, seg.duration);
  }

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-I-FRAMES-ONLY',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`,
    `#EXT-X-MAP:URI="${map}"`,
  ];
  for (const e of entries) {
    lines.push(`#EXTINF:${e.duration.toFixed(3)},`);
    lines.push(`#EXT-X-BYTERANGE:${e.length}@${e.offset}`);
    lines.push(e.uri);
  }
  lines.push('#EXT-X-ENDLIST', '');

  const iframeName = `${variant.name}_I-Frame.m3u8`;
  await writeFile(resolve(OUT_DIR, iframeName), lines.join('\n'));

  const totalBytes = entries.reduce((s, e) => s + e.length, 0);
  const totalDuration = entries.reduce((s, e) => s + e.duration, 0);
  const bandwidth = Math.round((totalBytes * 8) / totalDuration);
  console.log(
    `[${variant.name}] ${entries.length} I-frames, ` +
      `${(totalBytes / 1024).toFixed(0)} KiB over ${totalDuration.toFixed(2)}s -> ${bandwidth} bps`,
  );
  return { iframeName, bandwidth, segments };
}

async function variantBandwidth(variant, segments) {
  let bytes = 0;
  for (const seg of segments) {
    bytes += (await stat(resolve(OUT_DIR, seg.uri))).size;
  }
  const duration = segments.reduce((s, seg) => s + seg.duration, 0);
  return Math.round((bytes * 8) / duration);
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const variantInfo = [];
  for (const variant of VARIANTS) {
    if (variant.packager === 'mediafilesegmenter') {
      const info = await packageAppleVariant(variant);
      if (info) {
        variantInfo.push(info);
      }
      continue;
    }
    await packageVariant(variant);
    const { iframeName, bandwidth: iframeBandwidth, segments } =
      await buildIframePlaylist(variant);
    const bandwidth = await variantBandwidth(variant, segments);
    variantInfo.push({ variant, iframeName, iframeBandwidth, bandwidth });
  }

  for (const master of Object.values(MASTERS)) {
    const included = variantInfo.filter(({ variant }) => master.match(variant));
    if (!included.length) {
      continue;
    }
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const { variant, bandwidth } of included) {
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${variant.videoCodec},${AUDIO_CODEC}",` +
          `RESOLUTION=${variant.width}x${variant.height},FRAME-RATE=29.970`,
        `${variant.name}.m3u8`,
      );
    }
    for (const { variant, iframeName, iframeBandwidth } of included) {
      lines.push(
        `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=${iframeBandwidth},CODECS="${variant.videoCodec}",` +
          `RESOLUTION=${variant.width}x${variant.height},URI="${iframeName}"`,
      );
    }
    await writeFile(resolve(OUT_DIR, master.name), [...lines, ''].join('\n'));
    console.log(`Wrote ${resolve(OUT_DIR, master.name)}`);
  }

  await buildEncryptedByterangeVariant(VARIANTS[0]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
