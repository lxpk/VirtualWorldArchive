# Demo: Internet Archive VR on the Virtual World Archive

## Start the archive

Needs Docker with Compose. From the repository root:

```sh
cp .env.example .env          # optional: set HTTP_PORT (default 80)
docker compose up -d --build
docker compose logs -f archive   # wait for "[vrarchive] Server is running" (first run ~1 min)
```

On first start the archive seeds itself with the Internet Archive VR world: it builds
the world server image, starts it plus a Postgres database as their own containers, and
publishes the WebGL client. Open <http://localhost/> (or your `HTTP_PORT`).

## Unity client

1. Open `worlds/vrarchive/unity-client` in Unity Hub (Unity 6, any 6000.x). The first
   import downloads glTFast, the Input System and NativeWebSocket, and creates
   `Assets/Scenes/Main.unity`.
2. Press **Play**. Enter a name and the server address shown on the world's page
   (for a local archive: `ws://localhost/play/vrarchive`, or `ws://localhost:8080/...` if
   you set `HTTP_PORT=8080`), then **Enter world**.
3. Optional: **Virtual World Archive → Build WebGL client**, zip `Builds/WebGL`, and
   upload it on the Server Library page as a web client for `vrarchive`.

## Demo script (about 5 minutes)

1. **Server Library** (`/`). "This is the Internet Archive's software section, extended
   with a server library. Each tile is a preserved multiplayer world whose server is
   still running." Point at the green *running* status.
2. Open **Internet Archive VR**. The item page mirrors an archive.org details page. The
   **Server** panel shows the server container and its Postgres database running,
   uptime, stored visits and chat, and who is online.
3. Click **Play in browser** and enter a name. You are on Funston Ave in front of the
   building.
4. Switch to Unity and press Play, using the address from the item page. The Unity
   player appears in the browser with a "Unity client" tag, and the browser player
   appears in Unity. The item page's player list shows both platforms.
5. Chat from each side (Enter). Messages cross platforms and are saved to the world's
   database, and the counters on the item page go up.
6. Walk up the steps to the glowing portal ("Enter the Great Hall"). Both players can
   follow each other into the 3D-scanned great hall, and the exit portal leads back out.
7. Close with the upload forms at the bottom of the Server Library: any game server
   with a Dockerfile and any web client can be archived the same way (see `/toolkit.html`).

## Known limits

- No accounts or upload authentication yet. Run it on a private host for demos.
- Inside and outside are separate zones joined by portals. The scan is not yet
  aligned with the exterior model.
- Collision is simple (floor and chest-height walls), so scanned furniture is walkable.
