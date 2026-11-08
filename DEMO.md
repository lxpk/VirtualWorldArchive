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

## Accounts and access control

- **Site Admin.** With `ADMIN_PASSWORD` set in `.env`, the archive creates a Site Admin
  account `ADMIN_EMAIL` (default `admin@localhost`) on first start. The Oracle deploy script
  generates that password; read it with `grep ADMIN_PASSWORD .env`. Without it, the first
  account registered becomes Site Admin.
- **Sign in** at `/login` with email and password, or with Google when configured (below).
  Users manage their name, password and Google link at `/account`.
- **Access control** (`/admin`, Site Admin) has tabs for Users, Groups, Roles, Server
  policies and Settings. Roles bundle permissions:
  - *site* permissions (`site.admin`, `access.manage`, `servers.upload`, `clients.upload`,
    `servers.manage`, `servers.logs`, `servers.play`) apply when a role is given to a user
    or a group;
  - *instance* permissions (`instance.join`, `instance.logs`, `instance.operate`,
    `instance.configure`, `instance.policy`) apply when a role is bound to a group in a
    server's policy.
  Built-in roles: Site Admin, Guest (everyone), Member (every signed-in user), plus editable
  defaults Curator, Instance Admin, Instance Operator and Instance Player.
- **Server policies.** Each world's page has an *Instance policy* panel:
  - *Open server*: Curators (`servers.manage`), Site Admins and the uploader administer it.
  - *Managed Server Instance*: only members of the groups bound to it administer it, each
    with its bound role's instance permissions. Site Admins can still edit the policy so an
    instance can't be orphaned, but they don't start, stop or read logs unless bound.
  - *Who can join*: everyone, signed-in users, or only groups bound with `instance.join`.
    Clients without the browser's sign-in (Unity) use the personal address with a play
    token from the world page.
  Uploaders can make a new server a Managed Server Instance on the upload form.

### Google sign-in (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create a
   project, configure the OAuth consent screen (External; while it is in *Testing*, add the
   Google accounts that may sign in as test users), then **Create credentials → OAuth client
   ID → Web application**.
2. Add the authorized redirect URI `https://<your-host>/auth/google/callback` (for the Oracle
   VM: `https://<ip-with-dashes>.sslip.io/auth/google/callback`; locally
   `http://localhost/auth/google/callback`). Access control → Settings shows the exact URI.
3. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`,
   optionally `PUBLIC_URL`, `ADMIN_EMAILS` (Google addresses that are always Site Admin) and
   `GOOGLE_ALLOWED_DOMAINS`, then `docker compose up -d`.

A Google sign-in never takes over an existing password account with the same email: the owner
signs in with the password and links Google on `/account`.

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

- Accounts, groups and policies live in `auth.json` in the archive's data volume (fine for a
  demo; move to Postgres before many users).
- Inside and outside are separate zones joined by portals. The scan is not yet
  aligned with the exterior model.
- Collision is simple (floor and chest-height walls), so scanned furniture is walkable.
