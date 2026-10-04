// pm2 config for umbrella.
//
//   pm2 start ecosystem.config.cjs      first start
//   pm2 reload ecosystem.config.cjs     zero downtime restart after a git pull
//   pm2 save && pm2 startup             survive reboots
//
// cluster mode is safe here: every wisp websocket stays on the worker that
// accepted it, and all proxy state (cookies, rewriting) lives in the browser.

module.exports = {
	apps: [
		{
			name: "umbrella",
			script: "src/server.js",
			cwd: __dirname,
			exec_mode: "cluster",
			// 4 workers is what umbrella.rest runs. UMBRELLA_INSTANCES=max gives one per core
			instances: process.env.UMBRELLA_INSTANCES || process.env.NOCTURNE_INSTANCES || 4,
			// server.js calls process.send("ready") once it is listening
			wait_ready: true,
			listen_timeout: 10000,
			kill_timeout: 9000,
			max_memory_restart: "700M",
			// if a worker dies on boot (port taken, broken install) back off instead of
			// restarting in a tight loop, so the logs stay readable
			exp_backoff_restart_delay: 200,
			env: {
				NODE_ENV: "production",
				HOST: "127.0.0.1",
				// 8080 is taken by the old nocturne app on the vps, so umbrella lives on 8090.
				// umbrella.config.cjs is the same file, both reload lines do the same thing
				PORT: process.env.PORT || 8090,
				TRUST_PROXY: "loopback",
			},
			time: true,
			merge_logs: true,
		},
	],
};
