# Local Supabase network exposure

Measured against Supabase CLI **2.117.0** on Windows 11 with Docker Desktop.

## The claim that was wrong

An earlier Stage 0 report said "nothing was exposed beyond the host". That was
incorrect, and it was stated on the basis that `supabase status` prints
loopback URLs. What `supabase status` prints is the address you are told to
*connect to*, not the address the container is *published on*. They are not the
same thing, and the difference is the whole issue.

## What is actually true

Every published port is bound to `0.0.0.0` — all interfaces:

```
supabase_kong_kiasa       0.0.0.0:54321->8000/tcp, [::]:54321->8000/tcp
supabase_db_kiasa         0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp
supabase_studio_kiasa     0.0.0.0:54323->3000/tcp, [::]:54323->3000/tcp
supabase_inbucket_kiasa   0.0.0.0:54324->8025/tcp, [::]:54324->8025/tcp
supabase_analytics_kiasa  0.0.0.0:54327->4000/tcp, [::]:54327->4000/tcp
```

Measured by connecting to each host interface in turn — every port answered on
every non-loopback address, including the machine's LAN address:

```
198.18.192.77   54321 54322 54323 54324 54327   all OPEN
192.168.100.28  54321 54322 54323 54324 54327   all OPEN   <- LAN
192.168.206.1   ... all OPEN   (VMware VMnet1)
192.168.226.1   ... all OPEN   (VMware VMnet8)
172.21.224.1    ... all OPEN   (Hyper-V Default Switch)
172.19.64.1     ... all OPEN   (WSL)
```

Port **54322 is Postgres**, and the local stack's credentials are
`postgres:postgres` — identical on every machine and published in Supabase's
own documentation. Anything that can route to this host can open a superuser
connection to the development database.

Whether a *remote* host can complete that connection also depends on the host
firewall. On this machine it can: both active interfaces are categorised
**Public**, and the Public firewall profile is **disabled**.

```
Name      Enabled   DefaultInboundAction
Domain    True      NotConfigured
Private   False     NotConfigured
Public    False     NotConfigured
```

So on an untrusted network — a café, a coworking space, a conference — the
development database is reachable by anyone on the same segment. This is a real
exposure, not a theoretical one.

## Why the repository cannot fix it

There is **no supported configuration key** in Supabase CLI 2.117.0 that sets
the host bind address for local containers. This was checked against the
CLI's own generated template (`supabase init` with 2.117.0), which is the
authoritative list of what the version accepts. The only host-facing keys are
`port` values. Nothing named `bind_address`, `bind_ip`, `host_ip`,
`listen_address` or equivalent exists.

Two keys look relevant and are not:

* **`[db.network_restrictions] allowed_cidrs = ["0.0.0.0/0"]`** — flagged in
  review as "unrestricted database CIDRs". These are the stock template
  defaults and they configure the **hosted** project's network restrictions,
  applied through the management API. They have no effect on local container
  binding. The block is also `enabled = false`. Setting them to a narrower CIDR
  would change nothing locally and would be misleading to a reader.

* **`[realtime] ip_version`** — selects IPv4 or IPv6 for realtime's own
  binding. It does not control the Docker publish address.

Inventing a key here would be worse than the exposure: it would read as solved
in review while behaving identically.

## Mitigations that do work

Both are machine-level, outside the repository. Neither is applied
automatically, because both change behaviour for every container on the
machine, not only this project.

### 1. Docker: make loopback the default publish address (recommended)

The Docker daemon supports a default host IP for published ports that do not
name one. Supabase CLI does not name one, so this covers the whole stack.

Edit `%USERPROFILE%\.docker\daemon.json` (Docker Desktop → Settings → Docker
Engine) and add the `ip` key:

```json
{
  "builder": { "gc": { "defaultKeepStorage": "20GB", "enabled": true } },
  "experimental": false,
  "ip": "127.0.0.1"
}
```

Apply & Restart, then `npm run db:stop && npm run db:start`. Ports then publish
as `127.0.0.1:54321->8000/tcp`.

This does not affect container-to-container traffic: Kong reaching Postgres,
Studio reaching pg-meta and so on all run over the project's internal Docker
network and never touch the published host ports. The test suites connect over
loopback and `docker exec`, so they are unaffected.

Trade-off: any container you deliberately want reachable from another device
(previewing a dev server on a phone, for example) then needs an explicit
`-p 0.0.0.0:PORT:PORT`.

### 2. Windows Firewall: block the ports inbound

Rules are only enforced while the profile they apply to is enabled, so the
first command is not optional on this machine — the Public profile is
currently off.

```powershell
# Run as Administrator.
Set-NetFirewallProfile -Profile Public,Private -Enabled True

New-NetFirewallRule -DisplayName "Block Supabase local stack (inbound)" `
  -Direction Inbound -Action Block -Protocol TCP `
  -LocalPort 54321-54329 -Profile Public,Private
```

Loopback traffic is not filtered by Windows Firewall, so local development and
every test suite continue to work.

Verify with the diagnostic:

```
npm run check:exposure
```

## Why this is not a CI gate

`scripts/check-local-exposure.mjs` reports; it does not fail the build. A gate
would fail on every developer machine and on the CI runner alike, because the
condition it would assert cannot be satisfied by anything in this repository —
and a check that every clean checkout fails is one that gets disabled. It is a
diagnostic, and this document is the honest statement of the residual risk.
