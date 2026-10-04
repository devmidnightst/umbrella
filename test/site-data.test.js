import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umbrella-sitedata-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.WISP_LOG_LEVEL = "NONE";
delete process.env.UMBRELLA_DATA_KEY;
const { createServer } = await import("../src/server.js");
const { CAP_BYTES } = await import("../src/site-data.js");
const { db } = await import("../src/db.js");

let server;
let base;
before(async () => {
	server = createServer();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

async function signup(name) {
	const res = await fetch(base + "/api/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: name, email: `${name}@example.com`, password: "hunter2hunter2" }),
	});
	assert.equal(res.status, 200);
	const cookie = res.headers.get("set-cookie").split(";")[0];
	return (p, init = {}) => fetch(base + "/api/sitedata" + p, { ...init, headers: { cookie, ...init.headers } });
}

const hash = (c) => c.repeat(64);
const gz = (s) => zlib.gzipSync(Buffer.from(s));
const put = (api, kind, name, h, body) =>
	api(`/unit?kind=${kind}&name=${encodeURIComponent(name)}&hash=${h}`, {
		method: "PUT",
		headers: { "Content-Type": "application/octet-stream" },
		body,
	});

test("site data needs a login", async () => {
	const res = await fetch(base + "/api/sitedata/");
	assert.equal(res.status, 401);
});

test("units round trip, are encrypted at rest and stay per account", async () => {
	const a = await signup("syncer_a");
	const b = await signup("syncer_b");
	const body = gz('[["sid","secret-login-token"]]');

	let res = await put(a, "l", "example.com", hash("a"), body);
	assert.equal(res.status, 200);
	assert.equal((await res.json()).used, body.length);

	const list = await (await a("/")).json();
	assert.equal(list.cap, CAP_BYTES);
	assert.equal(list.used, body.length);
	assert.deepEqual(list.units.map((u) => [u.kind, u.name, u.hash]), [["l", "example.com", hash("a")]]);

	res = await a("/unit?kind=l&name=example.com");
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.deepEqual(Buffer.from(await res.arrayBuffer()), body);

	const raw = db.prepare("SELECT data FROM site_data WHERE name = 'example.com'").get().data;
	assert.ok(!raw.includes(body), "stored bytes must not be the plain upload");

	assert.equal((await b("/unit?kind=l&name=example.com")).status, 404);
	assert.equal((await (await b("/")).json()).units.length, 0);

	res = await a("/unit?kind=l&name=example.com", { method: "DELETE" });
	assert.equal((await res.json()).used, 0);
	assert.equal((await a("/unit?kind=l&name=example.com")).status, 404);
});

test("bad units are refused", async () => {
	const a = await signup("syncer_c");
	assert.equal((await put(a, "x", "example.com", hash("a"), gz("1"))).status, 400);
	assert.equal((await put(a, "l", "example.com", "nothex", gz("1"))).status, 400);
	assert.equal((await put(a, "l", "example.com", hash("a"), Buffer.from("{}"))).status, 400);
	assert.equal((await put(a, "l", "x".repeat(600), hash("a"), gz("1"))).status, 400);
});

test("the 512 MB cap counts every unit and replacing a unit frees its old size", async () => {
	const a = await signup("syncer_d");
	const uid = db.prepare("SELECT id FROM users WHERE username = 'syncer_d'").get().id;
	db.prepare("INSERT INTO site_data (user_id, kind, name, hash, size, data, updated_at) VALUES (?, 'i', 'https://big@db', ?, ?, x'00', 0)")
		.run(uid, hash("b"), CAP_BYTES - 100);

	const small = gz("ok");
	assert.ok(small.length < 100);
	let res = await put(a, "c", "example.com", hash("c"), small);
	assert.equal(res.status, 200);

	res = await put(a, "c", "other.com", hash("d"), gz(crypto.randomBytes(300).toString("base64")));
	assert.equal(res.status, 413);
	assert.equal((await res.json()).cap, CAP_BYTES);

	res = await put(a, "c", "example.com", hash("e"), gz("ok2"));
	assert.equal(res.status, 200);

	res = await a("/", { method: "DELETE" });
	assert.equal((await res.json()).used, 0);
	assert.equal((await (await a("/")).json()).units.length, 0);
});

test("one unit can't go over the per unit limit", async () => {
	const a = await signup("syncer_e");
	const { UNIT_MAX_BYTES } = await import("../src/site-data.js");
	const big = Buffer.alloc(UNIT_MAX_BYTES + 10);
	big[0] = 0x1f;
	big[1] = 0x8b;
	const res = await put(a, "i", "https://site@db", hash("f"), big);
	assert.equal(res.status, 413);
});
