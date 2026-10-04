import express from "express";
import { db } from "./db.js";
import { requireAuth } from "./auth.js";

// ai tab chats for signed in visitors. guests keep theirs in the browser.
// own table so other features adding account storage don't touch these rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_chats (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    updated INTEGER NOT NULL,
    size INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_chats_user ON ai_chats(user_id, updated);
`);

export const CHAT_LIMITS = {
	maxChats: 200,
	maxChatBytes: 1_500_000,
	maxTotalBytes: 20_000_000,
};

const q = {
	list: db.prepare("SELECT id, title, updated, data FROM ai_chats WHERE user_id = ? ORDER BY updated DESC"),
	usage: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM ai_chats WHERE user_id = ?"),
	sizeOf: db.prepare("SELECT size FROM ai_chats WHERE user_id = ? AND id = ?"),
	put: db.prepare(`INSERT INTO ai_chats (user_id, id, title, updated, size, data) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, id) DO UPDATE SET title = excluded.title, updated = excluded.updated, size = excluded.size, data = excluded.data`),
	del: db.prepare("DELETE FROM ai_chats WHERE user_id = ? AND id = ?"),
	delAll: db.prepare("DELETE FROM ai_chats WHERE user_id = ?"),
};

const ID_RE = /^[a-z0-9]{4,40}$/i;

// fetch() from the page always sends an origin on put/delete. a request from
// another site (or a form post) can't pass this, so no csrf token is needed
function sameOrigin(req, res, next) {
	const origin = req.headers.origin;
	if (origin) {
		let ok = false;
		try {
			const from = new URL(origin).host;
			ok = from === req.headers.host || from === req.headers["x-forwarded-host"];
		} catch {}
		if (!ok) return res.status(403).json({ error: "cross origin request refused" });
	}
	next();
}

function cleanMessages(messages) {
	if (!Array.isArray(messages)) return null;
	return messages.slice(-400).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
}

export function createChatRouter() {
	const router = express.Router();
	router.use(requireAuth);

	router.get("/", (req, res) => {
		const chats = [];
		for (const row of q.list.iterate(req.user.id)) {
			try {
				chats.push({ id: row.id, title: row.title, updated: row.updated, messages: JSON.parse(row.data) });
			} catch {}
		}
		const usage = q.usage.get(req.user.id);
		res.setHeader("Cache-Control", "no-store");
		res.json({ chats, usage: { chats: usage.n, bytes: usage.bytes }, limits: CHAT_LIMITS });
	});

	router.put("/:id", sameOrigin, express.json({ limit: CHAT_LIMITS.maxChatBytes + 100_000 }), (req, res) => {
		const { id } = req.params;
		if (!ID_RE.test(id)) return res.status(400).json({ error: "bad chat id" });
		const messages = cleanMessages(req.body?.messages);
		if (!messages) return res.status(400).json({ error: "messages must be a list" });
		const title = String(req.body?.title ?? "").slice(0, 120);
		const updated = Number.isFinite(req.body?.updated) ? Math.min(Math.floor(req.body.updated), Date.now() + 60_000) : Date.now();
		const data = JSON.stringify(messages);
		const size = Buffer.byteLength(data) + Buffer.byteLength(title);
		if (size > CHAT_LIMITS.maxChatBytes) return res.status(413).json({ error: "this chat is too big to save to your account" });
		const result = db.transaction(() => {
			const usage = q.usage.get(req.user.id);
			const old = q.sizeOf.get(req.user.id, id);
			if (!old && usage.n >= CHAT_LIMITS.maxChats) return { status: 507, error: `you can keep ${CHAT_LIMITS.maxChats} chats on your account, delete some first` };
			if (usage.bytes - (old?.size ?? 0) + size > CHAT_LIMITS.maxTotalBytes) return { status: 507, error: "your account's chat storage is full, delete some chats first" };
			q.put.run(req.user.id, id, title, updated, size, data);
			return null;
		})();
		if (result) return res.status(result.status).json({ error: result.error });
		res.json({ ok: true });
	});

	router.delete("/:id", sameOrigin, (req, res) => {
		if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad chat id" });
		q.del.run(req.user.id, req.params.id);
		res.json({ ok: true });
	});

	router.delete("/", sameOrigin, (req, res) => {
		q.delAll.run(req.user.id);
		res.json({ ok: true });
	});

	return router;
}
