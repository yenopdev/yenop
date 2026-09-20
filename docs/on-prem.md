# Running Yenop on-premises

Written for: a customer's operations or security engineer installing Yenop on machines they control. It assumes no internet on the target and no trust in outside services.

Yenop is built to run this way. It is a command-line program and a local daemon: files on disk, a decision service on `127.0.0.1`, records in `~/.yenop`. Nothing it does requires a network or a cloud account. Installing it on-prem means installing it on the machines where your agents run: developer laptops, build runners, or a shared server.

## What ships and where data lives

- The program is Node.js. The only third-party piece is the Cedar policy engine, a WebAssembly module that runs in-process. No database server, no external calls.
- Every decision is written to `~/.yenop/receipts.jsonl`, a plain append-only file on the same machine. Run state is a local SQLite file. Policies are files you own.
- Yenop never sends anything off the machine. There is no telemetry.

## Install with no internet (air-gapped)

On a build machine that has internet, produce a self-contained bundle:

```sh
npm run pack:offline
```

This creates `yenop-offline-<version>.tgz` (about 4 MB) containing the built code, the baseline policies, and the Cedar engine already resolved. Copy it to the target. The target needs only Node.js 20 or newer.

On the target, no npm registry is touched. The bundle's `INSTALL.txt` has the exact steps; the short version, for locked-down machines that would rather not use npm at all:

```sh
tar -xzf yenop-offline-<version>.tgz
sudo mv yenop /opt/yenop
sudo ln -s /opt/yenop/dist/cli/main.js /usr/local/bin/yenop
sudo chmod +x /opt/yenop/dist/cli/main.js
yenop --help && yenop demo
```

Then set up a project with `cd your-project && yenop init`.

## Keeping the daemon alive

The command hook decides in-process, so Yenop is safe without a running daemon. The daemon makes decisions faster and is what the HTTP hook needs. Hand it to the operating system's supervisor:

```sh
yenop service install
```

- macOS: a launchd agent.
- Linux: a systemd user service. On a headless server, also let it run after logout:

```sh
loginctl enable-linger "$USER"
```

The unit invokes Node by absolute path, because launchd and systemd run with a minimal PATH. If you upgrade Node to a new major version, run `yenop service install` again.

For a system-wide service that runs as a service account instead of per-user, install a system unit that runs `node /opt/yenop/dist/cli/main.js daemon run` with `YENOP_HOME` set to that account's home. `yenop service show` prints a unit you can adapt.

## Platform support, stated plainly

- **macOS**: supported and verified, including the supervised service.
- **Linux**: supported. The systemd unit is generated and validated; verify the supervised service on your distribution during the pilot, since we test the unit's contents but cannot test every init setup for you. The command hook and the CLI work anywhere Node runs.
- **Windows**: not supported yet. The test suite runs on Windows in CI and file, MCP and path checks work there, but the shell parser understands POSIX shells and only Windows *paths*, not PowerShell or cmd syntax, and there is no service integration. Do not rely on Yenop for Windows shell commands until that lands. If you need it, tell us; it moves up the list with a customer asking.

## Sending receipts to your SIEM

Receipts are a plain JSON-per-line file, so your existing log agent can tail `~/.yenop/receipts.jsonl` today, with no change to Yenop. Each line is one decision, with the tool, the effect, the reasons, the tenant, and a timestamp; outcome lines record what a person answered. A native push to a collector you host is a small addition when a pilot needs it; it belongs to the paid team layer, and it never sends data anywhere you did not configure.

## Upgrades

Replace the files (a new bundle, or `npm install -g` the new version) and rebuild is not needed on the target: the bundle is already built. A running daemon notices its own code changed and restarts itself; under the supervisor that restart is automatic. Policies and receipts are untouched by an upgrade.
