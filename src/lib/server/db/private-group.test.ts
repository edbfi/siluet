import { expect, test } from "bun:test";
import { isUserPrivateGroup } from "./private-group";

const user = { name: "ada", uid: 1000, gid: 1000 };
const passwd = "root:x:0:0:root:/root:/bin/sh\nada:x:1000:1000:Ada:/home/ada:/bin/sh\n";
const group = "root:x:0:\nusers:x:100:ada,bob\nada:x:1000:\n";

test("a group named for the user, holding only that user, is private", () => {
	expect(isUserPrivateGroup({ group, passwd }, user)).toBe(true);
	expect(
		isUserPrivateGroup({ group: group.replace("ada:x:1000:", "ada:x:1000:ada"), passwd }, user),
	).toBe(true);
});

test("a group another account can use is shared", () => {
	for (const accounts of [
		{ group: group.replace("ada:x:1000:", "ada:x:1000:ada,bob"), passwd },
		{ group: group.replace("ada:x:1000:", "staff:x:1000:"), passwd },
		{ group: `${group}twin:x:1000:\n`, passwd },
		{ group, passwd: `${passwd}bob:x:1001:1000::/home/bob:/bin/sh\n` },
		{ group, passwd: `${passwd}ada:x:1001:1000::/home/ada:/bin/sh\n` },
	])
		expect(isUserPrivateGroup(accounts, user)).toBe(false);
});

test("an unknown group or unreadable account files fail closed", () => {
	for (const accounts of [
		{ group: "root:x:0:\n", passwd },
		{ group: "", passwd },
		{ group: `${group}+:::\n`, passwd },
		{ group: `${group}broken:x\n`, passwd },
		{ group, passwd: `${passwd}+::::::\n` },
		{ group, passwd: `${passwd}short:x:1\n` },
	])
		expect(isUserPrivateGroup(accounts, user)).toBe(false);
});

test("the user's own account must confirm the group", () => {
	for (const users of [
		"root:x:0:0:root:/root:/bin/sh\n",
		"root:x:0:0:root:/root:/bin/sh\nada:x:1000:100:Ada:/home/ada:/bin/sh\n",
		"root:x:0:0:root:/root:/bin/sh\nada:x:1002:100:Ada:/home/ada:/bin/sh\n",
	])
		expect(isUserPrivateGroup({ group, passwd: users }, user)).toBe(false);
});
