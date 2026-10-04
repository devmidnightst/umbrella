// account sync for proxied site data: cookies, localStorage and indexeddb.
//
// the client splits everything into units (cookies per domain, localStorage per
// host, one unit per indexeddb database), gzips each one and uploads it here.
// this is people's logins on other sites, so every unit is encrypted at rest
// with aes-256-gcm, bound to its owner and name, and each account is capped.
// the server never unzips a unit, it only stores the bytes and counts them.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { db } from "./db.js";
import { requireAuth } from "./auth.js";

export const CAP_BYTES = 512 * 1024 * 1024;
export const UNIT_MAX_BYTES = 48 * 1024 * 1024;

const KINDS = new Set(["c", "l", "i"]);
const HASH_RE = /^[a-f0-9]{64}$/;
const NAME_MAX = 512;

db.exec(`
  CREATE TABLE IF NOT EXISTS site_data (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, name)
  );
`);

const stmts = {
	list: db.prepare("SELECT kind, name, hash, size, updated_at FROM site_data WHERE user_id = ? ORDER BY kind, name"),
	used: db.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM site_data WHERE user_id = ?"),
	get: db.prepare("SELECT data, hash FROM site_data WHERE user_id = ? AND kind = ? AND name = ?"),
	size: db.prepare("SELECT size FROM site_data WHERE user_id = ? AND kind = ? AND name = ?"),
	put: db.prepare(`
    INSERT INTO site_data (user_id, kind, name, hash, size, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, kind, name) DO UPDATE SET
      hash = excluded.hash, size = excluded.size, data = excluded.data, updated_at = excluded.updated_at
  `),
	del: db.prepare("DELETE FROM site_data WHERE user_id = ? AND kind = ? AND name = ?"),
	wipe: db.prepare("DELETE FROM site_data WHERE user_id = ?"),
};

// key from UMBRELLA_DATA_KEY (64 hex chars), otherwise one generated next to the
// database on first boot. every pm2 worker races to create it, so the first
// writer wins and the rest read what it wrote.
function loadKey() {
	const env = (process.env.UMBRELLA_DATA_KEY || "").trim();
	if (env) {
		if (!/^[a-f0-9]{64}$/i.test(env)) throw new Error("UMBRELLA_DATA_KEY must be 64 hex characters (openssl rand -hex 32)");
		return Buffer.from(env, "hex");
	}
	const file = path.join(path.dirname(db.name), "site-data.key");
	try {
		fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
	}
	for (let i = 0; i < 20; i++) {
		const hex = fs.readFileSync(file, "utf8").trim();
		if (/^[a-f0-9]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
	}
	throw new Error(`${file} is not a valid key, delete it only if no account has synced data yet`);
}

let key = null;
const getKey = () => (key ??= loadKey());
export const checkKey = () => void getKey();

function aad(userId, kind, name) {
	return Buffer.from(`${userId}\n${kind}\n${name}`);
}

function seal(userId, kind, name, plain) {
	const iv = crypto.randomBytes(12);
	const c = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
	c.setAAD(aad(userId, kind, name));
	const body = Buffer.concat([c.update(plain), c.final()]);
	return Buffer.concat([iv, c.getAuthTag(), body]);
}

function open(userId, kind, name, sealed) {
	const d = crypto.createDecipheriv("aes-256-gcm", getKey(), sealed.subarray(0, 12));
	d.setAAD(aad(userId, kind, name));
	d.setAuthTag(sealed.subarray(12, 28));
	return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

const putUnit = db.transaction((userId, kind, name, hash, bytes) => {
	const prev = stmts.size.get(userId, kind, name)?.size ?? 0;
	const used = stmts.used.get(userId).used - prev;
	if (used + bytes.length > CAP_BYTES) return { ok: false, used };
	stmts.put.run(userId, kind, name, hash, bytes.length, seal(userId, kind, name, bytes), Math.floor(Date.now() / 1000));
	return { ok: true, used: used + bytes.length };
});

// per user, per worker. a full sync of a busy profile is a few dozen requests
const WINDOW = 5 * 60_000;
const LIMIT = 600;
const hits = new Map();
function rateLimit(req, res, next) {
	const now = Date.now();
	const recent = (hits.get(req.user.id) ?? []).filter((t) => now - t < WINDOW);
	recent.push(now);
	hits.set(req.user.id, recent);
	if (hits.size > 5000) hits.delete(hits.keys().next().value);
	if (recent.length > LIMIT) return res.status(429).json({ error: "syncing too often, try again in a few minutes" });
	next();
}

function unitParams(req, res) {
	const kind = String(req.query.kind ?? "");
	const name = String(req.query.name ?? "");
	if (!KINDS.has(kind) || !name || name.length > NAME_MAX) {
		res.status(400).json({ error: "bad unit" });
		return null;
	}
	return { kind, name };
}

export function createSiteDataRouter() {
	const router = Router();
	router.use(requireAuth, rateLimit, (req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		next();
	});

	router.get("/", (req, res) => {
		const units = stmts.list.all(req.user.id);
		const used = units.reduce((n, u) => n + u.size, 0);
		res.json({ cap: CAP_BYTES, unitMax: UNIT_MAX_BYTES, used, units });
	});

	router.get("/unit", (req, res) => {
		const p = unitParams(req, res);
		if (!p) return;
		const row = stmts.get.get(req.user.id, p.kind, p.name);
		if (!row) return res.status(404).json({ error: "not found" });
		let plain;
		try {
			plain = open(req.user.id, p.kind, p.name, row.data);
		} catch {
			return res.status(500).json({ error: "stored data can't be decrypted (was the data key changed?)" });
		}
		res.setHeader("Content-Type", "application/octet-stream");
		res.setHeader("X-Unit-Hash", row.hash);
		res.end(plain);
	});

	router.put(
		"/unit",
		express.raw({ type: "application/octet-stream", limit: UNIT_MAX_BYTES }),
		(req, res) => {
			const p = unitParams(req, res);
			if (!p) return;
			const hash = String(req.query.hash ?? "");
			if (!HASH_RE.test(hash)) return res.status(400).json({ error: "bad hash" });
			if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "empty unit" });
			// gzip magic, so a stray json body can't land in the store
			if (req.body[0] !== 0x1f || req.body[1] !== 0x8b) return res.status(400).json({ error: "unit must be gzip" });
			const r = putUnit(req.user.id, p.kind, p.name, hash, req.body);
			if (!r.ok) return res.status(413).json({ error: "account storage is full", used: r.used, cap: CAP_BYTES });
			res.json({ ok: true, used: r.used, cap: CAP_BYTES });
		}
	);

	router.delete("/unit", (req, res) => {
		const p = unitParams(req, res);
		if (!p) return;
		stmts.del.run(req.user.id, p.kind, p.name);
		res.json({ ok: true, used: stmts.used.get(req.user.id).used });
	});

	router.delete("/", (req, res) => {
		stmts.wipe.run(req.user.id);
		res.json({ ok: true, used: 0 });
	});

	// eslint-disable-next-line no-unused-vars
	router.use((err, req, res, next) => {
		if (err.type === "entity.too.large") return res.status(413).json({ error: "this site's data is too big to sync" });
		next(err);
	});

	return router;
}
