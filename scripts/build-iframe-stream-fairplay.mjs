#!/usr/bin/env node
// Snapshot a remote FairPlay (SAMPLE-AES) single-file fMP4/CMAF HLS master +
// child playlists into streams/, and SYNTHESIZE #EXT-X-I-FRAME-STREAM-INF +
// matching I-frame-only child playlists by ffprobing every fragment for the IDR
// byte offset. Media is NOT copied — the rewritten playlists point at absolute
// URLs back to the origin server.
//
// This is the FairPlay sibling of build-iframe-stream-drm.mjs (Widevine /
// SAMPLE-AES-CTR). Two things make this asset different:
//   * SINGLE-FILE BYTERANGE fMP4: the whole variant lives in one video.mp4 and
//     every "segment" is an #EXT-X-BYTERANGE into it, including the #EXT-X-MAP
//     init range. There are no per-segment files, so the I-frame playlist also
//     references video.mp4 by byterange, and each I-frame byterange offset is
//     ABSOLUTE into video.mp4 (not 0 like the multi-file Widevine case).
//   * FAIRPLAY: #EXT-X-KEY uses METHOD=SAMPLE-AES with an skd:// URI and
//     KEYFORMAT="com.apple.streamingkeydelivery". The key line is carried into
//     the I-frame playlist verbatim; the skd:// URI must NOT be URL-resolved
//     against the origin. SAMPLE-AES (cbcs) encrypts NAL payloads in place and
//     preserves the moof/mdat box structure, so ffprobe still reports IDR byte
//     offsets/sizes from the container without the content key.
//
// To play, point a FairPlay-capable player at the EZDRM license server.
//
// Usage: node scripts/build-iframe-stream-fairplay.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileP = promisify(execFile);

const MASTER_URL = 'https://na-fps.ezdrm.com/demo/ezdrm/master.m3u8';
const CONCURRENCY = 8;

// Output path mirrors the origin URL: streams/<host>/<url-dirname>/
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _masterUrl = new URL(MASTER_URL);
const OUT_DIR = resolve(
  ROOT,
  'streams',
  _masterUrl.hostname,
  dirname(_masterUrl.pathname).replace(/^\/+/, ''),
);
const MASTER_FILENAME = _masterUrl.pathname.split('/').pop();
const TMP = tmpdir();

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Parse a master playlist. Returns { lines, variants } where each variant is
// { attrs, uri } for an #EXT-X-STREAM-INF (video) entry.
function parseMaster(text) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      variants.push({ attrs: lines[i].slice('#EXT-X-STREAM-INF:'.length), uri: lines[i + 1] });
    }
  }
  return { lines, variants };
}

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]+))/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] ?? m[4];
  return out;
}

// Parse `<length>[@<offset>]`. If offset is absent the caller supplies the
// running offset (byte after the previous sub-range of the same resource).
function parseByterange(s) {
  const [len, off] = s.split('@');
  return { length: parseInt(len, 10), offset: off !== undefined ? parseInt(off, 10) : null };
}

// Parse a single-file byterange media playlist into an ordered list of events,
// resolving every byterange to an absolute { length, offset } into the media
// file. Because the #EXT-X-MAP init range and every segment share one resource
// (video.mp4), a missing @offset continues from the previous range's end.
//   { type: 'map',  uri, range }
//   { type: 'key',  line }            (verbatim #EXT-X-KEY line)
//   { type: 'disc' }                  (#EXT-X-DISCONTINUITY)
//   { type: 'seg',  duration, uri, range }
function parseMedia(text) {
  const lines = text.split(/\r?\n/);
  const events = [];
  let pendingDur = null;
  let pendingRange = null;
  let mapUri = null;
  let lastEnd = 0; // running end offset for implicit byterange continuation
  const resolveRange = (r) => {
    const offset = r.offset !== null ? r.offset : lastEnd;
    lastEnd = offset + r.length;
    return { length: r.length, offset };
  };
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const u = line.match(/URI="([^"]+)"/);
      const br = line.match(/BYTERANGE="([^"]+)"/);
      mapUri = u ? u[1] : null;
      const range = br ? resolveRange(parseByterange(br[1])) : null;
      events.push({ type: 'map', uri: mapUri, range });
    } else if (line.startsWith('#EXT-X-KEY:')) {
      events.push({ type: 'key', line });
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      events.push({ type: 'disc' });
    } else if (line.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(line.slice('#EXTINF:'.length));
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByterange(line.slice('#EXT-X-BYTERANGE:'.length));
    } else if (!line.startsWith('#') && line.trim() && pendingDur !== null) {
      const range = pendingRange ? resolveRange(pendingRange) : null;
      events.push({ type: 'seg', duration: pendingDur, uri: line.trim(), range });
      pendingDur = null;
      pendingRange = null;
    }
  }
  return { events, mapUri };
}

// A URI is left untouched if it already carries a scheme (https:, data:, and
// crucially skd: for the FairPlay key). Only schemeless relative refs (e.g.
// video.mp4, stream_0.m3u8) are resolved against the playlist's origin URL.
function abs(uri, base) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
  return new URL(uri, base).href;
}

// Rewrite a child playlist so every segment reference and URI="" attr is
// absolute back to origin. Scheme-bearing URIs (the skd:// key) are left as-is.
function rewriteChildAbsolute(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/, (full, uri) => `URI="${abs(uri, baseUrl)}"`);
      }
      return abs(line, baseUrl);
    })
    .join('\n');
}

// ffprobe a fragment (init segment concatenated in front of a media byterange)
// for the first video keyframe's { pos, size } (file-relative). The caller
// subtracts initSize to get the offset within the original fragment.
async function probeFirstKeyframe(filePath) {
  const { stdout } = await execFileP(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_packets',
      '-show_entries', 'packet=size,pos,flags',
      '-of', 'json',
      '-i', filePath,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const packets = JSON.parse(stdout).packets || [];
  for (const p of packets) {
    if (typeof p.flags === 'string' && p.flags.startsWith('K')) {
      return { pos: parseInt(p.pos, 10), size: parseInt(p.size, 10) };
    }
  }
  return null;
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

async function processVariant(variant, masterUrl, idx) {
  const attrs = parseAttrs(variant.attrs);
  const variantUrl = new URL(variant.uri, masterUrl);
  const tag = `[${attrs.RESOLUTION || variant.uri}]`;
  console.log(`${tag} fetching ${variantUrl.href}`);
  const childText = await fetchText(variantUrl);
  const { events, mapUri } = parseMedia(childText);

  if (!mapUri) throw new Error(`${tag} no #EXT-X-MAP — not fMP4?`);
  const mapEvent = events.find((e) => e.type === 'map');
  if (!mapEvent?.range) throw new Error(`${tag} #EXT-X-MAP has no BYTERANGE`);

  // This asset is single-file byterange fMP4: every segment references the same
  // media file as the init MAP. Download it once and slice ranges locally.
  const mediaUrl = new URL(mapUri, variantUrl).href;
  const mediaBuf = await fetchBuffer(mediaUrl);
  const initBuf = mediaBuf.subarray(
    mapEvent.range.offset,
    mapEvent.range.offset + mapEvent.range.length,
  );
  const initSize = initBuf.length;

  const segEvents = events.filter((e) => e.type === 'seg');
  const probed = await mapLimit(
    segEvents,
    CONCURRENCY,
    async (seg, i) => {
      const segBuf = mediaBuf.subarray(seg.range.offset, seg.range.offset + seg.range.length);
      const catPath = resolve(TMP, `iframe-fps-${idx}-${i}.mp4`);
      await writeFile(catPath, Buffer.concat([initBuf, segBuf]));
      const kf = await probeFirstKeyframe(catPath);
      // I-frame byterange covers [start of fragment .. end of keyframe sample],
      // i.e. styp/moof (with the cbcs senc/saiz/saio + trun) plus the IDR bytes
      // — everything a player needs to decrypt and decode the frame. The offset
      // is ABSOLUTE into video.mp4 (the fragment's own offset).
      const length = kf ? kf.pos - initSize + kf.size : seg.range.length;
      return { length, offset: seg.range.offset };
    },
    (done, total) => process.stdout.write(`${tag} probed ${done}/${total}\r`),
  );
  process.stdout.write('\n');

  // ---- Build the I-frame playlist, carrying MAP / KEY / DISCONTINUITY ----
  const out = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-I-FRAMES-ONLY',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  let maxDur = 0;
  let segCursor = 0;
  const body = [];
  let totalBytes = 0;
  let totalDuration = 0;
  for (const ev of events) {
    if (ev.type === 'map') {
      body.push(
        `#EXT-X-MAP:URI="${abs(ev.uri, variantUrl)}",BYTERANGE="${ev.range.length}@${ev.range.offset}"`,
      );
    } else if (ev.type === 'key') {
      // skd:// key URI needs no rewrite; rewriteChildAbsolute leaves it as-is.
      body.push(rewriteChildAbsolute(ev.line, variantUrl));
    } else if (ev.type === 'disc') {
      body.push('#EXT-X-DISCONTINUITY');
    } else if (ev.type === 'seg') {
      const { length, offset } = probed[segCursor++];
      totalBytes += length;
      totalDuration += ev.duration;
      maxDur = Math.max(maxDur, ev.duration);
      body.push(`#EXTINF:${ev.duration.toFixed(3)},`);
      body.push(`#EXT-X-BYTERANGE:${length}@${offset}`);
      body.push(abs(ev.uri, variantUrl));
    }
  }
  out.push(`#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`);
  const iframePlaylist = [...out, ...body, '#EXT-X-ENDLIST', ''].join('\n');
  const iframeBandwidth = Math.round((totalBytes * 8) / totalDuration);

  // ---- Write the rewritten child playlist + the I-frame playlist ----
  const relChild = variant.uri;
  const relIframe = relChild.replace(/\.m3u8$/, '.iframe.m3u8');
  const outChild = resolve(OUT_DIR, relChild);
  const outIframe = resolve(OUT_DIR, relIframe);
  await mkdir(dirname(outChild), { recursive: true });
  await writeFile(outChild, rewriteChildAbsolute(childText, variantUrl));
  await writeFile(outIframe, iframePlaylist);

  const codecs = (attrs.CODECS || '')
    .split(',')
    .filter((c) => /^(avc|hev|hvc)/i.test(c.trim()))
    .map((c) => c.trim())
    .join(',');

  console.log(
    `${tag} ${probed.length} I-frames, ${(totalBytes / 1024).toFixed(1)} KiB over ` +
      `${totalDuration.toFixed(1)}s -> ${iframeBandwidth} bps`,
  );

  return { bandwidth: iframeBandwidth, codecs, resolution: attrs.RESOLUTION, uri: relIframe };
}

async function main() {
  console.log(`Master: ${MASTER_URL}`);
  console.log(`Output: ${OUT_DIR}`);
  await mkdir(OUT_DIR, { recursive: true });

  const masterText = await fetchText(MASTER_URL);
  const masterUrl = new URL(MASTER_URL);
  const { variants } = parseMaster(masterText);

  // Mirror every audio/subtitle media playlist locally too, with segment refs
  // rewritten to absolute origin URLs, so the hosted master is fully resolvable.
  const mediaUris = [...masterText.matchAll(/#EXT-X-MEDIA:[^\n]*URI="([^"]+)"/g)].map((m) => m[1]);
  for (const uri of mediaUris) {
    const u = new URL(uri, masterUrl);
    const text = await fetchText(u);
    const outPath = resolve(OUT_DIR, uri);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, rewriteChildAbsolute(text, u));
    console.log(`[media] ${uri}`);
  }

  const iframeInfs = [];
  for (let i = 0; i < variants.length; i++) {
    iframeInfs.push(await processVariant(variants[i], masterUrl, i));
  }

  // Append I-frame stream-inf lines to the original master, in variant order.
  // Child STREAM-INF / MEDIA URIs stay relative — they resolve to the local copies.
  let out = masterText;
  if (!out.endsWith('\n')) out += '\n';
  for (const inf of iframeInfs) {
    const a = [
      `BANDWIDTH=${inf.bandwidth}`,
      inf.codecs ? `CODECS="${inf.codecs}"` : null,
      inf.resolution ? `RESOLUTION=${inf.resolution}` : null,
      `URI="${inf.uri}"`,
    ]
      .filter(Boolean)
      .join(',');
    out += `#EXT-X-I-FRAME-STREAM-INF:${a}\n`;
  }

  const masterOut = resolve(OUT_DIR, MASTER_FILENAME);
  await writeFile(masterOut, out);
  console.log(`\nWrote ${masterOut}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
