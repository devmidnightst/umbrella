// sets or reads a cookie, localStorage and an indexeddb save, like a site login
// plus a game save. the account sync e2e checks they follow the account.
const set = new URLSearchParams(location.search).has("set");

function openDb() {
	return new Promise((resolve, reject) => {
		const r = indexedDB.open("gamesave", 3);
		r.onupgradeneeded = () => {
			const db = r.result;
			const s = db.createObjectStore("slots", { keyPath: "id" });
			s.createIndex("by_level", "level");
			db.createObjectStore("kv");
		};
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

const done = (tx) => new Promise((resolve, reject) => {
	tx.oncomplete = resolve;
	tx.onerror = () => reject(tx.error);
});
const get = (r) => new Promise((resolve, reject) => {
	r.onsuccess = () => resolve(r.result);
	r.onerror = () => reject(r.error);
});

async function run() {
	const db = await openDb();
	if (set) {
		document.cookie = "login=abc123; max-age=3600; path=/";
		localStorage.setItem("save", "level7");
		const tx = db.transaction(["slots", "kv"], "readwrite");
		tx.objectStore("slots").put({ id: 1, level: 7, when: new Date(1000), bytes: new Uint8Array([1, 2, 3]), file: new Blob(["hello"], { type: "text/plain" }), tags: new Set(["a"]) });
		tx.objectStore("kv").put(new Map([["coins", 42n]]), ["player", 1]);
		await done(tx);
		document.title = "set";
		return;
	}
	const tx = db.transaction(["slots", "kv"], "readonly");
	const slot = await get(tx.objectStore("slots").get(1));
	const kv = await get(tx.objectStore("kv").get(["player", 1]));
	const byLevel = await get(tx.objectStore("slots").index("by_level").count(7));
	const out = {
		cookie: document.cookie,
		local: localStorage.getItem("save"),
		version: db.version,
		level: slot?.level ?? null,
		when: slot?.when instanceof Date ? slot.when.getTime() : null,
		bytes: slot?.bytes instanceof Uint8Array ? [...slot.bytes] : null,
		file: slot?.file instanceof Blob ? await slot.file.text() : null,
		tags: slot?.tags instanceof Set ? [...slot.tags] : null,
		coins: kv instanceof Map ? String(kv.get("coins")) : null,
		byLevel,
	};
	document.getElementById("out").textContent = JSON.stringify(out);
	document.title = "read";
}

run().catch((e) => {
	document.title = "error " + e.message;
});
