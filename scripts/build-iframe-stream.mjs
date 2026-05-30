#!/usr/bin/env node
// Snapshot a remote HLS master + variant playlists into demo/public/, and
// SYNTHESIZE #EXT-X-I-FRAME-STREAM-INF + matching I-frame-only child playlists
// by ffprobing every segment for IDR byte offsets. Segments are NOT copied —
// the rewritten playlists point at absolute URLs back to the origin server.
//
// Usage: node scripts/build-iframe-stream.mjs
//
// Edit MASTER_URL / OUT_SUBDIR below to retarget.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const MASTER_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const CONCURRENCY = 8;

// Output path mirrors the origin URL: demo/public/streams/<host>/<url-dirname>/
// e.g. https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
//      -> demo/public/streams/test-streams.mux.dev/x36xhzz/
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _masterUrl = new URL(MASTER_URL);
const OUT_DIR = resolve(
  ROOT,
  'demo/public/streams',
  _masterUrl.hostname,
  dirname(_masterUrl.pathname).replace(/^\/+/, ''),
);
const MASTER_FILENAME = _masterUrl.pathname.split('/').pop();

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

// Parse a master playlist. Returns { headerLines, variants: [{ attrs, uri }] }.
function parseMaster(text) {
  const lines = text.split(/\r?\n/);
  const headerLines = [];
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
      const uri = lines[++i];
      variants.push({ attrs, uri });
    } else {
      headerLines.push(line);
    }
  }
  return { headerLines, variants };
}

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]+))/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] ?? m[4];
  return out;
}

// Parse a media playlist. Returns [{ duration, uri }].
function parseSegments(text) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let pendingDur = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(line.slice('#EXTINF:'.length));
    } else if (!line.startsWith('#') && line.trim() && pendingDur !== null) {
      segments.push({ duration: pendingDur, uri: line.trim() });
      pendingDur = null;
    }
  }
  return segments;
}

// Rewrite a child playlist so every segment reference (and any URI="" attr) is absolute.
function rewriteChildAbsolute(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/, (full, uri) =>
          /^https?:/i.test(uri) ? full : `URI="${new URL(uri, baseUrl).href}"`,
        );
      }
      return /^https?:/i.test(line) ? line : new URL(line, baseUrl).href;
    })
    .join('\n');
}

async function probeSegment(url) {
  const { stdout } = await execFileP(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_packets',
      '-show_format',
      '-show_entries', 'packet=pts_time,size,pos,flags:format=size',
      '-of', 'json',
      '-i', url,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout);
  const fileSize = parseInt(data.format?.size, 10);
  // Return ALL video packets so buildIframePlaylist can compute tight byteranges
  // (start of IDR PES → start of next video PES, mirroring Apple's mediafilesegmenter).
  const videoPackets = (data.packets || []).map((p) => ({
    pts: parseFloat(p.pts_time),
    pos: parseInt(p.pos, 10),
    isIdr: typeof p.flags === 'string' && p.flags.startsWith('K'),
  }));
  return { fileSize, videoPackets };
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
        done++;
        onProgress?.(done, items.length);
      }
    }),
  );
  return results;
}

function buildIframePlaylist(segments, probed) {
  const entries = [];
  let maxDur = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const { videoPackets, fileSize } = probed[i];
    if (!videoPackets.length) continue;
    const segStartPts = videoPackets[0].pts;
    // Indices of IDR packets within videoPackets.
    const idrIndices = videoPackets
      .map((p, idx) => (p.isIdr ? idx : -1))
      .filter((idx) => idx !== -1);
    for (let j = 0; j < idrIndices.length; j++) {
      const idrIdx = idrIndices[j];
      const idr = videoPackets[idrIdx];
      // Tight byterange: start of this IDR's PES → start of the next video PES
      // (or end-of-file if this IDR is the last video packet in the segment).
      const endPos =
        idrIdx < videoPackets.length - 1 ? videoPackets[idrIdx + 1].pos : fileSize;
      const length = endPos - idr.pos;
      // EXTINF: time until the next IDR (in this or next segment) — represents how
      // long this thumbnail "covers" on the trick-play timeline.
      const nextIdrIdx = j < idrIndices.length - 1 ? idrIndices[j + 1] : -1;
      const nextPts =
        nextIdrIdx !== -1 ? videoPackets[nextIdrIdx].pts : segStartPts + seg.duration;
      const duration = Math.max(0.001, nextPts - idr.pts);
      maxDur = Math.max(maxDur, duration);
      entries.push({ length, offset: idr.pos, duration, uri: seg.uri });
    }
  }
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-I-FRAMES-ONLY',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`,
  ];
  for (const e of entries) {
    lines.push(`#EXTINF:${e.duration.toFixed(3)},`);
    lines.push(`#EXT-X-BYTERANGE:${e.length}@${e.offset}`);
    lines.push(e.uri);
  }
  lines.push('#EXT-X-ENDLIST', '');
  const totalBytes = entries.reduce((s, e) => s + e.length, 0);
  const totalDuration = entries.reduce((s, e) => s + e.duration, 0);
  return { playlist: lines.join('\n'), totalBytes, totalDuration, count: entries.length };
}

async function processVariant(variant, masterUrl) {
  const attrs = parseAttrs(variant.attrs);
  const variantUrl = new URL(variant.uri, masterUrl);
  const tag = `[${attrs.RESOLUTION || variant.uri}]`;
  console.log(`${tag} fetching ${variantUrl.href}`);
  const childText = await fetchText(variantUrl);
  const segments = parseSegments(childText);

  const probed = await mapLimit(
    segments,
    CONCURRENCY,
    (seg) => probeSegment(new URL(seg.uri, variantUrl).href),
    (done, total) => process.stdout.write(`${tag} probed ${done}/${total}\r`),
  );
  process.stdout.write('\n');

  const segmentsAbs = segments.map((s) => ({
    duration: s.duration,
    uri: new URL(s.uri, variantUrl).href,
  }));
  const { playlist: iframePlaylist, totalBytes, totalDuration, count } =
    buildIframePlaylist(segmentsAbs, probed);
  const iframeBandwidth = Math.round((totalBytes * 8) / totalDuration);

  const rewrittenChild = rewriteChildAbsolute(childText, variantUrl);

  const relChild = variant.uri;
  const relIframe = relChild.replace(/\.m3u8$/, '.iframe.m3u8');
  const outChild = resolve(OUT_DIR, relChild);
  const outIframe = resolve(OUT_DIR, relIframe);

  await mkdir(dirname(outChild), { recursive: true });
  await writeFile(outChild, rewrittenChild);
  await writeFile(outIframe, iframePlaylist);

  const codecs = (attrs.CODECS || '')
    .split(',')
    .filter((c) => /^(avc|hev|hvc)/i.test(c.trim()))
    .map((c) => c.trim())
    .join(',');

  console.log(
    `${tag} ${count} I-frames, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB ` +
      `over ${totalDuration.toFixed(2)}s -> ${iframeBandwidth} bps`,
  );

  return {
    bandwidth: iframeBandwidth,
    codecs,
    resolution: attrs.RESOLUTION,
    uri: relIframe,
  };
}

async function main() {
  console.log(`Master: ${MASTER_URL}`);
  console.log(`Output: ${OUT_DIR}`);
  await mkdir(OUT_DIR, { recursive: true });

  const masterText = await fetchText(MASTER_URL);
  const masterUrl = new URL(MASTER_URL);
  const { variants } = parseMaster(masterText);

  const iframeInfs = [];
  for (const v of variants) {
    iframeInfs.push(await processVariant(v, masterUrl));
  }

  // Append I-frame stream-inf lines to the original master, in variant order.
  let out = masterText;
  if (!out.endsWith('\n')) out += '\n';
  for (const inf of iframeInfs) {
    const attrs = [
      `BANDWIDTH=${inf.bandwidth}`,
      inf.codecs ? `CODECS="${inf.codecs}"` : null,
      inf.resolution ? `RESOLUTION=${inf.resolution}` : null,
      `URI="${inf.uri}"`,
    ]
      .filter(Boolean)
      .join(',');
    out += `#EXT-X-I-FRAME-STREAM-INF:${attrs}\n`;
  }

  const masterOut = resolve(OUT_DIR, MASTER_FILENAME);
  await writeFile(masterOut, out);
  console.log(`\nWrote ${masterOut}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
