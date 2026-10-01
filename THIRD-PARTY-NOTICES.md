# Third-party notices

AriaDM is MIT licensed, but the Windows installer redistributes three external
programs. Each is an unmodified official build, obtained from its own upstream
release, and remains under its own license. Versions are pinned in
[`scripts/aria2-manifest.json`](scripts/aria2-manifest.json).

| Program | Version shipped | License | Upstream |
| --- | --- | --- | --- |
| aria2 (`aria2c.exe`) | 1.37.0 | GNU GPL v2 or later | <https://github.com/aria2/aria2> |
| yt-dlp (`yt-dlp.exe`) | 2026.08.19 | The Unlicense (public domain) | <https://github.com/yt-dlp/yt-dlp> |
| FFmpeg (`ffmpeg.exe`, `ffprobe.exe`) | N-127021-ge0c94b2d1c (2026-09-30) | GNU GPL v3 (BtbN `win64-gpl` static build) | <https://github.com/BtbN/FFmpeg-Builds>, <https://ffmpeg.org> |

## Notes

- The FFmpeg binaries come from the BtbN *gpl* build, which enables GPL-only
  components (libx264, libx265 and others). FFmpeg's GPL build is distributed
  under the GNU General Public License v3. The corresponding source is published
  by FFmpeg and by BtbN at the links above.
- aria2 and FFmpeg are separate programs invoked as child processes; AriaDM does
  not link against them, which is what keeps AriaDM itself MIT licensed.
- No third-party binary is modified. Digests are verified at fetch time, and
  again at runtime for aria2 and yt-dlp, so a tampered copy is detected.
- On platforms where these programs are not bundled (for example Linux), AriaDM
  uses a system installation instead, and the user's distribution's packaging and
  licensing terms apply.
