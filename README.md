# test-streams

A collection of HLS test streams.

## Streams

### Mux — Big Buck Bunny (with I-frame playlists added)

A multivariant HLS playlist of *Big Buck Bunny* sourced from Mux's `test-streams.mux.dev`, with `EXT-X-I-FRAME-STREAM-INF` entries for trick-play (scrubbing/seek thumbnails).

Only the patched manifests are hosted here; all media segments (`.ts`) are still served by Mux via absolute URLs.

Playlist: https://pbs.github.io/test-streams/test-streams.mux.dev/x36xhzz/x36xhzz.m3u8

### PBS — Test Pattern (HEVC + AVC)

A PBS-branded SMPTE-style color-bars test stream packaged as multivariant HLS with HEVC and AVC renditions (234p / 432p / 720p / 1080p, plus HEVC-only at 1440p and 2160p), I-frame playlists for trick-play, AAC audio, and a top-positioned WebVTT caption track.

Playlist: https://pbs.github.io/test-streams/streams/pbs/test-pattern/pbs-bars_hevc-avc.m3u8

### PBS — Test Pattern (AV1 + VP9 + HEVC + AVC)

The same PBS color-bars source packaged with the full codec ladder — AV1, VP9, HEVC, and AVC renditions across 234p / 432p / 720p / 1080p / 1440p / 2160p, each with a matching I-frame playlist, plus AAC audio and the top-positioned WebVTT caption track.

Playlist: https://pbs.github.io/test-streams/streams/pbs/test-pattern/pbs-bars_av1-vp9-hevc-avc.m3u8
