# validate-app.py — the application layer's gate.
#
# Provisions a disposable real database, applies every numbered schema
# change in order, grants the runtime role to the connecting user, runs
# the application's integration tests (vitest) against it over a real
# pooled connection, and deletes the scratch project — pass or fail.
#
# Companion to validate-chain.py, the schema layer's gate. The
# Management API requires a custom User-Agent (Cloudflare 403s the
# default one).

import json, time, urllib.request, urllib.error, secrets, string, subprocess, sys, os, glob

PAT = os.environ.get("SUPABASE_MANAGEMENT_PAT")
if not PAT:
    _env_file = os.environ.get("DEEDBOX_SECRETS_FILE")
    if _env_file:
        for line in open(_env_file, encoding="utf-8"):
            if line.startswith("SUPABASE_MANAGEMENT_PAT="):
                PAT = line.split("=", 1)[1].strip()
if not PAT:
    raise SystemExit("SUPABASE_MANAGEMENT_PAT is not set (export it, or point "
                     "DEEDBOX_SECRETS_FILE at an env file that defines it)")
H = {"Authorization": f"Bearer {PAT}", "Content-Type": "application/json",
     "User-Agent": "deedbox-app-validator/1.0"}
BASE = "https://api.supabase.com/v1"
REGION = os.environ.get("DEEDBOX_SUPABASE_REGION", "ap-southeast-2")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def req(method, path, body=None):
    # Transient gateway blips (timeouts, 5xx, resets) killed full gate runs
    # mid-suite (a read timeout at suite 23 of 48 once cost the whole
    # provision-and-validate cycle). Every call here is repeat-safe, so
    # transient failures retry with a widening pause.
    import socket
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for attempt in range(4):
        r = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=H)
        try:
            with urllib.request.urlopen(r, timeout=180) as resp:
                t = resp.read()
                return json.loads(t) if t else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:400]
            if e.code in (500, 502, 503, 504) and attempt < 3:
                last = f"HTTP {e.code}: {detail}"
            else:
                raise SystemExit(f"{method} {path} -> HTTP {e.code}: {detail}")
        except (TimeoutError, socket.timeout, urllib.error.URLError, ConnectionError, OSError) as e:
            if attempt == 3:
                raise SystemExit(f"{method} {path} -> {e} (after retries)")
            last = str(e)
        wait = 15 * (attempt + 1)
        print(f"  transient ({last}) — retrying in {wait}s", flush=True)
        time.sleep(wait)

orgs = req("GET", "/organizations")
org = os.environ.get("DEEDBOX_SUPABASE_ORG")
if not org:
    if len(orgs) != 1:
        raise SystemExit(
            "set DEEDBOX_SUPABASE_ORG: this account has "
            f"{len(orgs)} organisations ({[o['id'] for o in orgs]}), and this "
            "script creates a real, billable project — it will not guess")
    org = orgs[0]["id"]
pw = "Db" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(28)) + "9x"

print(f"creating scratch project in org {org}...")
proj = req("POST", "/projects", {
    "name": "deedbox-scratch-app", "organization_id": org,
    "region": REGION, "db_pass": pw, "plan": "free"})
ref = proj["id"]
print(f"scratch ref: {ref}")

for i in range(40):
    time.sleep(15)
    st = req("GET", f"/projects/{ref}")
    print(f"  status: {st.get('status')}")
    if st.get("status") == "ACTIVE_HEALTHY":
        break
else:
    raise SystemExit("project never became healthy")

time.sleep(15)  # pooler propagation

def run_sql(q, label):
    out = req("POST", f"/projects/{ref}/database/query", {"query": q})
    print(f"{label}: OK -> {json.dumps(out)[:120]}")

exit_code = 1
try:
    changes = sorted(glob.glob(os.path.join(REPO, "schema", "changes", "*.sql")))
    if not changes:
        raise SystemExit("no schema change files found")
    for path in changes:
        run_sql(open(path, encoding="utf-8").read(), f"APPLY {os.path.basename(path)}")

    # The scratch's login role must be able to step down to the runtime role,
    # exactly as a production runtime login role is set up at deployment.
    run_sql("grant deedbox_app to postgres;", "GRANT runtime role")

    url = f"postgresql://postgres.{ref}:{pw}@aws-0-{REGION}.pooler.supabase.com:5432/postgres"
    env = dict(os.environ)
    env["DEEDBOX_DATABASE_URL"] = url
    print("running application tests (vitest)...")
    r = subprocess.run("npm test", shell=True, cwd=REPO, env=env)
    exit_code = r.returncode
    print(f"vitest exit: {exit_code}")
finally:
    print("deleting scratch project...")
    try:
        req("DELETE", f"/projects/{ref}")
        print("scratch deleted.")
    except SystemExit as e:
        print(f"WARNING: scratch deletion failed ({e}) — delete {ref} manually.")

sys.exit(exit_code)
