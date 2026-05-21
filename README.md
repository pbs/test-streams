# test-streams

A collection of HLS test streams.

## Streams

### Mux — Big Buck Bunny (with I-frame playlists added)

A multivariant HLS playlist of *Big Buck Bunny* sourced from Mux's `test-streams.mux.dev`, with `EXT-X-I-FRAME-STREAM-INF` entries for trick-play (scrubbing/seek thumbnails).

Only the patched manifests are hosted here; all media segments (`.ts`) are still served by Mux via absolute URLs.

Playlist: https://pbs.github.io/test-streams/test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
