import { readFile } from "node:fs/promises";

export type LocalAccounts = { group: string; passwd: string };
export type ReadLocalAccounts = () => Promise<LocalAccounts>;

/** The local account files. Directory services (sss, LDAP) are not consulted. */
export async function readLocalAccounts(): Promise<LocalAccounts> {
	const [group, passwd] = await Promise.all([
		readFile("/etc/group", "utf8"),
		readFile("/etc/passwd", "utf8"),
	]);
	return { group, passwd };
}

// Null when any entry is malformed, including NIS `+` lines, so the caller fails closed.
function entries(text: string, fields: number, ids: number[]) {
	const rows: string[][] = [];
	for (const line of text.split("\n")) {
		if (line === "" || line.startsWith("#")) continue;
		const row = line.split(":");
		if (row.length !== fields || ids.some((at) => !/^\d+$/.test(row[at]))) return null;
		rows.push(row);
	}
	return rows;
}

/**
 * Whether `user.gid` is that user's private group: exactly one group entry with
 * that ID, named for the user, holding no other member, and no other account's
 * primary group.
 */
export function isUserPrivateGroup(
	accounts: LocalAccounts,
	user: { name: string; uid: number; gid: number },
) {
	const groups = entries(accounts.group, 4, [2]);
	const users = entries(accounts.passwd, 7, [2, 3]);
	if (!groups || !users) return false;
	const matching = groups.filter((row) => Number(row[2]) === user.gid);
	if (matching.length !== 1) return false;
	const [name, , , members] = matching[0];
	if (name !== user.name || members.split(",").some((member) => member && member !== user.name))
		return false;
	return users.every(
		(row) => Number(row[3]) !== user.gid || (row[0] === user.name && Number(row[2]) === user.uid),
	);
}
