# World Archival Toolkit

How to package a multiplayer game so the Virtual World Archive can keep it running.

## Server package

Upload a `.zip` or `.tar.gz` whose root (or one folder down) contains:

- **`Dockerfile`**: builds your server. Use multi-arch base images (the archive may run on arm64) and do not download x86-only binaries.
- **`vwa.json`** (optional): defaults for the upload form.

```json
{
  "id": "my-world",
  "title": "My World (2004)",
  "description": "What it is and who played it.",
  "port": 7777,
  "protocol": "websocket-json",
  "database": "postgres",
  "client": "my-world-webgl"
}
```

At runtime the archive gives your container:

| Variable | Meaning |
| --- | --- |
| `PORT` | Port your server must listen on (from `vwa.json` or the form). |
| `DATABASE_URL` | `postgres://…` connection string when `database` is `postgres`. The database runs in its own container with a persistent volume. |
| `WORLD_ID` | The server's identifier in the archive. |

Players reach the server through the archive at `/play/<id>`, which proxies WebSockets
to your container. If your server answers `GET /status` with JSON containing a
`players` array, the archive shows who is online.

## Web client package

Upload a `.zip` of a browser build with an `index.html` (Unity WebGL build, Godot or
other web export, or an emulator page). It is served at `/clients/<id>/`. Connect to
`/play/<server-id>` on the same origin. Pre-compressed Unity files (`.gz`, `.br`) are
served with the right headers. An optional `vwa-client.json` sets the title, server
and platform, and a `thumb.jpg` is used as the library thumbnail.

## Example

`worlds/vrarchive/` is a complete example: `server/` (Node.js + Postgres),
`webgl-client/` (three.js), and `unity-client/` (Unity 6), all sharing
[PROTOCOL.md](../worlds/vrarchive/PROTOCOL.md).

## Behind a proxy

If the archive host builds images behind an HTTP proxy, set `DOCKER_BUILD_NETWORK`
and `DOCKER_BUILD_ARGS` (JSON, for example `{"HTTPS_PROXY":"http://proxy:3128"}`)
on the archive service.
