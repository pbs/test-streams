# test-streams

A collection of HLS test streams.

## Streams

### Mux — Big Buck Bunny (with I-frame playlists added)

A multivariant HLS playlist of *Big Buck Bunny* sourced from Mux's `test-streams.mux.dev`, with `EXT-X-I-FRAME-STREAM-INF` entries for trick-play (scrubbing/seek thumbnails).

Only the patched manifests are hosted here; all media segments (`.ts`) are still served by Mux via absolute URLs.

Playlist: https://pbs.github.io/test-streams/test-streams.mux.dev/x36xhzz/x36xhzz.m3u8

### Shaka — Angel One (Widevine, with I-frame playlists added)

A multivariant fMP4/CMAF HLS playlist of *Angel One* sourced from the Shaka demo assets, encrypted with **Widevine** (`SAMPLE-AES-CTR`) with a short clear lead. `EXT-X-I-FRAME-STREAM-INF` entries plus I-frame-only child playlists were synthesized for trick-play (scrubbing/seek thumbnails).

Because the content is CENC-encrypted, the I-frame playlists carry the original `EXT-X-KEY`, `EXT-X-MAP`, and `EXT-X-DISCONTINUITY` tags so trick-play frames decrypt with the same keys. CENC preserves the fMP4 box structure, so the IDR byteranges were derived from the container without the content key.

Only the patched manifests are hosted here; all media segments (`.mp4`) and the in-manifest Widevine `pssh` (`data:` URI) are still served from the Shaka origin via absolute URLs. To play, point your DRM-capable player at the Widevine license server `https://cwip-shaka-proxy.appspot.com/no_auth`.

Playlist: https://pbs.github.io/test-streams/storage.googleapis.com/shaka-demo-assets/angel-one-widevine-hls/hls.m3u8

### EZDRM — FairPlay (with I-frame playlists added)

A single-file fMP4/CMAF HLS playlist sourced from EZDRM's FairPlay demo, encrypted with **FairPlay** (`SAMPLE-AES`, `cbcs`). `EXT-X-I-FRAME-STREAM-INF` entries plus an I-frame-only child playlist were synthesized for trick-play (scrubbing/seek thumbnails).

The whole variant lives in one `video.mp4` addressed entirely by `EXT-X-BYTERANGE`, so the I-frame playlist also references `video.mp4` by byterange — each I-frame byterange is an absolute offset into the file covering the fragment header (with the `cbcs` `senc`/`saiz`/`saio` boxes) through the IDR sample. The I-frame playlist carries the original `EXT-X-KEY` (with its `skd://` URI) and `EXT-X-MAP` so trick-play frames decrypt with the same key. `SAMPLE-AES` preserves the fMP4 box structure, so the IDR byteranges were derived from the container without the content key.

Only the patched manifests are hosted here; the media (`video.mp4`, `audio.mp4`) and the EZDRM FairPlay license server are still served from the EZDRM origin via absolute URLs. To play, point a FairPlay-capable player at the EZDRM license server.

Playlist: https://pbs.github.io/test-streams/na-fps.ezdrm.com/demo/ezdrm/master.m3u8

### PBS — Test Pattern

PBS-branded SMPTE-style color-bars test stream packaged as 4K multicodec HLS, captions, burned in ABR variant id overlay (e.g. 720 HEVC or 2160 AV1), and I-frame playlists for trick-play.

Built with AWS MediaConvert

#### HEVC + AVC

Playlist: https://pbs.github.io/test-streams/pbs/test-pattern/pbs-bars_hevc-avc.m3u8

#### AV1 + VP9 + HEVC + AVC

Playlist: https://pbs.github.io/test-streams/pbs/test-pattern/pbs-bars_av1-vp9-hevc-avc.m3u8
