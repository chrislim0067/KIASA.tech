# Local Supabase network exposure

Supabase CLI **2.117.0**, Docker Desktop **29.5.3**, Windows 11.

This document separates three things that are easy to blur together, and the
blurring is what made its previous version wrong:

* **Measured** — observed on this machine, with the command that produced it.
* **Documented expectation** — what Docker's documentation says a setting does.
* **Unverified** — plausible, not demonstrated. Never write this as fact.

---

## 1. The claim that was wrong, twice

**First error.** An early Stage 0 report said "nothing was exposed beyond the
host", reasoning from `supabase status` printing loopback URLs. `supabase
status` prints the address you are told to *connect to*. It says nothing about
the address the container is *published on*. Those are different facts.

**Second error.** The correction then recommended a top-level Docker daemon
key and asserted it fixed the whole stack:

```json
{ "ip": "127.0.0.1" }
```

with the words "Supabase CLI does not name one, so this covers the whole
stack" and "Ports then publish as `127.0.0.1:54321->8000/tcp`". Both were
**unverified**. The second states a measurement that was never taken.

The top-level `ip` key sets the default host binding address, and it is
observable on the **default bridge** network:

```
$ docker network inspect bridge --format '{{json .Options}}'
{"com.docker.network.bridge.default_bridge":"true", ...
 "com.docker.network.bridge.host_binding_ipv4":"0.0.0.0", ...}
```

*(measured)* — the option exists there and is currently the wildcard.

Supabase does not use the default bridge. Docker Compose creates a
**user-defined** bridge network per project, `supabase_network_<project_id>`.
On this machine an unrelated user-defined bridge carries no such option at all:

```
$ docker network inspect githubmailscaaner_default --format '{{json .Options}}'
{"com.docker.network.enable_ipv4":"true","com.docker.network.enable_ipv6":"false"}
```

*(measured)* — no `host_binding_ipv4` key is present on a user-defined network.

So the top-level `ip` key is **not evidence** that ports on Supabase's
user-defined network bind to loopback. That is the defect this rewrite fixes.

---

## 2. The documented mechanism for user-defined networks

For networks created *after* the setting is applied, Docker documents
per-driver defaults:

```json
{
  "default-network-opts": {
    "bridge": {
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
    }
  }
}
```

Reference:
<https://docs.docker.com/engine/network/port-publishing/#setting-the-default-bind-address-for-containers>

Three caveats, and all three matter here:

1. **It applies at network-creation time.** A network that already exists keeps
   the options it was created with. Changing the daemon default does not
   retro-fit it.

2. **An existing project network may therefore need to be recreated** before
   the new default takes effect. On this machine that happens to be free:

   ```
   $ docker network ls --filter name=supabase
   (no results while the stack is stopped)
   ```

   *(measured)* — the CLI removes its project network on `supabase stop` and
   creates a fresh one on `supabase start`, so the next start picks up a new
   daemon default with no manual step. **Do not** delete a network, volume or
   container to force this. If a stale network ever does persist, the safe
   sequence is `npm run db:stop` then `npm run db:start`, which removes and
   recreates only the CLI's own network. Supabase data lives in Docker
   *volumes*, which `stop` does not touch.

3. **The option name ends in `ipv4`, and means it.** It does not constrain IPv6
   publishing. Docker publishes an IPv6 host listener separately, and the
   earlier measurement on this machine showed exactly that:
   `0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp`. Note also that
   `EnableIPv6=false` on the *container network* did not prevent a `[::]`
   *host-side* binding — those are different layers. **IPv4 and IPv6 must be
   checked separately, always.**

The Supabase CLI itself sets no network options at all — the pinned 2.117.0
binary contains no occurrence of `host_binding_ipv4` or any
`com.docker.network.*` key *(measured)*. Whatever the daemon default is at
network-creation time is what applies.

**None of this is a promise that the setting works here.** It is what Docker
documents. Until it has been applied and the result measured on this machine,
its effect on the Supabase stack is **unverified**.

---

## 3. What has actually been measured

### 3.1 While the stack was running (2026-09-08)

Every published port was bound to the wildcard on both families:

```
supabase_kong_kiasa       0.0.0.0:54321->8000/tcp, [::]:54321->8000/tcp
supabase_db_kiasa         0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp
supabase_studio_kiasa     0.0.0.0:54323->3000/tcp, [::]:54323->3000/tcp
supabase_inbucket_kiasa   0.0.0.0:54324->8025/tcp, [::]:54324->8025/tcp
supabase_analytics_kiasa  0.0.0.0:54327->4000/tcp, [::]:54327->4000/tcp
```

TCP connects to each host **IPv4** address succeeded on all five ports:

```
198.18.192.77   54321 54322 54323 54324 54327   all OPEN
192.168.100.28  54321 54322 54323 54324 54327   all OPEN   <- LAN
192.168.206.1 / 192.168.226.1 / 172.21.224.1 / 172.19.64.1  all OPEN
```

Port **54322 is PostgreSQL**, and the local stack's password is the well-known
default published in Supabase's own documentation.

**IPv6 LAN reachability was not probed in that session.** Only IPv4 addresses
were enumerated. The `[::]` bindings above are a strong indication, but an
indication is not a measurement, so IPv6 is recorded as **unverified**.

### 3.2 Host firewall (measured, current)

```
Name      Enabled   DefaultInboundAction        InterfaceAlias        NetworkCategory
Domain    True      NotConfigured               Local Area Connection Public
Private   False     NotConfigured               Ethernet              Public
Public    False     NotConfigured
```

Both active interfaces are **Public**, and the **Public profile is disabled**.
There is no host-level inbound filtering on the interfaces in use. Firewall
rules are only enforced while their profile is enabled, so adding a block rule
without first enabling the profile would achieve nothing.

### 3.3 Current classification

```
UNKNOWN_OR_INCOMPLETE
```

The stack is stopped, so nothing can be measured right now; and it was
deliberately **not started** to complete this document, because starting it
while the Public firewall profile is disabled would place a superuser Postgres
port on a Public-categorised network with no inbound filtering. That is a real
risk to take for a documentation change, so it was not taken.

IPv4 exposure is **measured and real** (§3.1). IPv6 is **unverified**. The
mitigation in §2 is **documented but unverified on this machine**. Nothing here
is classified as `LOOPBACK_ONLY_VERIFIED`.

---

## 4. How to verify it yourself

Run these on the host that publishes the ports — not inside a container, not
inside WSL, not on a CI runner. Those are different network namespaces and the
answer does not transfer.

**The quick way**

```bash
npm run check:exposure
```

Read-only. It discovers the published bindings from Docker rather than trusting
a hardcoded port list, probes IPv4 and IPv6 separately, and prints one of
`STACK_NOT_RUNNING`, `LOOPBACK_ONLY_VERIFIED`, `EXTERNALLY_EXPOSED` or
`UNKNOWN_OR_INCOMPLETE` (exit 3, 0, 1, 2). It is a diagnostic, **not a security
gate**, and CI does not run it — see §6.

**It fails closed.** Every container Docker lists is a candidate, and every
candidate must be fully inspected before any verdict is possible. An inspection
that fails, returns nothing, returns unparseable JSON, or carries a malformed
binding or a nonsense host port forces `UNKNOWN_OR_INCOMPLETE` — the readable
subset is never classified on its own. A wildcard binding can never produce
`LOOPBACK_ONLY_VERIFIED`, a `HostIp` declared on a specific non-loopback address
counts as exposed even if that address is not one of this host's interfaces, and
exit 0 additionally requires that both IP families were actually testable.

If the stack is stopped it says so and **stops there**: it does not tell you to
start it, because on this machine starting it is the unsafe action (§3.2). The
decision logic is covered by offline unit tests
(`npm run test:exposure`) that inject fake Docker responses, so CI verifies the
reasoning without pretending to measure a Windows host it cannot see.

**The manual way**

1. *Published Docker port mappings* — the binding, per family:

   ```bash
   docker ps --filter "name=supabase" --format "{{.Names}}\t{{.Ports}}"
   docker inspect supabase_db_kiasa --format "{{json .NetworkSettings.Ports}}"
   ```

   `0.0.0.0:` is an IPv4 wildcard; `[::]:` is an IPv6 wildcard; `127.0.0.1:`
   and `[::1]:` are loopback-scoped.

2. *Listening addresses, as the OS sees them* — the host-side truth, which on
   Docker Desktop is a Windows process proxying into the Linux VM:

   ```powershell
   Get-NetTCPConnection -State Listen |
     Where-Object LocalPort -in 54321,54322,54323,54324,54327 |
     Select-Object LocalAddress,LocalPort,OwningProcess
   ```

3. *Loopback still works* (it must, or the test suites break):

   ```powershell
   Test-NetConnection 127.0.0.1 -Port 54322 -InformationLevel Quiet
   ```

4. *IPv4 LAN reachability* — substitute your own address:

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 |
     Where-Object { -not $_.IPAddress.StartsWith('127.') } |
     Select-Object InterfaceAlias,IPAddress
   Test-NetConnection 192.168.100.28 -Port 54322 -InformationLevel Quiet
   ```

5. *IPv6 reachability* — checked separately, because §2 caveat 3:

   ```powershell
   Get-NetIPAddress -AddressFamily IPv6 |
     Where-Object { $_.PrefixOrigin -ne 'WellKnown' -and -not $_.IPAddress.StartsWith('fe80') } |
     Select-Object InterfaceAlias,IPAddress
   Test-NetConnection ::1 -Port 54322 -InformationLevel Quiet
   ```

   A `fe80::` link-local address is not routable off the link and needs a scope
   id; a global or unique-local address is the one that matters.

The strongest evidence is a probe **from a second machine** on the same
network. A probe from the host proves a socket is listening; it cannot fully
establish what a remote host can or cannot reach, because that also depends on
the firewall.

---

## 5. Mitigations

Both are **machine-level and outside this repository**. Neither is applied
automatically and neither was applied while writing this: no Docker setting,
firewall rule, adapter, service or registry value was changed, and no
container, volume or data was deleted. Apply them yourself, deliberately.

### 5.1 Docker: default the bind address for new bridge networks

Docker Desktop → Settings → Docker Engine (`%USERPROFILE%\.docker\daemon.json`):

```json
{
  "builder": { "gc": { "defaultKeepStorage": "20GB", "enabled": true } },
  "experimental": false,
  "default-network-opts": {
    "bridge": {
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
    }
  }
}
```

Apply & Restart, then `npm run db:stop && npm run db:start` so the project
network is created under the new default. **Then measure** — §4 — and do not
record it as fixed until `check:exposure` reports `LOOPBACK_ONLY_VERIFIED`.

Expected not to affect container-to-container traffic (Kong→Postgres,
Studio→pg-meta) because that runs over the project's internal network and never
touches published host ports; the test suites use loopback and `docker exec`.
That expectation is **documented, not yet measured here**.

Remember caveat 3: this key is IPv4. Verify IPv6 separately.

### 5.2 Windows Firewall: block the ports inbound

The first command is not optional on this machine — rules do nothing while the
profile is off.

```powershell
# Run as Administrator.
Set-NetFirewallProfile -Profile Public,Private -Enabled True

New-NetFirewallRule -DisplayName "Block Supabase local stack (inbound)" `
  -Direction Inbound -Action Block -Protocol TCP `
  -LocalPort 54321-54329 -Profile Public,Private
```

Windows Firewall does not filter loopback, so local development and every test
suite continue to work. Enabling a firewall profile can affect other
applications; that is a deliberate decision for the machine's owner.

---

## 6. Why this is not a CI gate

`scripts/check-local-exposure.mjs` reports and exits with a meaningful code,
but no CI job runs it. The condition worth asserting — loopback only — cannot
be satisfied by anything in this repository: CLI 2.117.0 exposes no
bind-address setting, so on a clean checkout every port publishes on all
interfaces. A gate that every developer and every runner fails is a gate that
gets disabled, and a disabled gate protects nothing.

There is a second reason, and it is the more important one: a GitHub Actions
runner is a different machine on a different network. Whatever it measured
would say nothing about the Windows host, and reporting it as a green check
would be the most misleading outcome available. What CI *can* honestly verify
is the decision logic, so it runs `npm run test:exposure` — offline unit tests
with injected Docker responses — and leaves the measurement to the machine that
actually publishes the ports.

The honest position is that this is a **residual, unresolved risk on the
developer machine**, mitigated only by the machine-level steps in §5, and that
its status is `UNKNOWN_OR_INCOMPLETE` until someone measures it.
