const RUN_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:";
const BOX_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'";
const MAX_LOG = 20000;
const MAX_LINES = 300;

const WORKER_SRC = `
const send = (t, d) => postMessage({ t, d });
const fmt = (v) => {
	if (typeof v === "string") return v;
	if (v instanceof Error) return v.stack || String(v);
	if (typeof v === "function") return v.toString();
	if (typeof v === "bigint") return v + "n";
	if (v === undefined) return "undefined";
	try {
		const seen = new WeakSet();
		const s = JSON.stringify(v, (k, x) => {
			if (typeof x === "bigint") return x + "n";
			if (x && typeof x === "object") { if (seen.has(x)) return "[circular]"; seen.add(x); }
			if (x instanceof Map) return Object.fromEntries(x);
			if (x instanceof Set) return [...x];
			return x;
		}, 2);
		return s === undefined ? String(v) : s;
	} catch { return String(v); }
};
for (const level of ["log", "info", "warn", "error", "debug", "table"]) {
	console[level] = (...args) => send("log", { level: level === "table" ? "log" : level, text: args.map(fmt).join(" ") });
}
self.onmessage = async (e) => {
	const code = String(e.data);
	try {
		let value;
		if (/\\bawait\\b/.test(code)) {
			const AsyncFunction = (async () => {}).constructor;
			value = await new AsyncFunction(code)();
		} else {
			value = (0, eval)(code);
			if (value && typeof value.then === "function") value = await value;
		}
		send("done", { value: value === undefined ? null : fmt(value) });
	} catch (err) {
		send("done", { error: err && err.stack ? String(err.stack).split("\\n").slice(0, 4).join("\\n") : String(err) });
	}
};
`;

const RUNNER_DOC = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${RUN_CSP}"><script>
const src = ${JSON.stringify(WORKER_SRC)};
let worker;
addEventListener("message", (e) => {
	if (worker || e.source !== parent || typeof e.data?.code !== "string") return;
	try {
		worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
	} catch (err) {
		parent.postMessage({ t: "done", d: { error: "couldn't start the sandbox: " + err.message } }, "*");
		return;
	}
	worker.onmessage = (m) => { if (m.data?.t !== "ready") parent.postMessage(m.data, "*"); };
	worker.onerror = (m) => { m.preventDefault(); parent.postMessage({ t: "done", d: { error: m.message || "the code crashed" } }, "*"); };
	worker.postMessage(e.data.code);
});
parent.postMessage({ t: "ready" }, "*");
<\/script>`;

export function runCode(code, { timeout = 6000, signal } = {}) {
	return new Promise((resolve) => {
		const started = performance.now();
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("aria-hidden", "true");
		frame.tabIndex = -1;
		frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
		frame.srcdoc = RUNNER_DOC;
		const lines = [];
		let size = 0;
		let cut = false;
		let finished = false;
		let sent = false;
		const finish = (result) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			removeEventListener("message", onMessage);
			signal?.removeEventListener("abort", onAbort);
			frame.remove();
			resolve({ logs: lines, cut, ms: Math.round(performance.now() - started), ...result });
		};
		const onAbort = () => finish({ error: "stopped" });
		const onMessage = (e) => {
			if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") return;
			const { t, d } = e.data;
			if (t === "ready") {
				if (sent) return;
				sent = true;
				frame.contentWindow.postMessage({ code }, "*");
			}
			else if (t === "log") {
				if (lines.length >= MAX_LINES || size > MAX_LOG) { cut = true; return; }
				const text = String(d?.text ?? "").slice(0, MAX_LOG - size);
				size += text.length;
				lines.push({ level: String(d?.level || "log"), text });
			} else if (t === "done") {
				finish({ value: d?.value ?? null, error: d?.error ? String(d.error) : null });
			}
		};
		const timer = setTimeout(() => finish({ error: `stopped after ${Math.round(timeout / 1000)}s (it took too long or never finished)` }), timeout);
		addEventListener("message", onMessage);
		signal?.addEventListener("abort", onAbort);
		document.documentElement.append(frame);
	});
}

export function describeRun(result) {
	const out = result.logs.map((l) => (l.level === "log" || l.level === "info" ? l.text : `[${l.level}] ${l.text}`));
	if (result.cut) out.push("[more output was cut off]");
	if (result.error) out.push(`Error: ${result.error}`);
	else if (result.value != null) out.push(`=> ${result.value}`);
	return out.join("\n") || "(no output)";
}

const BOX_HEAD = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${BOX_CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}html,body{margin:0}body{padding:12px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}</style>`;
const BOX_TAIL = `<script>addEventListener("click",(e)=>{const a=e.target.closest&&e.target.closest("a[href]");if(a&&!a.getAttribute("href").startsWith("#"))e.preventDefault()},true);addEventListener("submit",(e)=>e.preventDefault(),true);(()=>{let last=0;const post=()=>{const b=document.body;if(!b)return;const cs=getComputedStyle(b);const h=Math.ceil(b.getBoundingClientRect().height+parseFloat(cs.marginTop)+parseFloat(cs.marginBottom));if(h!==last){last=h;parent.postMessage({t:"size",h},"*")}};const ro=new ResizeObserver(post);if(document.body)ro.observe(document.body);addEventListener("load",post);setTimeout(post,50);setTimeout(post,500)})()<\/script>`;

export function boxFrame(html, { title = "box" } = {}) {
	const frame = document.createElement("iframe");
	frame.className = "aic-box-frame";
	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute("title", title);
	frame.setAttribute("loading", "lazy");
	frame.srcdoc = BOX_HEAD + String(html).replace(/^\s*<!doctype[^>]*>/i, "").replace(/<meta\b[^>]*http-equiv[^>]*>|<base\b[^>]*>/gi, "") + BOX_TAIL;
	let loads = 0;
	frame.addEventListener("load", () => {
		loads += 1;
		if (loads < 2) return;
		const note = document.createElement("p");
		note.className = "aic-box-blocked";
		note.textContent = "This box tried to open another page, so it was closed.";
		frame.replaceWith(note);
	});
	const onMessage = (e) => {
		if (!frame.isConnected) { removeEventListener("message", onMessage); return; }
		if (e.source !== frame.contentWindow || e.data?.t !== "size") return;
		const hgt = Math.max(48, Math.min(Number(e.data.h) || 0, 720));
		frame.style.height = `${hgt}px`;
	};
	addEventListener("message", onMessage);
	return frame;
}
