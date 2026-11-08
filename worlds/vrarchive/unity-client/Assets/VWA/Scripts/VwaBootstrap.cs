// Creates the VWA client automatically when you press Play in any scene, so the
// project needs no hand-made scene. Add a VwaClient to a scene yourself to
// configure serverUrl in the Inspector instead.
using UnityEngine;

namespace Vwa
{
    public static class VwaBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Init()
        {
            if (Object.FindFirstObjectByType<VwaClient>() != null) return;
            var go = new GameObject("Virtual World Archive Client");
            go.AddComponent<VwaClient>();
        }
    }
}
