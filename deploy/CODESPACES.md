# Free one-click hosting on GitHub Codespaces

The quickest free way to put Virtual World Archive online. Codespaces runs the full Docker Compose stack, including the per-world game servers and databases, and gives you a public HTTPS link. All you need is a GitHub account.

## Start it

1. Open <https://codespaces.new/lxpk/VirtualWorldArchive?quickstart=1> and click **Create new codespace**. The default 2-core machine is enough.
2. Wait 2 to 4 minutes. The codespace installs Docker, builds the stack, starts the VR Archive world server, and makes port 8080 public.
3. The terminal prints a box with the site URL (`https://<codespace-name>-8080.app.github.dev/`) and the admin login. Share that URL. It's HTTPS, so VR headsets can use WebXR.

If you missed the output, run `bash .devcontainer/start.sh` again in the codespace terminal. The log is in `/tmp/vwa-start.log`.

## Keep it running for a demo

- A codespace **stops after 30 minutes without activity in the editor**, and the link stops working until you reopen it. For a demo, raise the limit to 4 hours at <https://github.com/settings/codespaces> (**Default idle timeout**). Reopening a stopped codespace restarts the stack automatically.
- Personal accounts get 120 free core-hours a month, which is 60 hours on a 2-core machine. Stop the codespace when you're done (<https://github.com/codespaces>, then **⋯ > Stop codespace**).
- If the port didn't become public automatically, open the **Ports** tab, right-click port 8080, and choose **Port Visibility > Public**.

For an always-on host, see [oracle/README.md](oracle/README.md).
