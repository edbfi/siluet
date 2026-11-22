import { SaxesParser } from "saxes";
import { PngCleanupError } from "./png-errors";

const tiffNamespace = "http://ns.adobe.com/tiff/1.0/";
const gainMapNamespace = "http://ns.adobe.com/hdr-gain-map/1.0/";
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";

// Resolve expanded XML names for compact attributes and simple property elements.
// https://developer.adobe.com/xmp/docs/xmp-namespaces/tiff/
// https://developer.android.com/media/platform/hdr-image-format
export function checkPngXmp(packet: string) {
	const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0", forceXMLVersion: true });
	let foundOrientation = false;
	let orientationValue: string | undefined;
	let depth = 0;
	let attributes = 0;

	function addOrientation(value: string) {
		if (foundOrientation || !/^[ \t\r\n]*\+?0*1[ \t\r\n]*$/.test(value)) {
			throw new PngCleanupError("png-orientation");
		}
		foundOrientation = true;
	}

	const invalid = () => {
		throw new PngCleanupError("invalid-png");
	};
	parser.on("error", invalid);
	parser.on("doctype", invalid);
	parser.on("xmldecl", ({ encoding }) => {
		if (encoding !== undefined && encoding.toLowerCase() !== "utf-8") invalid();
	});
	parser.on("opentagstart", () => {
		if (++depth > 64) throw new PngCleanupError("png-limit");
		if (orientationValue !== undefined) throw new PngCleanupError("png-orientation");
		attributes = 0;
	});
	parser.on("attribute", () => {
		if (++attributes > 256) throw new PngCleanupError("png-limit");
	});
	parser.on("opentag", ({ uri, local, attributes }) => {
		const properties = Object.values(attributes);
		if (
			uri === gainMapNamespace ||
			properties.some((property) => property.uri === gainMapNamespace)
		) {
			throw new PngCleanupError("hdr-png");
		}
		for (const property of properties) {
			if (property.uri === tiffNamespace && property.local === "Orientation") {
				addOrientation(property.value);
			}
		}
		if (uri === tiffNamespace && local === "Orientation") {
			if (properties.some((property) => property.uri !== xmlnsNamespace)) {
				throw new PngCleanupError("png-orientation");
			}
			orientationValue = "";
		}
	});
	function appendOrientation(text: string) {
		if (orientationValue !== undefined) orientationValue += text;
	}
	parser.on("text", appendOrientation);
	parser.on("cdata", appendOrientation);
	parser.on("closetag", () => {
		depth--;
		if (orientationValue !== undefined) {
			addOrientation(orientationValue);
			orientationValue = undefined;
		}
	});

	parser.write(packet).close();
	return foundOrientation;
}
