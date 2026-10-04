// `npm run check`: sanity check the install before deploying.
// verifies the pinned versions line up and every scramjet patch still applies.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
	buildPatchedScramjet,
	buildPatchedControllerInject,
	buildPatchedUtils,
	SCRAMJET_VERSION,
} from "./scramjet-patches.js";
import { buildPatchedLibcurl } from "./libcurl-patches.js";
import { packageDir, packageVersion as version } from "./packages.js";

let failed = false;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
	failed = true;
	console.log(`  FAIL  ${msg}`);
};

console.log("umbrella install check\n");

const nodeMajor = Number(process.versions.node.split(".")[0]);
nodeMajor >= 22 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} is too old, umbrella needs node 22 or newer`);

// native modules built for another node version crash every worker on boot,
// so load them here where the error is readable
const require = createRequire(import.meta.url);
try {
	const Database = require("better-sqlite3");
	new Database(":memory:").close();
	ok("better-sqlite3 loads");
} catch (err) {
	bad(`better-sqlite3 does not load (${err.message.split("\n")[0]}), run npm ci again`);
}
try {
	const { db } = await import("./db.js");
	db.prepare("CREATE TABLE IF NOT EXISTS _check (x)").run();
	db.prepare("DROP TABLE _check").run();
	ok(`database ${db.name} is writable`);
} catch (err) {
	bad(`database can't be opened for writing (${err.message}). check who owns the data folder, it must be the user pm2 runs as`);
}
try {
	const { CAP_BYTES, checkKey } = await import("./site-data.js");
	checkKey();
	ok(`site data sync key loads (cap ${CAP_BYTES / 1024 / 1024} MB per account)`);
} catch (err) {
	bad(`site data sync key: ${err.message}`);
}
try {
	require("bcrypt").hashSync("x", 4);
	ok("bcrypt loads");
} catch (err) {
	bad(`bcrypt does not load (${err.message.split("\n")[0]}), run npm ci again`);
}

const sj = version("@mercuryworkshop/scramjet");
sj === SCRAMJET_VERSION ? ok(`scramjet ${sj}`) : bad(`scramjet is ${sj}, patches target ${SCRAMJET_VERSION}`);

// the controller build hard codes the scramjet version it accepts and throws at runtime otherwise
const controllerApi = fs.readFileSync(
	path.join(packageDir("@mercuryworkshop/scramjet-controller"), "dist/controller.api.js"),
	"utf8"
);
const expected = controllerApi.match(/var e="([^"]+)",t=\$scramjet\.versionInfo\.version/)?.[1];
expected === sj
	? ok(`controller ${version("@mercuryworkshop/scramjet-controller")} expects scramjet ${expected}`)
	: bad(`controller expects scramjet ${expected}, installed ${sj}`);

// scramjet-utils 0.0.3 was built against older versions. its plugins work, but
// its getScramjet()/getVersionInfo() helpers throw a version mismatch, so the ui never calls them.
const utils = fs.readFileSync(
	path.join(packageDir("@mercuryworkshop/scramjet-utils"), "dist/scramjet-utils.js"),
	"utf8"
);
const utilsWants = utils.match(/a\("@mercuryworkshop\/scramjet","([^"]+)"/)?.[1];
console.log(`  note  scramjet-utils ${version("@mercuryworkshop/scramjet-utils")} was built against scramjet ${utilsWants} (only its plugins are used)`);

for (const name of ["epoxy-transport", "libcurl-transport", "wisp-js", "proxy-transports"]) {
	ok(`${name} ${version(`@mercuryworkshop/${name}`)}`);
}

for (const [name, build] of [
	["scramjet.js", buildPatchedScramjet],
	["controller.inject.js", buildPatchedControllerInject],
	["scramjet-utils.js", buildPatchedUtils],
	["libcurl.mjs", buildPatchedLibcurl],
]) {
	const { applied, skipped } = build();
	for (const id of applied) ok(`patch ${name}: ${id}`);
	for (const s of skipped) bad(`patch ${name}: ${s.id}: ${s.reason}`);
}

console.log(failed ? "\nsomething is off, see above" : "\nall good");
process.exit(failed ? 1 : 0);
