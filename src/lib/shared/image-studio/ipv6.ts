// IANA Global Unicast Address Space. Adjacent allocated blocks are merged into
// inclusive ranges of the first 32 bits. Special-purpose entries are handled below.
// https://www.iana.org/assignments/ipv6-unicast-address-assignments
const allocatedRanges = [
	[0x2001_0200, 0x2001_0fff],
	[0x2001_1200, 0x2001_4dff],
	[0x2001_5000, 0x2001_5fff],
	[0x2001_8000, 0x2001_bfff],
	[0x2003_0000, 0x2003_3fff],
	[0x2400_0000, 0x241f_ffff],
	[0x2600_0000, 0x2610_01ff],
	[0x2620_0000, 0x2620_01ff],
	[0x2630_0000, 0x263f_ffff],
	[0x2800_0000, 0x280f_ffff],
	[0x2a00_0000, 0x2a1f_ffff],
	[0x2c00_0000, 0x2c0f_ffff],
] as const;

const ietfAnycast = new Set(["[2001:1::1]", "[2001:1::2]", "[2001:1::3]"]);

export function isPublicIpv6(hostname: string): boolean {
	// URL.hostname has validated and canonicalized this IPv6 literal.
	const hextets = hostname.slice(1, -1).split(":", 3);
	const [first, second, third] = hextets.map((hextet) => Number.parseInt(hextet, 16) || 0);
	const prefix = first * 0x10000 + second;

	// Only the explicitly globally reachable assignments in the IETF /23 qualify.
	// https://www.iana.org/assignments/iana-ipv6-special-registry
	if (prefix >= 0x2001_0000 && prefix < 0x2001_0200) {
		return (
			ietfAnycast.has(hostname) ||
			second === 3 ||
			(second === 4 && third === 0x112) ||
			(second >= 0x20 && second <= 0x3f)
		);
	}
	if (prefix === 0x2001_0db8) return false;
	return allocatedRanges.some(([start, end]) => prefix >= start && prefix <= end);
}
