import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umbrella-chats-"));
process.env.DB_PATH = path.join(dir, "test.db");

const { stmts } = await import("../src/db.js");
const { authMiddleware } = await import("../src/auth.js");
const { createChatRouter, CHAT_LIMITS } = await import("../src/ai-chats.js");

let server;
let base;
const cookie = "umbrella_session=test-token-1";

before(async () => {
	const { lastInsertRowid } = stmts.createUser.run("chatter", "chatter@example.com", "x");
	stmts.createSession.run("test-token-1", lastInsertRowid, Math.floor(Date.now() / 1000) + 3600);
	const app = express();
	app.use(cookieParser());
	app.use(authMiddleware);
	app.use("/api/ai/chats", createChatRouter());
	server = app.listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	base = `http://127.0.0.1:${server.address().port}/api/ai/chats`;
});

after(() => {
	server?.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

const put = (id, body, headers = {}) =>
	fetch(`${base}/${id}`, { method: "PUT", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("chats need an account", async () => {
	const r = await fetch(base);
	assert.equal(r.status, 401);
});

test("a saved chat comes back, and can be updated and deleted", async () => {
	let r = await fetch(base, { headers: { cookie } });
	assert.deepEqual((await r.json()).chats, []);
	r = await put("abc123", { title: "hello", updated: 5, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo", steps: [{ type: "run", code: "1+1", output: "=> 2" }] }, { role: "system", content: "dropped" }] });
	assert.equal(r.status, 200);
	r = await put("abc123", { title: "hello again", updated: 6, messages: [{ role: "user", content: "hi" }] });
	assert.equal(r.status, 200);
	r = await fetch(base, { headers: { cookie } });
	const { chats, usage } = await r.json();
	assert.equal(chats.length, 1);
	assert.equal(chats[0].title, "hello again");
	assert.equal(chats[0].messages.length, 1);
	assert.equal(usage.chats, 1);
	r = await fetch(`${base}/abc123`, { method: "DELETE", headers: { cookie } });
	assert.equal(r.status, 200);
	r = await fetch(base, { headers: { cookie } });
	assert.equal((await r.json()).chats.length, 0);
});

test("assistant steps and thinking are kept", async () => {
	await put("keep01", { title: "t", updated: 1, messages: [{ role: "assistant", content: "a", thinking: "hmm", steps: [{ type: "search", query: "q", results: [] }] }] });
	const { chats } = await (await fetch(base, { headers: { cookie } })).json();
	assert.equal(chats[0].messages[0].thinking, "hmm");
	assert.equal(chats[0].messages[0].steps[0].query, "q");
	await fetch(base, { method: "DELETE", headers: { cookie } });
});

test("bad ids and cross site writes are refused", async () => {
	assert.equal((await put("../x", { messages: [] })).status, 404);
	assert.equal((await put("no!", { messages: [] })).status, 400);
	assert.equal((await put("evil01", { messages: [] }, { origin: "https://evil.example" })).status, 403);
	const host = new URL(base).host;
	assert.equal((await put("good01", { messages: [] }, { origin: `http://${host}` })).status, 200);
	const del = await fetch(base, { method: "DELETE", headers: { cookie, origin: "https://evil.example" } });
	assert.equal(del.status, 403);
	await fetch(base, { method: "DELETE", headers: { cookie } });
});

test("storage limits answer 507 and 413", async () => {
	const saved = { ...CHAT_LIMITS };
	try {
		CHAT_LIMITS.maxChats = 2;
		assert.equal((await put("lim001", { messages: [] })).status, 200);
		assert.equal((await put("lim002", { messages: [] })).status, 200);
		assert.equal((await put("lim003", { messages: [] })).status, 507);
		assert.equal((await put("lim001", { title: "edit is fine", messages: [] })).status, 200);
		CHAT_LIMITS.maxChats = 100;
		CHAT_LIMITS.maxTotalBytes = 400;
		assert.equal((await put("lim004", { messages: [{ role: "user", content: "x".repeat(500) }] })).status, 507);
		CHAT_LIMITS.maxChatBytes = 100;
		assert.equal((await put("lim005", { messages: [{ role: "user", content: "x".repeat(200) }] })).status, 413);
	} finally {
		Object.assign(CHAT_LIMITS, saved);
		await fetch(base, { method: "DELETE", headers: { cookie } });
	}
});
