#!/usr/bin/env node
// Repackage the clear CMAF ladder behind streams/pbs/test-pattern/
// pbs-bars_hevc-avc.m3u8 into a multi-DRM copy with Shaka Packager. Media is
// repackaged, not re-encoded: each variant's init + segments are concatenated
// into a single fMP4 and fed to packager, which re-segments, encrypts, and
// writes fresh playlists (including #EXT-X-I-FRAMES-ONLY trick-play
// playlists via iframe_playlist_name).
//
// Encryption is CBCS with the Axinom public test vector key so one set of
// segments serves Widevine, PlayReady, and FairPlay (FairPlay requires cbcs;
// the others accept it). Output licenses through Axinom's public servers
// with the X-AxDRM-Message JWT documented in the README.
//
// Usage: node scripts/build-drm-stream.mjs
// Requires: Shaka Packager in PATH as 'packager' (or set SHAKA_PACKAGER).

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_DIR = resolve(ROOT, 'streams/pbs/test-pattern');
const OUT_DIR = resolve(ROOT, 'streams/pbs/test-pattern-drm');
const MASTER = 'pbs-bars_hevc-avc.m3u8';
const CAPTIONS = resolve(ROOT, 'pbs-bars.vtt');
const PACKAGER = process.env.SHAKA_PACKAGER || 'packager';

// Axinom public test vector (CMAF single-key). Constant IV matches the form
// Axinom's FairPlay server expects appended to the skd:// content id.
const KID = '302f80dd411e4886bca5bb1f8018a024';
const KEY = '15b2aaf906ebec6309d40f91289127b8';
const IV = '77FD1889AAF4143B085548B3C0F95B9A';
const SKD_URI = `skd://302f80dd-411e-4886-bca5-bb1f8018a024:${IV}`;
const SEGMENT_SECONDS = 6.006;

function parseMaster(text) {
  const video = [];
  let audio = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      video.push(lines[++i].trim().replace(/\.m3u8$/, ''));
    } else if (lines[i].startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      audio = /URI="([^"]+)"/.exec(lines[i])[1].replace(/\.m3u8$/, '');
    }
  }
  return { video, audio };
}

// Rebuild one continuous fMP4 from a variant's init + CMAF segments
async function concatVariant(name, ext, tmp) {
  const parts = [await readFile(resolve(SRC_DIR, `${name}init.${ext}`))];
  const segments = (await readdir(SRC_DIR))
    .filter((f) => f.startsWith(`${name}_`) && f.endsWith(`.${ext}`))
    .sort();
  if (!segments.length) {
    throw new Error(`${name}: no .${ext} segments found`);
  }
  for (const f of segments) {
    parts.push(await readFile(resolve(SRC_DIR, f)));
  }
  const out = join(tmp, `${name}.mp4`);
  await writeFile(out, Buffer.concat(parts));
  return out;
}

async function main() {
  const { video, audio } = parseMaster(
    await readFile(resolve(SRC_DIR, MASTER), 'utf8'),
  );
  console.log(`${video.length} video variants + audio '${audio}' from ${MASTER}`);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), 'pbs-drm-src-'));

  const descriptors = [];
  for (const name of video) {
    const input = await concatVariant(name, 'cmfv', tmp);
    descriptors.push(
      `in=${input},stream=video,init_segment=${name}_init.mp4,` +
        `segment_template=${name}_$Number%09d$.m4s,playlist_name=${name}.m3u8,` +
        `iframe_playlist_name=${name}_I-Frame.m3u8`,
    );
  }
  const audioInput = await concatVariant(audio, 'cmfa', tmp);
  descriptors.push(
    `in=${audioInput},stream=audio,init_segment=${audio}_init.mp4,` +
      `segment_template=${audio}_$Number%09d$.m4s,playlist_name=${audio}.m3u8,` +
      `hls_group_id=audio_aac,hls_name=English,language=eng`,
  );
  descriptors.push(
    `in=${CAPTIONS},stream=text,segment_template=pbs-bars-captions_$Number%09d$.vtt,` +
      `playlist_name=pbs-bars-captions.m3u8,hls_group_id=subs,hls_name=English,language=eng`,
  );

  const args = [
    ...descriptors,
    '--enable_raw_key_encryption',
    '--keys', `label=:key_id=${KID}:key=${KEY}`,
    '--iv', IV,
    '--protection_scheme', 'cbcs',
    '--protection_systems', 'Widevine,PlayReady,FairPlay',
    '--clear_lead', '0',
    '--segment_duration', String(SEGMENT_SECONDS),
    '--hls_playlist_type', 'VOD',
    '--hls_key_uri', SKD_URI,
    '--hls_master_playlist_output', MASTER,
  ];
  console.log('packaging...');
  await execFileP(PACKAGER, args, { cwd: OUT_DIR, maxBuffer: 16 * 1024 * 1024 });
  await rm(tmp, { recursive: true, force: true });

  // Match Axinom's known-good cbcs reference: no PlayReady #EXT-X-KEY (its
  // WRMHEADER data: URI derails hls.js EME setup — see
  // build-4k-drm-dedicated-iframes.mjs). PlayReady clients still get the
  // in-segment pssh box written by --protection_systems.
  for (const f of (await readdir(OUT_DIR)).filter((f) => f.endsWith('.m3u8'))) {
    const path = resolve(OUT_DIR, f);
    const text = await readFile(path, 'utf8');
    const filtered = text
      .split('\n')
      .filter((l) => !l.includes('KEYFORMAT="com.microsoft.playready"'))
      .join('\n');
    if (filtered !== text) {
      await writeFile(path, filtered);
    }
  }

  // Single-codec masters: Chrome/Edge Widevine cannot decode ENCRYPTED HEVC
  // (license succeeds, key goes usable, no frames ever decode), so the mixed
  // master silently stalls whenever ABR starts on an HEVC level. AVC-only is
  // the master to use with Widevine browsers; HEVC-only isolates FairPlay.
  const masterText = await readFile(resolve(OUT_DIR, MASTER), 'utf8');
  for (const [name, codec] of [
    ['pbs-bars_avc.m3u8', 'avc1'],
    ['pbs-bars_hevc.m3u8', 'hvc1'],
  ]) {
    const lines = masterText.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        if (lines[i].includes(`CODECS="${codec}`)) {
          out.push(lines[i], lines[++i]);
        } else {
          i++;
        }
      } else if (lines[i].startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
        if (lines[i].includes(`CODECS="${codec}`)) {
          out.push(lines[i]);
        }
      } else {
        out.push(lines[i]);
      }
    }
    await writeFile(resolve(OUT_DIR, name), out.join('\n'));
  }

  const outputs = await readdir(OUT_DIR);
  console.log(
    `Wrote ${resolve(OUT_DIR, MASTER)} ` +
      `(${outputs.filter((f) => f.endsWith('.m3u8')).length} playlists, ` +
      `${outputs.filter((f) => f.endsWith('.m4s')).length} media segments)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
