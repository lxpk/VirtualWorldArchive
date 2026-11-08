# VR Archive world protocol

JSON text messages over one WebSocket. Clients connect through the archive at
`ws(s)://<archive-host>/play/vrarchive`, which proxies to the world server container.

Positions are in glTF / three.js space: right-handed, +Y up, meters. `ry` is yaw in
radians, where 0 faces -Z. Unity clients mirror X on the way in and out:
`unity = (-x, y, z)` and `unityYawDeg = 180 - ry * 57.2958`.

Zones are `street` (outside 300 Funston Ave) and `hall` (the great hall). Avatars
are only drawn for players in the same zone.

## Client to server

| Message | Fields |
| --- | --- |
| `{"t":"hello"}` | `name` (≤24 chars), `platform` (`webgl`, `unity`, …), `zone` |
| `{"t":"move"}` | `zone`, `p: [x, y, z]` (feet position), `ry`. Send at most 10 per second. |
| `{"t":"chat"}` | `text` (≤200 chars) |

## Server to client

| Message | Fields |
| --- | --- |
| `{"t":"welcome"}` | `id` (yours), `world`, `players: [player]` |
| `{"t":"join"}` | `player` |
| `{"t":"leave"}` | `id` |
| `{"t":"snapshot"}` | `players: [player]`, sent 10 times per second |
| `{"t":"chat"}` | `id`, `name`, `platform`, `text` |

`player` is `{ id, name, platform, color, zone, p: [x, y, z], ry }`.

The server also answers `GET /status` with uptime, database state, stored visit and
chat counts, and the current player list. The archive's server panel reads it.
