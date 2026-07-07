#!/usr/bin/env python3
"""Deploy v3.2.0 + Twelve Labs SDK to VPS over SSH (password from env)."""
import os
import sys
import tarfile
import tempfile
from pathlib import Path

try:
    import paramiko
except ImportError:
    print("paramiko required", file=sys.stderr)
    sys.exit(1)

HOST = os.environ.get("VPS_HOST", "109.123.241.130")
USER = os.environ.get("VPS_USER", "root")
PORT = int(os.environ.get("VPS_PORT", "22"))
PASSWORD = (
    os.environ.get("VPS_SSH_PASSWORD")
    or os.environ.get("SSH_PASSWORD")
    or os.environ.get("VPS_PASSWORD")
    or ""
)
TL_KEY = os.environ.get("TWELVELABS_API_KEY", "")
REPO = Path(__file__).resolve().parents[1]
WORKSPACE = REPO.parent


def run(client, cmd, timeout=600):
    print(f"$ {cmd[:120]}{'...' if len(cmd) > 120 else ''}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print(err.rstrip(), file=sys.stderr)
    if code != 0:
        raise RuntimeError(f"remote exit {code}: {cmd[:80]}")
    return out


def main():
    if not PASSWORD:
        print(
            "ERROR: VPS_SSH_PASSWORD (or SSH_PASSWORD) not set in environment.\n"
            "Add it in Cursor Cloud Agent Secrets and restart the environment.",
            file=sys.stderr,
        )
        sys.exit(1)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {USER}@{HOST}:{PORT}...")
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)

    remote = "/root/cinerecap-render-server"
    run(client, f"mkdir -p {remote}/src/lib {remote}/storage/twelvelabs-cache")

    # Bundle deploy files
    files = [
        (WORKSPACE / "vps-src/index.js", "src/index.js"),
        (WORKSPACE / "vps-src/lib/twelvelabs.js", "src/lib/twelvelabs.js"),
        (WORKSPACE / "docs-export/package.json", "package.json"),
        (WORKSPACE / "docs-export/package-lock.json", "package-lock.json"),
        (WORKSPACE / "docs-export/Dockerfile", "Dockerfile"),
        (WORKSPACE / "docs-export/docker-compose.yml", "docker-compose.yml"),
        (WORKSPACE / "docs-export/start.sh", "start.sh"),
        (WORKSPACE / "docs-export/scripts/vps-setup-twelvelabs.sh", "scripts/vps-setup-twelvelabs.sh"),
    ]
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tf:
        tpath = tf.name
        with tarfile.open(tpath, "w:gz") as tar:
            for local, arc in files:
                if local.exists():
                    tar.add(local, arcname=arc)
                else:
                    print(f"WARN: missing {local}", file=sys.stderr)

    sftp = client.open_sftp()
    sftp.put(tpath, f"{remote}/deploy-bundle.tar.gz")
    sftp.close()
    os.unlink(tpath)

    run(client, f"cd {remote} && tar xzf deploy-bundle.tar.gz && rm deploy-bundle.tar.gz && chmod +x start.sh scripts/vps-setup-twelvelabs.sh 2>/dev/null || chmod +x start.sh")

    if TL_KEY:
        esc = TL_KEY.replace("'", "'\\''")
        run(
            client,
            f"cd {remote} && export TWELVELABS_API_KEY='{esc}' && bash scripts/vps-setup-twelvelabs.sh",
            timeout=1800,
        )
    else:
        run(client, f"cd {remote} && docker compose build render && docker compose up -d --force-recreate render", timeout=1800)

    out = run(client, "curl -s --max-time 15 http://localhost:4040/health")
    print("=== HEALTH ===")
    print(out)
    client.close()
    print("Deploy complete.")


if __name__ == "__main__":
    main()
