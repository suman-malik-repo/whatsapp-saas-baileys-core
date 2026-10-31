# Media validation fixtures

These tiny, generated files exercise the actual image decoders and media parsers.
They contain solid colors or silence and do not contain personal media.

The PNG, JPEG, and static WebP files were generated locally with Sharp from an
8 by 8 pixel solid-color image. The audio files contain 0.15 seconds of silence
at 48 kHz. The MP4 contains a 16 by 16 pixel color video, and the animated WebP
contains two 16 by 16 pixel frames. FFmpeg generated the audio/video fixtures.

Tests mutate copies in owned temporary directories to check truncation and
corruption. These files do not require FFmpeg at test or server runtime.
