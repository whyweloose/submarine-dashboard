# Submarine Dashboard

A small server dashboard and telemetry API for Submarine. The API uses Node.js built-in modules only; no npm packages are required in production.

## Requirements

- Node.js 20 or newer (Node.js 24 is recommended).
- No per-server registration file is required.

## Run Locally

```sh
cd submarine-dashboard
npm test
npm start
```

The API listens on `127.0.0.1:8765` by default. Serve `public/` with a static web server and proxy `/api/submarine/v1/` to the API. For local development, `start.sh` is an equivalent launcher:

```sh
./start.sh
```

The first valid telemetry report automatically adds its `server_id` to the dashboard. Submarine derives this ID from the server instance directory, so no server registration file or per-server dashboard setup is needed. The displayed name defaults to the ID; clients may optionally send `server_name`. Servers that reach the API from the same source IP are placed in the same automatically generated group. The source IP is hashed before the group is stored and is not returned by the API.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUBMARINE_DASHBOARD_HOST` | `127.0.0.1` | API bind address |
| `SUBMARINE_DASHBOARD_PORT` | `8765` | API port |
| `SUBMARINE_DASHBOARD_STORE` | `data/state.json` | Persistent telemetry state |

The state file is written atomically and retains the latest 360 measurements per server. Reports older than 90 seconds mark a server offline. Telemetry is limited to 120 requests per source IP per minute and 256 discovered server IDs total; request bodies are limited to 128 KiB.

## API

Base URL: `https://api.whyweloose.pw/api/submarine/v1`

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | List API routes |
| `GET` | `/health` | Check API availability |
| `GET` | `/servers` | List discovered servers, aggregate online count, and history |
| `GET` | `/servers/{id}` | Return one discovered server and its telemetry history |
| `POST` | `/telemetry` | Accept a report and automatically discover its server ID |

Submit a report without a token or registration:

```sh
curl -X POST https://api.whyweloose.pw/api/submarine/v1/telemetry \
  -H 'Content-Type: application/json' \
  --data '{"server_id":"grief","stats":{"uptime_seconds":3600,"tps_current":20,"load_current_percent":12.5,"tps_average":19.98,"load_average_percent":13.2,"online":8,"max_players":100,"network_upload_kb_s":4.2,"network_download_kb_s":8.1,"thread_count":12,"memory_mb":{"main":45,"total":620,"virtual":810,"heap":48,"max":2048},"worlds":[]}}'
```

`stats` supports uptime, current and average TPS/load, online and maximum players, network rates, thread count, memory values, and world counters. Player names and source IPs are not returned by the API. A successful report returns `202`; invalid server IDs or JSON return `400`, oversized reports return `413`, and rate or server capacity limits return `429`.

## Production Deployment

The production API runs as the unprivileged `www-data` account on loopback. Nginx serves the static dashboard and proxies the API prefix; Caddy provides HTTPS. The included systemd unit expects the project at `/opt/submarine-dashboard` and writable state at `/var/lib/submarine-dashboard/state.json`.

On Ubuntu, install Node.js 20 or newer, copy the project to `/opt/submarine-dashboard`, and create the telemetry data directory:

```sh
sudo install -d -o www-data -g www-data -m 0750 /var/lib/submarine-dashboard
sudo install -o root -g root -m 0644 deploy/submarine-dashboard-api.service /etc/systemd/system/submarine-dashboard-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now submarine-dashboard-api.service
```

Install `deploy/nginx-api.conf` into the Nginx sites-enabled configuration, validate it with `sudo nginx -t`, then reload Nginx. No registration file or `npm install` step is needed.

## Tests

Run the built-in Node.js test suite with:

```sh
npm test
npm run check
```
