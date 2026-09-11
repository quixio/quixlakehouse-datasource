# Deploying Grafana with the QuixLakeHouse datasource

A self-contained Grafana image with the plugin baked in, runnable locally and
deployable to Quix Cloud from the same artifact.

**Unsigned plugins load fine on self-hosted Grafana**, and a Quix deployment is
self-hosted. So this path needs nothing from Grafana Labs — no signature, no
catalog submission, no review queue. That only becomes necessary for Grafana Cloud.

## Contents

| File | Purpose |
| --- | --- |
| `Dockerfile` | 3-stage build: frontend → Go backend → stock Grafana with both baked in |
| `entrypoint.sh` | Restores Grafana's database from the state volume if it passes an integrity check, seeds the datasource when that database has no datasource row, starts the 10-second backup loop, then execs Grafana |
| `provisioning/datasources/quixlakehouse.yml.tpl` | Datasource template with `__PLACEHOLDER__` tokens |
| `../app.yaml` | Quix application descriptor (at repo root, so the build context is the repo) |

## Why the plugin is baked in

Rather than `GF_INSTALL_PLUGINS` with a GitHub release URL: Quix environments are
not guaranteed egress to GitHub — the lakehouse images already bake DuckDB
extensions for air-gapped clusters — so downloading at boot would add a runtime
dependency on the internet. Baking makes the boot deterministic.

## Which credentials, and why

The datasource needs two values:

| Value | Env var |
| --- | --- |
| Query API base URL | `Quix__Lakehouse__Query__Url` |
| Bearer token | `Quix__Lakehouse__Query__AuthToken` |

Two traps, both already paid for elsewhere:

1. **Not `Quix__Sdk__Token`.** The Query Engine runs cluster-global in
   `quixdev-global` and rejects cross-environment SDK tokens — the same wall the
   billing integration hit, which is why the dev billing sink ended up running
   with auth disabled. `Quix__Lakehouse__Query__AuthToken` is minted for this.
2. **Not `CATALOG_URL` / `QUIX_LAKE_URL`.** Those are legacy aliases for the
   *in-cluster Iceberg catalog*, not the public Query API, and will not serve
   `/query`.

On **dev**, both inject only when the deployment has `blobStorage: bind: true` —
even though Grafana never touches blob storage. The bind is the injection vehicle
for the whole lakehouse bundle. On **BYOX**, nothing auto-injects; declare them as
deployment variables. `entrypoint.sh` aborts at boot with this explanation rather
than starting a Grafana whose datasource silently cannot connect.

## Stage 1 — local, against the local integration stack

Proves the Dockerfile, the entrypoint's rendering, the provisioning template and
unsigned plugin loading. No platform credentials needed.

```bash
# 1. Bring up the lakehouse stack in the Quix.DataLake.Timeseries repo:
docker compose -f docker-compose.integration-test.yml up -d api

# 2. Build this image from the repo root (NOT from deploy/):
docker build -f deploy/Dockerfile -t quixlakehouse-grafana:dev .

# 3. Run it on the integration network so it can reach the API by name:
docker run -d --name quixlakehouse-grafana \
  --network quixdatalaketimeseries_test-network \
  -p 3003:3000 \
  -e QUIXLAKE_URL=http://api:80 \
  -e QUIXLAKE_TOKEN=test-token-123 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  quixlakehouse-grafana:dev

# 4. The check that matters -- server-side, the call a frontend-only plugin cannot serve:
curl -s -u admin:admin -X POST \
  http://localhost:3003/api/datasources/uid/quixlakehouse/health
```

Expect `{"status":"OK", ...}`. Port 3003 avoids 3001 (integration stack Grafana)
and 3002 (`docker-compose.dev.yml`).

> When querying, use **partition-filtered** SQL with a `LIMIT`. Wide scans against
> a long-running local stack fail on blob-storage connection exhaustion after the
> sink has produced thousands of 1 MB files — a harness artefact, not a plugin bug.

## Stage 2 — local, against the real dev lakehouse

Same image, real credentials. This retires the auth risk before any deployment
exists, so a later failure is unambiguously about injection or ingress.

```bash
docker run -d --name quixlakehouse-grafana-dev \
  -p 3003:3000 \
  -e QUIXLAKE_URL='https://<current-lh-query-host>' \
  -e QUIXLAKE_TOKEN='<Quix__Lakehouse__Query__AuthToken>' \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  quixlakehouse-grafana:dev
```

Get both from the lakehouse deployment's variables in the Quix portal, or via the
`quix` CLI. Do not reuse the URL in `quix-ts-datalake-ui/svelte-app/.env` — it is
stale and its host 404s at the ingress.

## Stage 3 — deploy to Quix Cloud

`app.yaml` declares the bind and the variables. In `quix.yaml`, the deployment
block needs the bind as a sibling of `variables`, not inside it:

```yaml
  - name: quixlakehouse-grafana
    application: quixlakehouse-grafana
    deploymentType: Service
    version: latest
    resources:
      cpu: 500
      memory: 1000
      # Keep this at 1. The state volume is not safe for two containers writing it --
      # see "Persistence" below.
      replicas: 1
    publicAccess:
      enabled: true
      urlPrefix: grafana
    network:
      serviceName: grafana
      ports:
        - port: 80
          targetPort: 3000
    variables:
      - name: GF_SECURITY_ADMIN_PASSWORD
        inputType: Secret
        value: grafana_admin_password
      - name: GF_SECURITY_SECRET_KEY
        inputType: Secret
        value: grafana_secret_key
      - name: GF_SERVER_ROOT_URL
        inputType: FreeText
        value: https://grafana-<workspace>.deployments-dev.quix.io
    blobStorage:
      bind: true
    # Required for persistence. Without it Quix does not inject
    # Quix__Deployment__State__Path, and the entrypoint has nowhere to copy the
    # Grafana database to -- see "Persistence" below.
    state:
      enabled: true
      size: 1
```

Watch the `port` / `targetPort` mapping: Grafana listens on 3000, and a mismatch
here produces silent timeouts rather than an error — the same class of trap the
Flight server documents for `FLIGHT_SQL_PORT`.

## Persistence

**What survives:** the whole Grafana database — the datasource URL and token as
edited in Connections > Data Sources, plus dashboards, alert rules, users, API keys
and everything else Grafana keeps in SQLite.

**How:** `entrypoint.sh` snapshots `/var/lib/grafana/grafana.db` to
`<state>/grafana/grafana.db` **every 10 seconds**, and restores it before Grafana
starts on the next boot. The loop is a background child started before the entrypoint
execs Grafana; it survives the exec and runs until the container stops.

**The snapshot is taken with SQLite's online backup API, not `cp`.** This is the part
to not "simplify" later. A `cp` of a live database is check-then-act however it is
guarded: a write transaction starting while `cp` reads mixes pre- and post-transaction
pages, and the result is a file that opens fine and then fails `PRAGMA
integrity_check`. Measured on this image, with a `grafana.db-journal` guard in front of
it, `cp` produced a malformed copy in **2 of 118 attempts (~1.7%) at Grafana's idle
write rate**, and in 6 of 18 and 17 of 25 attempts under load — and a malformed copy
restored on the next boot crash-loops Grafana into re-restoring the same file forever.
`sqlite3 <db> ".backup <dest>"` is safe against concurrent writers by construction and
measured 12 of 12 clean against a continuous writer. That is why the deploy image
installs `sqlite`; if the binary is ever missing at runtime the entrypoint logs loudly
and turns persistence **off** rather than falling back to `cp`.

The image also installs `coreutils`, for one binary: **GNU `timeout`**, which every copy
in the loop is wrapped in. BusyBox's `timeout` applet — the base image's default — forks
a watchdog and leaves it behind, and the entrypoint `exec`s Grafana, so PID 1 is a Go
binary that reaps nothing. Each tick then leaked three unreapable zombies: 60 in 12
seconds when measured, filling the PID table in hours, after which `fork()` fails and
the backup loop dies while Grafana carries on serving. GNU `timeout` waits in-process
and orphans nothing (0 zombies, holding). Do not drop `coreutils` from the runtime
stage.

**Both directions are integrity-checked.** Every snapshot is verified before it
replaces the copy on the volume, and the copy is verified again before it is restored;
only a result of exactly `ok` is accepted. Both checks run on container-local disk,
because a database cannot be *opened* on the CIFS volume at all (below) — the snapshot
is taken locally and then copied over, and the restore is copied down and checked
before it is moved into place. The transfer goes to a `.tmp` beside the target and is
renamed, so a restore never reads a half-written file. **That `.tmp` is named after the
container's hostname** — `grafana.db.tmp.<hostname>` — because locking on this volume
may not work at all, and with one shared name two containers write the same path from
offset 0 and each renames the interleaved result over `grafana.db`; the integrity check
ran on the local snapshot and would never see it. Staging files left by a container
that died mid-copy are deleted at the next boot. Every sqlite3 call carries a 10-second
busy timeout, so a snapshot's read lock makes Grafana's concurrent writes
*wait* rather than fail with `database is locked`. Stale `-journal`, `-wal` and `-shm`
files are deleted before a restored database is moved into place: a `docker restart`
reuses the writable layer, and a hot journal belonging to the previous database would
otherwise roll foreign pages into the file that was just restored.

Every file written along the way — the staged snapshot, the `.tmp` on the volume and the
restored live database — is `chmod 600`, because each is a whole Grafana database
carrying the encrypted API token. A CIFS mount will very likely ignore the mode, which
is exactly why `GF_SECURITY_SECRET_KEY` (below) is the control that actually travels
with the file.

**A tick whose database has not changed is skipped**, size and mtime compared against
the last copy — three full passes over the file every ten seconds for a Grafana nobody
is editing is pure CIFS traffic. The first tick after boot always runs.

**The `flock` is best effort, and is probed at startup rather than assumed.** It is
taken on the same CIFS-backed volume this design documents as unable to grant SQLite's
locks, so trusting it would be the one assumption we already know not to make. At
startup the entrypoint takes the lock and checks that a second, independent process is
refused it; only then do ticks bother taking it. If `flock` is missing, errors, or the
share accepts the call and enforces nothing, it says so and **keeps backing up without
the lock** — and a tick that cannot take a lock it does use **still copies**, logging
once. That direction is deliberate: a lock failure must never be able to disable
backups, because a container that persists nothing for its whole life is the harm this
loop exists to prevent, and it is the harm the previous, cleverer arrangement actually
caused.

**Run a single replica. The state volume is not safe for concurrent writers.** Quix
state is shared between replicas, and an overlapping redeploy puts two containers on
the same volume for a few seconds. Nothing here prevents them clobbering each other:
the lock may not exist, and even when it does it only makes them take turns, so the
outgoing container's next tick writes its now-stale database over the incoming one's
edits. The staging path is per host, so a *torn* copy is not a failure mode — what you
can lose is whole snapshots, up to and including the last edits made in the outgoing
container before the handover. Closing that properly needs a fencing protocol
(generation numbers, or a lease the writer must renew) and is deliberately out of
scope; an ownership marker that tried to approximate one was written and removed
because it stopped backups permanently in the case it was meant to protect. Keep
`replicas: 1`, and do not make a datasource or dashboard edit in the same breath as a
redeploy.

A failing backup is warned about on its first failure and then **re-announced roughly
every 30 minutes** with its consecutive-failure count, so a volume that fills or goes
read-only at hour three is not reported only once at hour three. The recovery line says
how many ticks were missed.

**A copy that fails its integrity check is not restored.** It is renamed aside to
`<state>/grafana/grafana.db.corrupt-<UTC timestamp>`, the path is logged, and Grafana
starts with a fresh database. Backups stay **on**: there is nothing left to protect
once the copy is known bad, so a sound one replaces it within ten seconds. A copy that
cannot be *read* at all is the other case — nothing is known about it, so backups are
switched **off** for that container rather than overwriting a possibly-good copy with
the empty database Grafana is about to create.

**Every path that starts "with an empty database" clears the container-local one
first**, along with its `-journal`, `-wal` and `-shm` files. A `docker restart` reuses
the writable layer, so without that Grafana reopens the very database the boot just
refused — quarantined, unreadable or skipped — while the only good copy has been renamed
aside, and the log line claiming a fresh start is false.

On the three **failure** paths that database is moved aside rather than deleted, to
`grafana.db.previous` **with its journals**, because those paths fire exactly when the
volume is misbehaving and the local file may be the newer — or the only — good one. The
rescue slot is **write-once**: an existing `grafana.db.previous` is never overwritten,
and the boot log says so, naming the file. The first rescue is the one that may hold
real data, while a second failed boot would only be rescuing the empty database Grafana
created after the first, so overwriting it is precisely how a rescue gets destroyed. It
lives on container-local disk and goes when the container does — copy it out if you need
it. The **successful restore** path deletes instead and keeps nothing: the file it
removes is being replaced by a verified copy of itself, and that path runs on every
normal boot, so rescuing there is what would spend the slot.

**Quarantined copies are pruned to the newest three.** `grafana.db.corrupt-*` and
`grafana.db.skipped-*` are whole databases on a volume provisioned at 1 GB, so each
time one is written the older ones beyond the newest three are deleted and the deletion
is logged. Copy anything you intend to keep off the volume.

**Why a copy and not the live database.** The obvious move — point `GF_PATHS_DATA` at
the state mount — does not work and will waste a day if you retry it. The volume is
CIFS-backed and cannot grant the exclusive POSIX locks SQLite needs, so Grafana loops
forever on its first migration with `SQLITE_BUSY` and never listens. Proven three
times on the real deployment. Ordinary reads, writes, `cp` and `mkdir` on that volume
all work fine; only SQLite's live locking fails. So the database stays on
container-local disk and only a copy of the file travels.

**The failure window.** There is **no copy at shutdown**. Every stop — a graceful
`docker stop`, a Quix redeploy, an OOM kill, node loss — loses whatever changed since
the last periodic copy, so **up to 10 seconds**. That is acceptable because of what is
being persisted: a datasource URL and an API token typed once, and dashboards and
alert rules edited by hand. Ten seconds after saving any of those, it is on the
volume; nobody saves a datasource and redeploys in the same breath, and if they do,
they retype one field. Buying the last ten seconds back meant supervising Grafana
from the entrypoint instead of exec'ing it, which was tried and reversed — the
shutdown copy never actually ran (`su` does not forward signals to its child, and the
supervising shell died inside its own trap), so the mechanism that was supposed to
guarantee zero loss was in practice writing nothing at all.

**The first snapshot is taken ten seconds in, not at boot.** It used to be taken before
the loop's first sleep, which dropped its read lock into the middle of Grafana's
startup migration and provisioning burst — the densest write window of the container's
life — and made those writes fail. A container stopped inside its first ten seconds
therefore leaves what the *previous* container backed up, which is all it had anyway:
nothing has been typed into this one yet.

**State must be enabled on the deployment.** The entrypoint reads
`Quix__Deployment__State__Path`, which Quix injects only when the deployment has
`state: enabled: true` — and that declaration lives in the *pipeline* repo's
`quix.yaml`, not in this repo's `app.yaml`. Without it there is nowhere to copy to,
so persistence silently does not happen: Grafana logs a warning at boot and runs with
the old behaviour, re-seeding the datasource from the environment every time and
forgetting everything else. This is deliberately a warning and not a fatal error —
an earlier version aborted here and took the deployment down.

**When the datasource is seeded.** The entrypoint asks the database it is about to hand
Grafana whether it already holds a datasource with uid `quixlakehouse`, and renders the
provisioning template only when it does not. The question is deliberately about the
row, not about whether a database was restored: a snapshot taken in the seconds before
Grafana committed that row restores clean and passes its integrity check while
containing no datasource at all, and gating on the restore left such a deployment
permanently without one — as did deleting the datasource in the UI. A query error also
counts as "not there" and seeds, because re-seeding a datasource that does exist costs
one UI edit, while failing to seed one that does not leaves nothing to query with.

When it decides not to seed, it also **deletes whatever is already in
`<provisioning>/datasources/`**. Not rendering a file is not the same as there being no
file: a `docker restart` reuses the writable layer, so the copy rendered on a previous
boot is still there and Grafana re-applies it, overwriting exactly the UI edits this
rule exists to protect. Deleting it does not delete the datasource — Grafana only
removes what a `deleteDatasources` block names.

`QUIXLAKE_FORCE_PROVISION=true` re-seeds the datasource from the environment on the
next boot even when the row is present, overwriting UI edits. It is the way back from a
datasource edited into a broken state.

`QUIXLAKE_SKIP_RESTORE=true` (`1`, `yes`, `on` also work) skips the restore entirely
and starts from an empty database. It is the way out of a copy that passes its
integrity check but still wedges Grafana — a half-applied migration, say. The copy is
**renamed aside** to `grafana.db.skipped-<UTC timestamp>` first, so the first boot
without the flag does not restore the very database that was escaped.

**It also turns persistence off for every boot on which it is set**, so treat it as a
single-boot flag: clear it and restart. Backups used to stay on, and that lost data —
each boot with the flag still set wrote a fresh copy and quarantined it on the next
boot, and only the three newest quarantined copies are kept, so the one copy holding
real data aged out on the fourth boot. It is a deployment variable and survives
redeploys, so "left set" is the ordinary case rather than a corner one. With backups off
there is no new copy to quarantine and nothing that can push the good one out; the cost
is a Grafana that saves nothing while the flag is set, which the boot log says twice and
which is otherwise invisible from the UI.

### `GF_SECURITY_SECRET_KEY` is required, and must be set before the first boot

Grafana encrypts `secureJsonData` — which is where the lakehouse API token lives — with
`security.secret_key`, and its built-in default is published in Grafana's own
`conf/defaults.ini`. A token encrypted with the default key is recoverable by anyone
who can read the database file, and that file now sits on a shared state volume instead
of only inside the container. So `app.yaml` declares `GF_SECURITY_SECRET_KEY` with
`required: true`; set it to any long random string.

**Before the first boot.** Changing the key later re-encrypts nothing: secrets already
written with the old key become undecryptable, and the datasource token has to be
re-entered in Connections > Data Sources. The entrypoint warns at boot when the key is
unset while persistence is on — a warning, not a refusal to start, because a fatal
check on a missing variable took this deployment down once already.

### The image starts as root, and drops to uid 472 before Grafana

`deploy/Dockerfile` declares **no `USER 472`**, deliberately: the Quix state volume is
mounted owned by root, and only root can create the Grafana directory on it and copy
the database in and out. The entrypoint runs as root, does that work, and then drops to
uid 472 with `su` immediately before starting Grafana — so the server itself is
unprivileged, exactly as in the stock image.

Two consequences for anyone running this image outside Quix:

- **A cluster enforcing `runAsNonRoot: true`, or the restricted Pod Security Standard,
  will refuse to start it.** The image's declared user is root and nothing in the pod
  spec can see that the entrypoint gives that up a second later. Either grant this
  workload an exception, or run it without the state volume — it boots fine as uid 472
  with `--user`, it just has nowhere to persist to and behaves as it did before.
- **Overriding the entrypoint lands you as root.** `docker exec`, a compose `command:`
  or a Kubernetes `command:` all bypass the `su`, so whatever they start runs
  privileged.

This is intended behaviour rather than an oversight, but the image is published, so the
default is documented here.

### The admin password can no longer be rotated through Quix

`GF_SECURITY_ADMIN_PASSWORD` is applied only when Grafana **creates** the admin user,
on the first boot against an empty database. Now that the database persists, changing
that secret in Quix and redeploying has **no effect** — the user already exists, and a
leaked admin password cannot be rotated that way. Rotate it in the Grafana UI
(profile > change password), or from a shell in the running container:

```bash
grafana cli --homepath /usr/share/grafana admin reset-admin-password '<new-password>'
```

`grafana cli`, not `grafana-cli`: the Grafana image ships a single `grafana` binary and
there is no `grafana-cli` in it, so the older spelling fails with "not found".

Keep the Quix secret in step with whatever you rotate to, so that a state volume which
is ever wiped comes back with the password you expect.

Dashboards and alert rules can still be provisioned as code instead — drop them in
`deploy/provisioning/dashboards/` and `deploy/provisioning/alerting/`, which the
entrypoint copies through on every boot. That keeps them in git, which is a better
home for them than a database copy regardless of this mechanism.
