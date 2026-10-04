// account site data sync, end to end.
//
//   npm run test:sync
//
// one browser logs in, visits a fixture page that sets a cookie, localStorage
// and an indexeddb save, then syncs. a second, empty browser logs in to the same
// account and the fixture page has to find all of it. then logging out has to
// clear it from the second browser, and "clear data" has to empty the account.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umbrella-sync-e2e-"));
process.env.DB_PATH = path.join(dir, "e2e.db");
process.env.NODE_ENV = "development";
process.env.WISP_ALLOW_LOOPBACK_IPS = "1";
process.env.WISP_LOG_LEVEL = "NONE";

const { chromium } = await import("playwright-core");
const { createServer } = await import("../src/server.js");
const { startFixture } = await import("../test/fixture/server.js");

const fixture = await startFixture(0);
const page1 = `http://127.0.0.1:${fixture.address().port}/storage.html`;
const umbrella = createServer();
await new Promise((r) => umbrella.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${umbrella.address().port}`;

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH || (fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined),
	args: ["--no-sandbox"],
});

let failures = 0;
const pass = (m) => console.log(`  \x1b[32mpass\x1b[0m ${m}`);
const fail = (m) => {
	failures++;
	console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
};

async function newShell() {
	const context = await browser.newContext();
	await context.addInitScript((wisp) => {
		if (!localStorage.getItem("_p8q2:settings"))
			localStorage.setItem("_p8q2:settings", JSON.stringify({ _m: "lc", _srvUrl: wisp }));
	}, base.replace("http", "ws") + "/wisp/");
	const page = await context.newPage();
	page.on("pageerror", (e) => console.log("  pageerror", e.message));
	page.on("dialog", (d) => d.accept());
	return { context, page };
}

const proxyFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame() && f.url().includes("/~/xf/"));

async function visit(page, url, title) {
	await page.goto(`${base}/?go=${encodeURIComponent(url)}`);
	await page.waitForFunction((t) => {
		for (const f of document.querySelectorAll("iframe")) {
			try {
				if (f.contentDocument?.title?.startsWith(t) || f.contentDocument?.title?.startsWith("error")) return true;
			} catch {
			}
		}
		return false;
	}, title, { timeout: 30000 });
	const frame = proxyFrame(page);
	return { frame, title: await frame.title() };
}

async function syncNow(page) {
	await page.evaluate(() => document.querySelector('[data-tab="account"]').click());
	await page.waitForSelector("#sync-info button:not([disabled])", { state: "attached", timeout: 30000 });
	await page.evaluate(() => document.querySelector("#sync-info button").click());
	await page.waitForFunction(() => {
		const b = document.querySelector("#sync-info button");
		return b && !b.disabled && /last synced|failed/.test(document.getElementById("sync-info").textContent);
	}, null, { timeout: 60000 });
	return page.evaluate(() => document.getElementById("sync-info").textContent);
}

async function signupOrLogin(context, path, data) {
	const res = await context.request.post(`${base}/api/auth/${path}`, { data });
	if (!res.ok()) throw new Error(`${path} failed: ${res.status()} ${await res.text()}`);
}

const creds = { username: "sync_e2e", email: "sync_e2e@example.com", password: "hunter2hunter2" };

try {
	console.log("\naccount site data sync");
	const a = await newShell();
	await signupOrLogin(a.context, "signup", creds);
	const set = await visit(a.page, page1 + "?set=1", "set");
	set.title === "set" ? pass("fixture stored a cookie, localStorage and an indexeddb save") : fail(`fixture set: ${set.title}`);
	const infoA = await syncNow(a.page);
	/last synced/.test(infoA) ? pass(`browser a synced (${infoA.match(/[\d.]+ [KM]B of/)?.[0]} 512 MB)`) : fail(`browser a sync: ${infoA}`);

	const listed = await (await a.context.request.get(`${base}/api/sitedata/`)).json();
	const kinds = listed.units.map((u) => `${u.kind}:${u.name}`);
	const host = new URL(page1).host;
	const want = [`c:127.0.0.1`, `l:${host}`, `i:${new URL(page1).origin}@gamesave`];
	want.every((w) => kinds.includes(w)) ? pass(`account holds ${want.join(", ")}`) : fail(`account units: ${kinds.join(", ")}`);

	const b = await newShell();
	await signupOrLogin(b.context, "login", { username: creds.username, password: creds.password });
	await b.page.goto(base + "/");
	await b.page.waitForFunction(() => {
		try {
			return JSON.parse(localStorage.getItem("_p8q2:sync") || "{}").m && Object.keys(JSON.parse(localStorage.getItem("_p8q2:sync")).m).length >= 3;
		} catch {
			return false;
		}
	}, null, { timeout: 60000 });
	pass("browser b pulled the account's site data on boot");
	const read = await visit(b.page, page1, "read");
	const got = JSON.parse(await read.frame.textContent("#out"));
	const expect = { cookie: "login=abc123", local: "level7", version: 3, level: 7, when: 1000, bytes: [1, 2, 3], file: "hello", tags: ["a"], coins: "42", byLevel: 1 };
	for (const [k, v] of Object.entries(expect)) {
		JSON.stringify(got[k]) === JSON.stringify(v) ? pass(`browser b sees ${k} = ${JSON.stringify(v)}`) : fail(`browser b ${k}: ${JSON.stringify(got[k])}, wanted ${JSON.stringify(v)}`);
	}

	await b.page.evaluate(() => document.querySelector('[data-tab="account"]').click());
	await b.page.evaluate(() => document.querySelector("#account-actions .danger").click());
	await b.page.waitForURL(base + "/", { timeout: 60000 });
	await b.page.waitForTimeout(1500);
	const after = await b.page.evaluate(async () => ({
		local: Object.keys(localStorage).filter((k) => /@/.test(k) && !k.startsWith("_p8q2:")),
		dbs: (await indexedDB.databases()).map((d) => d.name).filter((n) => n.includes("@")),
	}));
	!after.local.length && !after.dbs.length ? pass("logging out cleared the site data from browser b") : fail(`left after logout: ${JSON.stringify(after)}`);
	const me = await (await b.context.request.get(`${base}/api/auth/me`)).json();
	me.user === null ? pass("browser b is logged out") : fail("browser b still logged in");

	await a.page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
	await a.page.evaluate(() => document.getElementById("clear-data").click());
	await a.page.waitForTimeout(2000);
	const emptied = await (await a.context.request.get(`${base}/api/sitedata/`)).json();
	!emptied.units.length ? pass("clear data also emptied the account copy") : fail(`account still has ${emptied.units.length} units`);
} catch (err) {
	fail(err.stack || err.message);
} finally {
	await browser.close();
	umbrella.close();
	fixture.close();
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
