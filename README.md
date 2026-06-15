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

### PBS — 4K DRM Test Pattern (dedicated I-frame playlists)

PBS-branded SMPTE-style color-bars test stream packaged as 4K multicodec HLS (AV1, HEVC, AVC at multiple resolutions) with **CBCS/SAMPLE-AES** encryption via Axinom DRM. Each variant has a dedicated `EXT-X-I-FRAMES-ONLY` playlist backed by standalone CMAF fragment files (no byte-range references) so trick-play frames decrypt cleanly with the same keys.

#### AV1 + VP9 + HEVC + AVC

Playlist: https://pbs.github.io/test-streams/pbs/4k-drm-dedicated-iframes/pbs-bars.m3u8

#### HEVC + AVC

Playlist: https://pbs.github.io/test-streams/pbs/4k-drm-dedicated-iframes/pbs-bars_hevc-avc.m3u8

#### DRM

| Property | Value |
|---|---|
| Key ID | `302f80dd-411e-4886-bca5-bb1f8018a024` |
| Widevine license server | `https://drm-widevine-licensing.axprod.net/AcquireLicense` |
| FairPlay license server | `https://drm-fairplay-licensing.axprod.net/AcquireLicense` |
| FairPlay certificate | `https://tools.axinom.com/FPScert/fairplay.cer` |
| Auth header | `X-AxDRM-Message` |

JWT token (from [Axinom public-test-vectors](https://github.com/Axinom/public-test-vectors)):

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJ2ZXJzaW9uIjogMSwKICAiY29tX2tleV9pZCI6ICI2OWU1NDA4OC1lOWUwLTQ1MzAtOGMxYS0xZWI2ZGNkMGQxNGUiLAogICJtZXNzYWdlIjogewogICAgInR5cGUiOiAiZW50aXRsZW1lbnRfbWVzc2FnZSIsCiAgICAidmVyc2lvbiI6IDIsCiAgICAibGljZW5zZSI6IHsKICAgICAgImFsbG93X3BlcnNpc3RlbmNlIjogdHJ1ZQogICAgfSwKICAgICJjb250ZW50X2tleXNfc291cmNlIjogewogICAgICAiaW5saW5lIjogWwogICAgICAgIHsKICAgICAgICAgICJpZCI6ICIzMDJmODBkZC00MTFlLTQ4ODYtYmNhNS1iYjFmODAxOGEwMjQiLAogICAgICAgICAgImVuY3J5cHRlZF9rZXkiOiAicm9LQWcwdDdKaTFpNDNmd3YremZ0UT09IiwKICAgICAgICAgICJ1c2FnZV9wb2xpY3kiOiAiUG9saWN5IEEiCiAgICAgICAgfQogICAgICBdCiAgICB9LAogICAgImNvbnRlbnRfa2V5X3VzYWdlX3BvbGljaWVzIjogWwogICAgICB7CiAgICAgICAgIm5hbWUiOiAiUG9saWN5IEEiLAogICAgICAgICJwbGF5cmVhZHkiOiB7CiAgICAgICAgICAibWluX2RldmljZV9zZWN1cml0eV9sZXZlbCI6IDE1MCwKICAgICAgICAgICJwbGF5X2VuYWJsZXJzIjogWwogICAgICAgICAgICAiNzg2NjI3RDgtQzJBNi00NEJFLThGODgtMDhBRTI1NUIwMUE3IgogICAgICAgICAgXQogICAgICAgIH0KICAgICAgfQogICAgXQogIH0KfQ._NfhLVY7S6k8TJDWPeMPhUawhympnrk6WAZHOVjER6M
```
