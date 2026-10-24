# Seller video upload test: sometimes "That file isn't a video."

Cause: the test file was 8 MB of the same filler byte. That is not a video. The server's worker looks at every upload and
rejects non-videos. The page first shows "Processing", then a moment later "That file isn't a video."
The test only passed when it looked at the page during that short "Processing" moment. When the worker was fast
(or the test was slow), it saw only the error and waited 60 s for nothing. So it was a test-data problem, not an
upload bug (the retried part and the part list were fine).

Fix: tests/seller-video.spec.ts now builds a real small clip with ffmpeg and pads it (an MP4 "free" box) to just over
one part (8 MB + 4 KB), so there are still two parts and the failed-part retry is still tested. No check was weakened.
Needs ffmpeg on the machine that runs the test (it is installed in the dev stack).
