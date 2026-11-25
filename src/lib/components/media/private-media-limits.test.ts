import { expect, test } from "bun:test";
import { encodedLimit } from "#lib/server/services/gallery/download.ts";
import { maxStageBytes } from "#lib/server/services/media-staging/stages.ts";
import { videoByteLimit } from "#lib/server/services/video-media/limits.ts";
import { mediaLimits } from "./private-media";

// The browser refuses a private file over its kind's limit, so each limit must equal the size the
// server accepts for that kind; otherwise a saved file the server kept could no longer be shown.
test("the browser's media limits match the server's", () => {
	expect(mediaLimits).toEqual({
		video: videoByteLimit,
		image: encodedLimit,
		staged: maxStageBytes,
	});
});
