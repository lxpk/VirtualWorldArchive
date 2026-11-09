# VIRTUAL WORLD ARCHIVE

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lxpk/VirtualWorldArchive?quickstart=1)

Run it free in one click: see [deploy/CODESPACES.md](deploy/CODESPACES.md). For an always-on server, see [deploy/oracle/README.md](deploy/oracle/README.md).

The Virtual World Archive facilitates building and preserving  virtual worlds both reality-based augmented and historically focused realities and fiction-based purely virtual worlds.

The web site supports uploading not just front end virtual world content but also server-side backends to support multiplayer virtual worlds and their continued operation in the hands of community.

## TRY IT

```sh
docker compose up -d --build   # then open http://localhost/
```

See [DEMO.md](DEMO.md) for the Unity client and a demo script, and
[toolkit/README.md](toolkit/README.md) for packaging your own server and client.

| Path | What it is |
| --- | --- |
| `archive/` | Portal (Archive-style Server Library and item pages), upload API, and orchestrator that runs each world server and its database as Docker containers |
| `worlds/vrarchive/server/` | Example world server (Node.js, WebSocket, Postgres) |
| `worlds/vrarchive/webgl-client/` | Browser client (three.js) with the street, building and great hall models |
| `worlds/vrarchive/unity-client/` | Unity 6 client sharing the same server and models |
| `toolkit/` | How to package servers and clients for the archive |

## PROJECT HISTORY

### The original 3d Scan of the archive
The original project started at the ASD hackathon at the Internet Archive as a project to scan the Archive itself and combine different scans into a navigable history and combined landscape. 
https://gitlab.com/unityversity/InternetVARchive

### Jin's multi-platform remixes
Jin of Metaverse Makers expanded the original into different versions and added a polished 3D building experior and some additional models and versions that were underwater, overgrown with ivy, etc.
https://github.com/madjin/internet-archive-vr

