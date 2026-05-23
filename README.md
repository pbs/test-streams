# test-streams

A collection of HLS test streams.

## Streams

### Mux — Big Buck Bunny (with I-frame playlists added)

A multivariant HLS playlist of *Big Buck Bunny* sourced from Mux's `test-streams.mux.dev`, with `EXT-X-I-FRAME-STREAM-INF` entries for trick-play (scrubbing/seek thumbnails).

Only the patched manifests are hosted here; all media segments (`.ts`) are still served by Mux via absolute URLs.

Playlist: https://pbs.github.io/test-streams/test-streams.mux.dev/x36xhzz/x36xhzz.m3u8

### PBS — Test Pattern

PBS-branded SMPTE-style color-bars test stream packaged as 4K multicodec HLS, captions, burned in ABR variant id overlay (e.g. 720 HEVC or 2160 AV1), and I-frame playlists for trick-play.

Built with AWS MediaConvert

#### HEVC + AVC

Playlist: https://pbs.github.io/test-streams/pbs/test-pattern/pbs-bars_hevc-avc.m3u8

#### AV1 + VP9 + HEVC + AVC

Playlist: https://pbs.github.io/test-streams/pbs/test-pattern/pbs-bars_av1-vp9-hevc-avc.m3u8
