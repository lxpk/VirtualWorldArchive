// Internet Archive VR: Unity client for the Virtual World Archive.
// Loads the same glTF models and world.json as the browser client from the
// archive, then joins the same world server over WebSocket, so Unity and
// WebGL players share one session. Everything is built from code, so it runs
// from any scene (see VwaBootstrap).
//
// Coordinates on the wire are glTF / three.js space (right-handed). glTFast
// mirrors X when importing, so: unity = (-x, y, z), unityYawDeg = 180 - ry * Rad2Deg.
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using GLTFast;
using NativeWebSocket;
using UnityEngine;
using UnityEngine.Networking;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace Vwa
{
    public class VwaClient : MonoBehaviour
    {
        [Tooltip("World server WebSocket, through the archive proxy")]
        public string serverUrl = "ws://localhost:8080/play/vrarchive";
        [Tooltip("Where world.json and the models are served (the WebGL client folder on the archive)")]
        public string assetBaseUrl = "";
        public string playerName = "";

        // ---- world ----
        class Zone { public string name, label; public GameObject root; public Vector3 spawn; public float spawnRy; public Color sky; }
        class Portal { public string zone, to, label; public Vector3 pos; public float radius; public Vector3? arriveAt; public Transform ring; }
        readonly Dictionary<string, Zone> zones = new Dictionary<string, Zone>();
        readonly List<Portal> portals = new List<Portal>();
        string worldTitle = "Internet Archive VR";
        string currentZone = "street";
        bool worldReady;
        string loadStatus = "Loading world…";

        // ---- local player ----
        Camera cam;
        Vector3 pos;      // feet, unity space
        float yaw, pitch; // degrees
        const float Eye = 1.6f;
        float vy;

        // ---- network ----
        WebSocket ws;
        int myId = -1;
        bool connected, wantConnect;
        float lastSend;
        string netStatus = "not connected";
        class Remote { public GameObject go; public Vector3 target; public float targetYaw; public string zone, name, platform, color; public TextMesh label; }
        readonly Dictionary<int, Remote> remotes = new Dictionary<int, Remote>();
        readonly List<string> chatLog = new List<string>();
        string chatInput = "";
        bool chatFocus;

        Font font;

        // ======================================================================
        void Awake()
        {
            font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
#if UNITY_WEBGL && !UNITY_EDITOR
            // Hosted on the archive at /clients/<id>/: talk to the same origin.
            var u = new System.Uri(Application.absoluteURL);
            var wsScheme = u.Scheme == "https" ? "wss" : "ws";
            var hostPort = u.IsDefaultPort ? u.Host : $"{u.Host}:{u.Port}";
            serverUrl = $"{wsScheme}://{hostPort}/play/vrarchive";
            if (string.IsNullOrEmpty(assetBaseUrl)) assetBaseUrl = $"{u.Scheme}://{hostPort}/clients/vrarchive-webgl/";
#else
            serverUrl = PlayerPrefs.GetString("vwa.server", serverUrl);
#endif
            playerName = PlayerPrefs.GetString("vwa.name", playerName);
            if (string.IsNullOrEmpty(playerName)) playerName = "Unity " + Random.Range(100, 999);

            cam = Camera.main;
            if (cam == null) { var c = new GameObject("Camera"); cam = c.AddComponent<Camera>(); c.tag = "MainCamera"; c.AddComponent<AudioListener>(); }
            cam.nearClipPlane = 0.05f; cam.farClipPlane = 2000f; cam.clearFlags = CameraClearFlags.SolidColor;
            if (FindFirstObjectByType<Light>() == null)
            {
                var l = new GameObject("Sun").AddComponent<Light>();
                l.type = LightType.Directional; l.intensity = 1.1f; l.transform.rotation = Quaternion.Euler(50, 150, 0);
            }
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.55f, 0.55f, 0.55f);
        }

        string AssetBase()
        {
            if (!string.IsNullOrEmpty(assetBaseUrl)) return assetBaseUrl.EndsWith("/") ? assetBaseUrl : assetBaseUrl + "/";
            // ws://host:port/play/<id>  ->  http://host:port/clients/vrarchive-webgl/
            var http = serverUrl.Replace("wss://", "https://").Replace("ws://", "http://");
            int p = http.IndexOf("/play/");
            return (p > 0 ? http.Substring(0, p) : http.TrimEnd('/')) + "/clients/vrarchive-webgl/";
        }

        async Task LoadWorld()
        {
            worldReady = false;
            foreach (var z in zones.Values) Destroy(z.root);
            foreach (var pt in portals) if (pt.ring) Destroy(pt.ring.gameObject);
            zones.Clear(); portals.Clear();

            var baseUrl = AssetBase();
            loadStatus = $"Fetching {baseUrl}world.json";
            string text;
            using (var req = UnityWebRequest.Get(baseUrl + "world.json"))
            {
                var op = req.SendWebRequest();
                while (!op.isDone) await Task.Yield();
                if (req.result != UnityWebRequest.Result.Success) { loadStatus = "Could not load world.json: " + req.error; return; }
                text = req.downloadHandler.text;
            }
            var world = MiniJson.Obj(MiniJson.Parse(text));
            worldTitle = MiniJson.S(MiniJson.Get(world, "title"));

            foreach (var kv in MiniJson.Obj(MiniJson.Get(world, "zones")))
            {
                var def = MiniJson.Obj(kv.Value);
                var z = new Zone { name = kv.Key, label = MiniJson.S(MiniJson.Get(def, "label")), root = new GameObject("Zone " + kv.Key) };
                z.root.transform.SetParent(transform, false);
                var sp = MiniJson.Arr(MiniJson.Get(def, "spawn"));
                z.spawn = ToUnity(MiniJson.F(sp[0]), MiniJson.F(sp[1]), MiniJson.F(sp[2]));
                z.spawnRy = MiniJson.F(MiniJson.Get(def, "spawnRy"));
                ColorUtility.TryParseHtmlString(MiniJson.S(MiniJson.Get(def, "sky")), out z.sky);
                foreach (var m in MiniJson.Arr(MiniJson.Get(def, "models")))
                {
                    loadStatus = $"Loading {MiniJson.S(m)}…";
                    var gltf = new GltfImport();
                    if (!await gltf.Load(baseUrl + MiniJson.S(m))) { loadStatus = "Failed to load " + MiniJson.S(m); continue; }
                    var holder = new GameObject(MiniJson.S(m)); holder.transform.SetParent(z.root.transform, false);
                    await gltf.InstantiateMainSceneAsync(holder.transform);
                    foreach (var mf in holder.GetComponentsInChildren<MeshFilter>())
                        if (mf.sharedMesh != null) mf.gameObject.AddComponent<MeshCollider>().sharedMesh = mf.sharedMesh;
                }
                var ground = MiniJson.Obj(MiniJson.Get(def, "ground"));
                if (ground != null)
                {
                    float size = MiniJson.F(MiniJson.Get(ground, "size")), gy = MiniJson.F(MiniJson.Get(ground, "y"));
                    ColorUtility.TryParseHtmlString(MiniJson.S(MiniJson.Get(ground, "color")), out var gc);
                    var g = GameObject.CreatePrimitive(PrimitiveType.Plane); g.name = "Ground";
                    g.transform.SetParent(z.root.transform, false);
                    g.transform.position = new Vector3(z.spawn.x, gy - 0.01f, z.spawn.z);
                    g.transform.localScale = new Vector3(size / 10f, 1, size / 10f);
                    g.GetComponent<Renderer>().material.color = gc;
                    var road = GameObject.CreatePrimitive(PrimitiveType.Cube); road.name = "Road";
                    Destroy(road.GetComponent<Collider>());
                    road.transform.SetParent(z.root.transform, false);
                    road.transform.position = new Vector3(z.spawn.x, gy, z.spawn.z - 8);
                    road.transform.localScale = new Vector3(size, 0.01f, 12);
                    road.GetComponent<Renderer>().material.color = new Color(0.23f, 0.23f, 0.24f);
                }
                z.root.SetActive(false);
                zones[z.name] = z;
            }

            foreach (var po in MiniJson.Arr(MiniJson.Get(world, "portals")))
            {
                var d = MiniJson.Obj(po);
                var p = MiniJson.Arr(MiniJson.Get(d, "pos"));
                var pt = new Portal
                {
                    zone = MiniJson.S(MiniJson.Get(d, "zone")), to = MiniJson.S(MiniJson.Get(d, "to")),
                    label = MiniJson.S(MiniJson.Get(d, "label")), radius = MiniJson.F(MiniJson.Get(d, "radius")),
                    pos = ToUnity(MiniJson.F(p[0]), MiniJson.F(p[1]), MiniJson.F(p[2])),
                };
                var a = MiniJson.Arr(MiniJson.Get(d, "arriveAt"));
                if (a != null) pt.arriveAt = ToUnity(MiniJson.F(a[0]), MiniJson.F(a[1]), MiniJson.F(a[2]));
                if (!zones.TryGetValue(pt.zone, out var zone)) continue;
                zone.root.SetActive(true);
                var floor = FloorAt(pt.pos, 1.0f);
                if (floor.HasValue) pt.pos.y = floor.Value;
                zone.root.SetActive(false);
                var ring = GameObject.CreatePrimitive(PrimitiveType.Cylinder); ring.name = "Portal to " + pt.to;
                Destroy(ring.GetComponent<Collider>());
                ring.transform.SetParent(zone.root.transform, false);
                ring.transform.position = pt.pos + Vector3.up * 1.4f;
                ring.transform.rotation = Quaternion.Euler(90, 0, 0);
                ring.transform.localScale = new Vector3(pt.radius * 1.2f, 0.02f, pt.radius * 1.2f);
                var mat = ring.GetComponent<Renderer>().material; mat.color = new Color(0.4f, 0.8f, 1f);
                var label = MakeLabel(ring.transform.parent, pt.label, new Color(0.4f, 0.8f, 1f));
                label.transform.position = pt.pos + Vector3.up * 2.7f;
                pt.ring = ring.transform;
                portals.Add(pt);
            }

            worldReady = true;
            loadStatus = "Ready";
            EnterZone("street", null, null);
        }

        // ======================================================================
        static Vector3 ToUnity(float x, float y, float z) => new Vector3(-x, y, z);
        static float[] FromUnity(Vector3 v) => new[] { -v.x, v.y, v.z };
        static float YawFromRy(float ry) => 180f - ry * Mathf.Rad2Deg;
        static float RyFromYaw(float yaw) => (180f - yaw) * Mathf.Deg2Rad;

        float? FloorAt(Vector3 p, float maxUp = 0.6f)
        {
            if (!Physics.autoSyncTransforms) Physics.SyncTransforms();
            if (Physics.Raycast(p + Vector3.up * (maxUp + 0.01f), Vector3.down, out var hit, 50f)) return hit.point.y;
            return null;
        }

        void EnterZone(string name, Vector3? at, float? ry)
        {
            if (!zones.TryGetValue(name, out var z)) return;
            foreach (var kv in zones) kv.Value.root.SetActive(kv.Key == name);
            currentZone = name;
            var p = at ?? z.spawn;
            pos = p + new Vector3(Random.Range(-1.5f, 1.5f), 0, Random.Range(-1.5f, 1.5f));
            var f = FloorAt(pos, 1.5f); if (f.HasValue) pos.y = f.Value;
            yaw = YawFromRy(ry ?? z.spawnRy); pitch = 0; vy = 0;
            cam.backgroundColor = z.sky;
            foreach (var r in remotes.Values) r.go.SetActive(r.zone == currentZone);
            SendMove(true);
        }

        // ======================================================================
        bool Key(string k)
        {
#if ENABLE_INPUT_SYSTEM
            var kb = Keyboard.current; if (kb == null) return false;
            switch (k)
            {
                case "w": return kb.wKey.isPressed; case "a": return kb.aKey.isPressed;
                case "s": return kb.sKey.isPressed; case "d": return kb.dKey.isPressed;
                case "up": return kb.upArrowKey.isPressed; case "down": return kb.downArrowKey.isPressed;
                case "left": return kb.leftArrowKey.isPressed; case "right": return kb.rightArrowKey.isPressed;
                case "shift": return kb.leftShiftKey.isPressed || kb.rightShiftKey.isPressed;
            }
            return false;
#else
            switch (k)
            {
                case "w": return Input.GetKey(KeyCode.W); case "a": return Input.GetKey(KeyCode.A);
                case "s": return Input.GetKey(KeyCode.S); case "d": return Input.GetKey(KeyCode.D);
                case "up": return Input.GetKey(KeyCode.UpArrow); case "down": return Input.GetKey(KeyCode.DownArrow);
                case "left": return Input.GetKey(KeyCode.LeftArrow); case "right": return Input.GetKey(KeyCode.RightArrow);
                case "shift": return Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);
            }
            return false;
#endif
        }

        Vector2 MouseLook()
        {
#if ENABLE_INPUT_SYSTEM
            var m = Mouse.current; if (m == null) return Vector2.zero;
            return (m.leftButton.isPressed || m.rightButton.isPressed) ? m.delta.ReadValue() * 0.15f : Vector2.zero;
#else
            return (Input.GetMouseButton(0) || Input.GetMouseButton(1)) ? new Vector2(Input.GetAxis("Mouse X"), Input.GetAxis("Mouse Y")) * 3f : Vector2.zero;
#endif
        }

        bool Blocked(Vector3 from, Vector3 dir, float dist) =>
            Physics.Raycast(from + Vector3.up * 1.1f, dir, dist + 0.35f);

        void Update()
        {
#if !UNITY_WEBGL || UNITY_EDITOR
            ws?.DispatchMessageQueue();
#endif
            if (!worldReady) return;
            float dt = Mathf.Min(Time.deltaTime, 0.05f);

            if (!chatFocus)
            {
                var look = MouseLook();
                yaw += look.x; pitch = Mathf.Clamp(pitch - look.y, -80, 80);
                if (Key("left")) yaw -= 115 * dt;
                if (Key("right")) yaw += 115 * dt;
                float f = (Key("w") || Key("up") ? 1 : 0) - (Key("s") || Key("down") ? 1 : 0);
                float s = (Key("d") ? 1 : 0) - (Key("a") ? 1 : 0);
                var rot = Quaternion.Euler(0, yaw, 0);
                var move = rot * new Vector3(s, 0, f);
                if (move.sqrMagnitude > 0)
                {
                    move = move.normalized * (Key("shift") ? 7f : 3.2f) * dt;
                    foreach (var m in new[] { move, new Vector3(move.x, 0, 0), new Vector3(0, 0, move.z) })
                    {
                        if (m.sqrMagnitude < 1e-10f) continue;
                        if (!Blocked(pos, m.normalized, m.magnitude)) { pos += m; break; }
                    }
                }
            }
            var floor = FloorAt(pos);
            if (floor.HasValue && floor.Value >= pos.y - 0.05f) { pos.y = floor.Value; vy = 0; }
            else
            {
                vy -= 18 * dt; pos.y += vy * dt;
                if (floor.HasValue && pos.y < floor.Value) { pos.y = floor.Value; vy = 0; }
                if (pos.y < -30) EnterZone(currentZone, null, null);
            }
            cam.transform.SetPositionAndRotation(pos + Vector3.up * Eye, Quaternion.Euler(pitch, yaw, 0));

            foreach (var pt in portals)
            {
                if (pt.zone != currentZone) continue;
                var d = new Vector2(pos.x - pt.pos.x, pos.z - pt.pos.z).magnitude;
                if (d < pt.radius) { EnterZone(pt.to, pt.arriveAt, null); break; }
            }

            float t = Mathf.Min(1, dt * 10);
            foreach (var r in remotes.Values)
            {
                r.go.transform.position = Vector3.Lerp(r.go.transform.position, r.target, t);
                r.go.transform.rotation = Quaternion.Slerp(r.go.transform.rotation, Quaternion.Euler(0, r.targetYaw, 0), t);
            }
            if (connected && Time.time - lastSend > 0.1f) SendMove(false);
        }

        void LateUpdate()
        {
            // Billboard all labels toward the camera.
            foreach (var tm in GetComponentsInChildren<TextMesh>())
                tm.transform.rotation = Quaternion.LookRotation(tm.transform.position - cam.transform.position);
        }

        // ======================================================================
        TextMesh MakeLabel(Transform parent, string text, Color color)
        {
            var go = new GameObject("Label"); go.transform.SetParent(parent, false);
            var tm = go.AddComponent<TextMesh>();
            tm.text = text; tm.font = font; tm.fontSize = 48; tm.characterSize = 0.05f;
            tm.anchor = TextAnchor.MiddleCenter; tm.alignment = TextAlignment.Center; tm.color = color;
            go.GetComponent<MeshRenderer>().sharedMaterial = font.material;
            return tm;
        }

        Remote MakeAvatar(int id, string name, string platform, string color)
        {
            var root = new GameObject($"Player {id} {name}"); root.transform.SetParent(transform, false);
            ColorUtility.TryParseHtmlString(color, out var c);
            var body = GameObject.CreatePrimitive(PrimitiveType.Capsule); Destroy(body.GetComponent<Collider>());
            body.transform.SetParent(root.transform, false); body.transform.localPosition = new Vector3(0, 0.75f, 0);
            body.transform.localScale = new Vector3(0.56f, 0.75f, 0.56f);
            body.GetComponent<Renderer>().material.color = c;
            var head = GameObject.CreatePrimitive(PrimitiveType.Sphere); Destroy(head.GetComponent<Collider>());
            head.transform.SetParent(root.transform, false); head.transform.localPosition = new Vector3(0, 1.55f, 0);
            head.transform.localScale = Vector3.one * 0.44f;
            head.GetComponent<Renderer>().material.color = c;
            var visor = GameObject.CreatePrimitive(PrimitiveType.Cube); Destroy(visor.GetComponent<Collider>());
            visor.transform.SetParent(root.transform, false); visor.transform.localPosition = new Vector3(0, 1.58f, 0.18f);
            visor.transform.localScale = new Vector3(0.3f, 0.1f, 0.12f);
            visor.GetComponent<Renderer>().material.color = Color.black;
            var label = MakeLabel(root.transform, $"{name}\n<size=32>{(platform == "webgl" ? "WebGL client" : platform == "unity" ? "Unity client" : platform)}</size>", Color.white);
            label.richText = true;
            label.transform.localPosition = new Vector3(0, 2.3f, 0);
            return new Remote { go = root, name = name, platform = platform, color = color, label = label };
        }

        void Upsert(Dictionary<string, object> p)
        {
            int id = (int)MiniJson.F(MiniJson.Get(p, "id"));
            if (id == myId) return;
            var a = MiniJson.Arr(MiniJson.Get(p, "p"));
            var target = ToUnity(MiniJson.F(a[0]), MiniJson.F(a[1]), MiniJson.F(a[2]));
            var zone = MiniJson.S(MiniJson.Get(p, "zone"));
            if (!remotes.TryGetValue(id, out var r))
            {
                r = MakeAvatar(id, MiniJson.S(MiniJson.Get(p, "name")), MiniJson.S(MiniJson.Get(p, "platform")), MiniJson.S(MiniJson.Get(p, "color")));
                r.go.transform.position = target; r.zone = zone;
                remotes[id] = r;
            }
            if (r.zone != zone) { r.zone = zone; r.go.transform.position = target; }
            r.target = target;
            r.targetYaw = YawFromRy(MiniJson.F(MiniJson.Get(p, "ry")));
            r.go.SetActive(r.zone == currentZone);
        }

        void RemoveRemote(int id)
        {
            if (remotes.TryGetValue(id, out var r)) { Destroy(r.go); remotes.Remove(id); }
        }

        void AddChat(string line) { chatLog.Add(line); if (chatLog.Count > 8) chatLog.RemoveAt(0); }

        // ======================================================================
        async void Connect()
        {
            wantConnect = true;
            PlayerPrefs.SetString("vwa.name", playerName);
            PlayerPrefs.SetString("vwa.server", serverUrl);
            if (!worldReady) await LoadWorld();
            if (!worldReady) return;
            if (ws != null) { var old = ws; ws = null; await old.Close(); }
            netStatus = "connecting to " + serverUrl;
            ws = new WebSocket(serverUrl);
            var me = ws;
            ws.OnOpen += () =>
            {
                connected = true; netStatus = "connected";
                Send("{\"t\":\"hello\",\"name\":" + MiniJson.Quote(playerName) + ",\"platform\":\"unity\",\"zone\":" + MiniJson.Quote(currentZone) + "}");
            };
            ws.OnMessage += bytes => HandleMessage(Encoding.UTF8.GetString(bytes));
            ws.OnError += e => netStatus = "error: " + e;
            ws.OnClose += code =>
            {
                if (ws != me) return;
                connected = false; myId = -1; netStatus = "disconnected";
                foreach (var id in new List<int>(remotes.Keys)) RemoveRemote(id);
                if (wantConnect) Invoke(nameof(Reconnect), 2f);
            };
            _ = ws.Connect(); // completes when the socket closes
        }
        void Reconnect() { if (wantConnect && !connected) Connect(); }

        void HandleMessage(string text)
        {
            var m = MiniJson.Obj(MiniJson.Parse(text));
            switch (MiniJson.S(MiniJson.Get(m, "t")))
            {
                case "welcome":
                    myId = (int)MiniJson.F(MiniJson.Get(m, "id"));
                    foreach (var p in MiniJson.Arr(MiniJson.Get(m, "players"))) Upsert(MiniJson.Obj(p));
                    AddChat($"server: Welcome to {MiniJson.S(MiniJson.Get(m, "world"))}. You are player #{myId}.");
                    SendMove(true);
                    break;
                case "join":
                    var jp = MiniJson.Obj(MiniJson.Get(m, "player"));
                    Upsert(jp);
                    AddChat($"server: {MiniJson.S(MiniJson.Get(jp, "name"))} joined from {MiniJson.S(MiniJson.Get(jp, "platform"))}");
                    break;
                case "leave":
                    int lid = (int)MiniJson.F(MiniJson.Get(m, "id"));
                    if (remotes.TryGetValue(lid, out var lr)) AddChat($"server: {lr.name} left");
                    RemoveRemote(lid);
                    break;
                case "snapshot":
                    var seen = new HashSet<int>();
                    foreach (var p in MiniJson.Arr(MiniJson.Get(m, "players")))
                    {
                        var d = MiniJson.Obj(p); seen.Add((int)MiniJson.F(MiniJson.Get(d, "id"))); Upsert(d);
                    }
                    foreach (var id in new List<int>(remotes.Keys)) if (!seen.Contains(id)) RemoveRemote(id);
                    break;
                case "chat":
                    AddChat($"{MiniJson.S(MiniJson.Get(m, "name"))}: {MiniJson.S(MiniJson.Get(m, "text"))}");
                    break;
            }
        }

        void Send(string json) { if (ws != null && ws.State == WebSocketState.Open) _ = ws.SendText(json); }

        string lastMoveKey = "";
        void SendMove(bool force)
        {
            if (!connected) return;
            var p = FromUnity(pos);
            float ry = RyFromYaw(yaw);
            var json = "{\"t\":\"move\",\"zone\":" + MiniJson.Quote(currentZone) + ",\"p\":[" + MiniJson.Num(p[0]) + "," + MiniJson.Num(p[1]) + "," + MiniJson.Num(p[2]) + "],\"ry\":" + MiniJson.Num(ry) + "}";
            if (!force && json == lastMoveKey) return;
            lastMoveKey = json; lastSend = Time.time;
            Send(json);
        }

        async void OnApplicationQuit() { wantConnect = false; if (ws != null) await ws.Close(); }

        // ======================================================================
        void OnGUI()
        {
            GUI.skin.label.fontSize = 14; GUI.skin.button.fontSize = 14; GUI.skin.textField.fontSize = 14;
            if (!wantConnect)
            {
                var r = new Rect(Screen.width / 2f - 200, Screen.height / 2f - 110, 400, 220);
                GUI.Box(r, "");
                GUILayout.BeginArea(new Rect(r.x + 16, r.y + 12, r.width - 32, r.height - 24));
                GUILayout.Label("<b><size=20>Internet Archive VR</size></b>", new GUIStyle(GUI.skin.label) { richText = true });
                GUILayout.Label("Unity client · Virtual World Archive");
                GUILayout.Label("Your name"); playerName = GUILayout.TextField(playerName, 24);
                GUILayout.Label("Server (from the world's archive page)"); serverUrl = GUILayout.TextField(serverUrl, 200);
                GUILayout.Space(8);
                if (GUILayout.Button("Enter world", GUILayout.Height(32))) Connect();
                GUILayout.EndArea();
                return;
            }
            // HUD
            GUI.Box(new Rect(10, 10, 300, 50), "");
            GUI.Label(new Rect(18, 14, 290, 22), $"{(zones.TryGetValue(currentZone, out var z) ? z.label : currentZone)}");
            GUI.Label(new Rect(18, 34, 290, 22), worldReady ? netStatus : loadStatus);

            float h = 26 + 20 * (remotes.Count + 1);
            GUI.Box(new Rect(Screen.width - 250, 10, 240, h), "In this world");
            GUI.Label(new Rect(Screen.width - 240, 32, 230, 20), $"{playerName} (you) · unity");
            int i = 1;
            foreach (var r in remotes.Values)
                GUI.Label(new Rect(Screen.width - 240, 32 + 20 * i++, 230, 20), $"{r.name} · {r.platform} · {r.zone}");

            GUI.Box(new Rect(10, Screen.height - 210, 380, 200), "");
            GUILayout.BeginArea(new Rect(18, Screen.height - 204, 364, 160));
            foreach (var line in chatLog) GUILayout.Label(line);
            GUILayout.EndArea();
            GUI.SetNextControlName("chat");
            chatInput = GUI.TextField(new Rect(18, Screen.height - 40, 364, 24), chatInput, 200);
            chatFocus = GUI.GetNameOfFocusedControl() == "chat";
            if (Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.Return)
            {
                if (chatFocus)
                {
                    if (chatInput.Trim().Length > 0) Send("{\"t\":\"chat\",\"text\":" + MiniJson.Quote(chatInput.Trim()) + "}");
                    chatInput = ""; GUI.FocusControl(null);
                }
                else GUI.FocusControl("chat");
                Event.current.Use();
            }
            GUI.Label(new Rect(Screen.width - 420, Screen.height - 30, 410, 22), "Drag mouse to look · WASD / arrows to walk · Shift to run · Enter to chat");
        }
    }
}
