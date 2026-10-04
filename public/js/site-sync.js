const STATE_KEY = "_p8q2:sync";
const LS_RE = /^([a-z0-9.\-\[\]:]+)@/i;
const IDB_RE = /^https?:\/\/[^@/]+@/;
const SKIP_IDB = (name) => !name || name === "__scramjet_controller" || name.startsWith("scramjet-http-cache");
const INTERVAL = 3 * 60_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function readState() {
	try {
		return JSON.parse(localStorage.getItem(STATE_KEY) || "null") || {};
	} catch {
		return {};
	}
}

function writeState(s) {
	try {
		localStorage.setItem(STATE_KEY, JSON.stringify(s));
	} catch {
	}
}

const unitKey = (kind, name) => `${kind}\n${name}`;

function toB64(bytes) {
	if (typeof bytes.toBase64 === "function") return bytes.toBase64();
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

function fromB64(str) {
	if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(str);
	const bin = atob(str);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const TYPED = [
	"Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
	"Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
].filter((n) => typeof globalThis[n] === "function");

function bufBytes(v) {
	return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function encodeValue(value, blobs) {
	const seen = new Set();
	const walk = (v) => {
		if (v === null || typeof v === "boolean" || typeof v === "string") return v;
		if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { $: "n", v: String(Object.is(v, -0) ? "-0" : v) };
		if (v === undefined) return { $: "u" };
		if (typeof v === "bigint") return { $: "bi", v: v.toString() };
		if (typeof v !== "object") throw new Error("value can't be synced");
		if (seen.has(v)) throw new Error("circular value");
		seen.add(v);
		try {
			if (Array.isArray(v)) return { $: "a", v: v.map(walk) };
			if (v instanceof Date) return { $: "d", v: v.getTime() };
			if (v instanceof RegExp) return { $: "r", s: v.source, f: v.flags };
			if (v instanceof ArrayBuffer) return { $: "ab", v: toB64(new Uint8Array(v)) };
			if (v instanceof DataView) return { $: "dv", v: toB64(bufBytes(v)) };
			if (ArrayBuffer.isView(v)) {
				const t = TYPED.find((n) => v instanceof globalThis[n]);
				if (!t) throw new Error("unknown typed array");
				return { $: "ta", t, v: toB64(bufBytes(v)) };
			}
			if (v instanceof Blob) {
				const out = v instanceof File
					? { $: "f", n: v.name, ty: v.type, lm: v.lastModified, v: "" }
					: { $: "bl", ty: v.type, v: "" };
				blobs.push([out, v]);
				return out;
			}
			if (v instanceof Map) return { $: "m", v: [...v].map(([k, x]) => [walk(k), walk(x)]) };
			if (v instanceof Set) return { $: "s", v: [...v].map(walk) };
			if (v instanceof Boolean || v instanceof Number || v instanceof String) return walk(v.valueOf());
			const o = {};
			for (const k of Object.keys(v)) o[k] = walk(v[k]);
			return { $: "o", v: o };
		} finally {
			seen.delete(v);
		}
	};
	return walk(value);
}

function decodeValue(v) {
	if (v === null || typeof v !== "object") return v;
	switch (v.$) {
		case "n": return v.v === "-0" ? -0 : Number(v.v);
		case "u": return undefined;
		case "bi": return BigInt(v.v);
		case "a": return v.v.map(decodeValue);
		case "d": return new Date(v.v);
		case "r": return new RegExp(v.s, v.f);
		case "ab": return fromB64(v.v).buffer;
		case "dv": return new DataView(fromB64(v.v).buffer);
		case "ta": {
			const bytes = fromB64(v.v);
			return new globalThis[v.t](bytes.buffer, 0, bytes.byteLength / globalThis[v.t].BYTES_PER_ELEMENT);
		}
		case "bl": return new Blob([fromB64(v.v)], { type: v.ty });
		case "f": return new File([fromB64(v.v)], v.n, { type: v.ty, lastModified: v.lm });
		case "m": return new Map(v.v.map(([k, x]) => [decodeValue(k), decodeValue(x)]));
		case "s": return new Set(v.v.map(decodeValue));
		case "o": {
			const o = {};
			for (const k of Object.keys(v.v)) o[k] = decodeValue(v.v[k]);
			return o;
		}
		default: return v;
	}
}

async function fillBlobs(blobs) {
	for (const [out, blob] of blobs) out.v = toB64(new Uint8Array(await blob.arrayBuffer()));
}

const req = (r) => new Promise((resolve, reject) => {
	r.onsuccess = () => resolve(r.result);
	r.onerror = () => reject(r.error);
});

const txDone = (tx) => new Promise((resolve, reject) => {
	tx.oncomplete = () => resolve();
	tx.onerror = () => reject(tx.error);
	tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
});

function openDb(name, version, onupgrade) {
	return new Promise((resolve, reject) => {
		const r = version ? indexedDB.open(name, version) : indexedDB.open(name);
		const timer = setTimeout(() => reject(new Error("database is busy")), 5000);
		r.onupgradeneeded = () => onupgrade?.(r.result, r.transaction);
		r.onsuccess = () => {
			clearTimeout(timer);
			resolve(r.result);
		};
		r.onerror = () => {
			clearTimeout(timer);
			reject(r.error);
		};
		r.onblocked = () => {
			clearTimeout(timer);
			reject(new Error("database is busy"));
		};
	});
}

async function exportDb(name, limit) {
	const db = await openDb(name);
	try {
		const out = { v: db.version, stores: [] };
		const names = [...db.objectStoreNames];
		if (!names.length) return JSON.stringify(out);
		const tx = db.transaction(names, "readonly");
		const blobs = [];
		let approx = 0;
		for (const sn of names) {
			const store = tx.objectStore(sn);
			const s = {
				n: sn,
				kp: store.keyPath,
				ai: store.autoIncrement,
				ix: [...store.indexNames].map((i) => {
					const ix = store.index(i);
					return { n: ix.name, kp: ix.keyPath, u: ix.unique, me: ix.multiEntry };
				}),
				rows: [],
			};
			out.stores.push(s);
			await new Promise((resolve, reject) => {
				const c = store.openCursor();
				c.onerror = () => reject(c.error);
				c.onsuccess = () => {
					const cur = c.result;
					if (!cur) return resolve();
					try {
						const before = blobs.length;
						const row = [store.keyPath == null ? encodeValue(cur.primaryKey, blobs) : 0, encodeValue(cur.value, blobs)];
						s.rows.push(row);
						approx += JSON.stringify(row).length;
						for (const [, b] of blobs.slice(before)) approx += b.size * 1.4;
						if (approx > limit) return reject(new Error("too big"));
					} catch (err) {
						return reject(err);
					}
					cur.continue();
				};
			});
		}
		await fillBlobs(blobs);
		return JSON.stringify(out);
	} finally {
		db.close();
	}
}

async function deleteDb(name) {
	await new Promise((resolve, reject) => {
		const r = indexedDB.deleteDatabase(name);
		const timer = setTimeout(() => reject(new Error("database is busy")), 5000);
		r.onsuccess = () => {
			clearTimeout(timer);
			resolve();
		};
		r.onerror = () => {
			clearTimeout(timer);
			reject(r.error);
		};
		r.onblocked = () => {
			clearTimeout(timer);
			reject(new Error("database is busy"));
		};
	});
}

async function importDb(name, text) {
	const data = JSON.parse(text);
	await deleteDb(name);
	const db = await openDb(name, Math.max(1, data.v || 1), (d) => {
		for (const s of data.stores) {
			const store = d.createObjectStore(s.n, { keyPath: s.kp ?? undefined, autoIncrement: !!s.ai });
			for (const ix of s.ix) store.createIndex(ix.n, ix.kp, { unique: !!ix.u, multiEntry: !!ix.me });
		}
	});
	try {
		if (!data.stores.length) return;
		const tx = db.transaction(data.stores.map((s) => s.n), "readwrite");
		for (const s of data.stores) {
			const store = tx.objectStore(s.n);
			for (const [k, v] of s.rows) {
				if (s.kp == null) store.put(decodeValue(v), decodeValue(k));
				else store.put(decodeValue(v));
			}
		}
		await txDone(tx);
	} finally {
		db.close();
	}
}

function cookieDomain(c) {
	return String(c.domain || "").replace(/^\./, "").toLowerCase();
}

function dumpJar(jar) {
	const raw = jar.dump();
	return typeof raw === "string" ? JSON.parse(raw || "{}") : { ...(raw || {}) };
}

function collectCookies(jar) {
	const all = dumpJar(jar);
	const by = new Map();
	for (const [id, c] of Object.entries(all)) {
		const d = cookieDomain(c);
		if (!d) continue;
		if (!by.has(d)) by.set(d, []);
		by.get(d).push([id, c]);
	}
	const units = new Map();
	for (const [d, list] of by) {
		list.sort((a, b) => (a[0] < b[0] ? -1 : 1));
		units.set(d, JSON.stringify(list));
	}
	return units;
}

function collectLocal() {
	const by = new Map();
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (!k || k.startsWith("_p8q2:")) continue;
		const m = LS_RE.exec(k);
		if (!m) continue;
		const host = m[1].toLowerCase();
		if (!by.has(host)) by.set(host, []);
		by.get(host).push([k.slice(m[0].length), localStorage.getItem(k)]);
	}
	const units = new Map();
	for (const [h, list] of by) {
		list.sort((a, b) => (a[0] < b[0] ? -1 : 1));
		units.set(h, JSON.stringify(list));
	}
	return units;
}

function localKeysFor(host) {
	const keys = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		const m = k && !k.startsWith("_p8q2:") ? LS_RE.exec(k) : null;
		if (m && m[1].toLowerCase() === host) keys.push(k);
	}
	return keys;
}

async function idbNames() {
	try {
		return (await indexedDB.databases()).map((d) => d.name).filter((n) => !SKIP_IDB(n) && IDB_RE.test(n));
	} catch {
		return [];
	}
}

function validName(kind, name) {
	if (kind === "c") return /^[a-z0-9_.\-\[\]:]+$/i.test(name);
	if (kind === "l") return !name.startsWith("_p8q2") && LS_RE.test(name + "@") && LS_RE.exec(name + "@")[0] === name + "@";
	if (kind === "i") return IDB_RE.test(name) && !SKIP_IDB(name);
	return false;
}

const idbOrigin = (name) => name.slice(0, name.indexOf("@"));

async function sha256(text) {
	const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gzip(text) {
	const stream = new Blob([enc.encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
	return dec.decode(await new Response(stream).arrayBuffer());
}

async function api(path, opts = {}) {
	const res = await fetch("/api/sitedata" + path, { credentials: "same-origin", ...opts });
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		const err = new Error(data.error || `sync failed (${res.status})`);
		err.status = res.status;
		err.data = data;
		throw err;
	}
	return res;
}

const q = (kind, name, extra = "") => `?kind=${kind}&name=${encodeURIComponent(name)}${extra}`;

export function createSiteSync({ getEngine, getUser, busyOrigins = () => new Set(), onState = () => {} }) {
	const status = { used: 0, cap: 0, last: 0, busy: false, error: "", full: false, skipped: [] };
	const tooBig = new Set();
	let timer = null;
	let running = null;

	const emit = () => onState({ ...status, skipped: [...status.skipped] });

	async function collect(unitMax) {
		const engine = getEngine();
		const units = new Map();
		const put = (kind, name, text) => units.set(unitKey(kind, name), { kind, name, text });
		for (const [d, t] of collectCookies(engine.controller.cookieJar)) put("c", d, t);
		for (const [h, t] of collectLocal()) put("l", h, t);
		const skipped = [];
		const unreadable = new Set();
		for (const name of await idbNames()) {
			if (tooBig.has(name)) {
				skipped.push(name);
				continue;
			}
			try {
				put("i", name, await exportDb(name, unitMax * 3));
			} catch (err) {
				if (err.message === "too big") {
					tooBig.add(name);
					skipped.push(name);
				} else unreadable.add(name);
			}
		}
		return { units, skipped, unreadable };
	}

	async function applyCookies(changes) {
		const engine = getEngine();
		const jar = engine.controller.cookieJar;
		const all = dumpJar(jar);
		const touched = new Set(changes.map((c) => c.name));
		for (const [id, c] of Object.entries(all)) if (touched.has(cookieDomain(c))) delete all[id];
		for (const c of changes) if (c.text) for (const [id, cookie] of JSON.parse(c.text)) all[id] = cookie;
		jar.load(JSON.stringify(all));
		await engine.controller.persistCookies();
	}

	function applyLocal(name, text) {
		for (const k of localKeysFor(name)) localStorage.removeItem(k);
		if (!text) return;
		for (const [k, v] of JSON.parse(text)) localStorage.setItem(`${name}@${k}`, v);
	}

	async function applyIdb(name, text) {
		if (busyOrigins().has(idbOrigin(name))) throw new Error("site is open");
		if (text) await importDb(name, text);
		else await deleteDb(name);
	}

	async function download(kind, name) {
		const res = await api("/unit" + q(kind, name));
		return gunzip(new Uint8Array(await res.arrayBuffer()));
	}

	async function run() {
		const user = getUser();
		const engine = getEngine();
		if (!user || !engine) return;
		status.busy = true;
		status.error = "";
		emit();
		try {
			const state = readState();
			const manifest = state.u === user.id ? { ...(state.m || {}) } : {};
			const save = () => writeState({ u: user.id, m: manifest });
			const remote = await (await api("/")).json();
			status.cap = remote.cap;
			status.used = remote.used;
			const server = new Map(remote.units.map((u) => [unitKey(u.kind, u.name), u]));
			const { units: local, skipped, unreadable } = await collect(remote.unitMax);
			status.skipped = skipped;
			const hashes = new Map();
			for (const [k, u] of local) hashes.set(k, await sha256(u.text));

			const keys = new Set([...server.keys(), ...local.keys(), ...Object.keys(manifest)]);
			const pulls = [];
			const pushes = [];
			const remoteDeletes = [];
			for (const k of keys) {
				const [kind, name] = k.split("\n");
				if (kind === "i" && (unreadable.has(name) || tooBig.has(name))) continue;
				const s = server.get(k);
				const lh = hashes.get(k);
				const mh = manifest[k];
				if (s) {
					if (lh === s.hash) manifest[k] = s.hash;
					else if (mh !== s.hash) pulls.push({ kind, name, hash: s.hash });
					else if (!lh) remoteDeletes.push({ kind, name, k });
					else pushes.push({ kind, name, k, hash: lh });
				} else if (lh) {
					if (mh && lh === mh) pulls.push({ kind, name, hash: null });
					else pushes.push({ kind, name, k, hash: lh });
				} else {
					delete manifest[k];
				}
			}

			const cookieChanges = [];
			for (const p of pulls) {
				const k = unitKey(p.kind, p.name);
				if (!validName(p.kind, p.name)) continue;
				try {
					const text = p.hash ? await download(p.kind, p.name) : null;
					if (p.kind === "c") cookieChanges.push({ name: p.name, text, k, hash: p.hash });
					else {
						if (p.kind === "l") applyLocal(p.name, text);
						else await applyIdb(p.name, text);
						if (p.hash) manifest[k] = p.hash;
						else delete manifest[k];
					}
				} catch {
				}
			}
			if (cookieChanges.length) {
				await applyCookies(cookieChanges);
				for (const c of cookieChanges) {
					if (c.hash) manifest[c.k] = c.hash;
					else delete manifest[c.k];
				}
			}
			save();

			for (const d of remoteDeletes) {
				const r = await (await api("/unit" + q(d.kind, d.name), { method: "DELETE" })).json();
				status.used = r.used;
				delete manifest[d.k];
			}
			save();

			status.full = false;
			for (const p of pushes) {
				const body = await gzip(local.get(p.k).text);
				if (body.length > remote.unitMax) {
					if (p.kind === "i") tooBig.add(p.name);
					status.skipped.push(p.name);
					continue;
				}
				try {
					const res = await api("/unit" + q(p.kind, p.name, `&hash=${p.hash}`), {
						method: "PUT",
						headers: { "Content-Type": "application/octet-stream" },
						body,
					});
					const r = await res.json();
					status.used = r.used;
					manifest[p.k] = p.hash;
					save();
				} catch (err) {
					if (err.status !== 413) throw err;
					if (err.data?.cap) status.full = true;
					else status.skipped.push(p.name);
				}
			}
			save();
			status.last = Date.now();
		} catch (err) {
			status.error = err.message;
		} finally {
			status.busy = false;
			emit();
		}
	}

	function sync() {
		if (running) return running;
		const go = () => run();
		running = (navigator.locks ? navigator.locks.request(STATE_KEY, go) : go()).finally(() => (running = null));
		return running;
	}

	function start() {
		stop();
		timer = setInterval(() => {
			if (document.visibilityState === "visible") sync();
		}, INTERVAL);
		sync();
	}

	function stop() {
		clearInterval(timer);
		timer = null;
	}

	async function wipeRemote() {
		if (!getUser()) return;
		const res = await (await api("/", { method: "DELETE" })).json();
		status.used = res.used;
		writeState({ u: getUser().id, m: {} });
		emit();
	}

	function forget() {
		stop();
		writeState({});
	}

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden" && timer && Date.now() - status.last > 30_000) sync();
	});

	return { sync, start, stop, wipeRemote, forget, get status() {
		return { ...status };
	} };
}
