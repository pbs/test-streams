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

### PBS — Test Pattern

PBS-branded SMPTE-style color-bars test stream packaged as 4K multicodec HLS, captions, burned in ABR variant id overlay (e.g. 720 HEVC or 2160 AV1), and I-frame playlists for trick-play.

Built with AWS MediaConvert

#### HEVC + AVC

Playlist: https://pbs.github.io/test-streams/pbs/test-pattern/pbs-bars_hevc-avc.m3u8

#### AV1 + VP9 + HEVC + AVC

Playlist: https://pbs.github.io/test-streams/pbs/test-pattern/pbs-bars_av1-vp9-hevc-avc.m3u8
