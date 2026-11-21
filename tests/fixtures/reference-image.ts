export const referencePng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12OwzpoHAAInAUTeUHLOAAAAAElFTkSuQmCC",
	"base64",
);

export const referenceGif = Buffer.from(
	"R0lGODlhAQABAPAAADtqngAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAgLQyWgAAAAICRAEAOw==",
	"base64",
);

// The first frame is complete. The second frame ends inside its image data.
export const truncatedReferenceGif = referenceGif.subarray(0, -3);
