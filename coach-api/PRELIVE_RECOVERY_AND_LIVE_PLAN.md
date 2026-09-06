# C1D recovery contract and future live-resource plan

Status: PRELIVE ONLY, awaiting independent review. This document is not authority
to deploy, create resources/secrets, enable traffic, select a live budget, or make
a paid request. No public recovery route, force-clear method, alarm, or timer is
implemented. C1A model mapping and the backend-stricter U+2028/U+2029 behavior are
unchanged. The fake staging Worker must remain untouched.

## Evidence and limits of the proof

Reviewed 2026-09-06 against official documentation and pinned Wrangler 4.129.0.

- [Cloudflare global uniqueness caveat](https://developers.cloudflare.com/durable-objects/platform/known-issues/): an old event doing long external I/O without storage access can outlive instance replacement. Subsequent stale-instance storage access throws. Replacement, including software updates, is not provider termination.
- [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): synchronous transactions protect related state changes; `sync()` flushes pending writes. These are storage guarantees, not external cancellation guarantees.
- [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/): initialization locking must not enclose provider I/O. `waitUntil` does not provide a DO lifetime guarantee.

Inference for this application: no documented signal available to this code
proves an orphaned remote operation has ended after its continuation is lost.
Recovery v1 therefore denies new traffic and preserves the fence. Elapsed age,
HTTP timeout, abort request, constructor, replacement, alarm, deployment, key
revocation, and UTC rollover are NOT termination proof. Generation fencing
restricts state mutation; it does not stop old external I/O.

## Persistent state and operation identity

The existing SQLite AUTOINCREMENT reservation `id` is the server-owned operation
generation, scoped to the unchanged coordinator namespace and database. It is not
an HTTP requestId or client profile. Do not reset sequences, restore an older
database snapshot, delete/recreate the namespace, or change coordinator identity
to bypass a fence. A future namespace replacement requires separate architecture
and recovery review; v1 does not support it.

| Persistent state | Meaning | New provider starts |
| --- | --- | --- |
| NORMAL, owner NULL | No occupied slot or unresolved incident | Only after every ordinary admission gate |
| ACTIVE_PROVIDER, owner=id | Slot acquired; includes dispatch preparation and fetch/body lifetime | Denied while occupied |
| RECOVERY_REQUIRED, owner=id | Reconstruction observed occupied ownership; no matching continuation can be assumed | Denied |

`coach_recovery` persists the current state and affected operation ID.
Construction marks an existing occupied slot RECOVERY_REQUIRED without clearing
it or changing usage. Acquisition and ACTIVE_PROVIDER marking share one SQL
transaction. An ordinary denied request may temporarily reserve its own units;
the existing not-started settlement returns those units, never the owner's units.
The recovery gate independently denies acquisition, even if the slot and incident
become inconsistent. Storage errors propagate to generic failure.

Only the original trusted lifecycle may settle its own reservation:

1. Proven pre-dispatch cancellation in the original dispatch closure can release
   its unstarted reservation. Merely observing `dispatching` in storage is not
   sufficient: the original continuation may still resume and dispatch.
2. C1B's registered fetch/body drain settles, then its private lease release marks
   termination. Finalization retains attempted units and clears only matching
   ownership/recovery state in the same transaction. This preserves C1B's local
   operation-lifetime contract; it does not certify remote billing completion.
3. If storage access from that old event is rejected by Cloudflare, no replacement
   event impersonates it. Leave RECOVERY_REQUIRED and the reserved/attempted units.

Known completion of a retained original continuation is normal settlement, not
automatic recovery of a *lost* continuation. Duplicate finalization is rejected.
An obsolete ID cannot clear a newer slot, overwrite its incident, or finalize its
reservation. Original-day units remain charged on started failure or lost work.

`inspectRecovery()` is a read-only internal budget helper, available to local
tests, not a DO RPC method or HTTP route. Arguments convey no authority. The
coordinator's only RPC operation remains `execute`. Query/body recovery fields
are rejected; arbitrary headers neither change state nor enable execution.

RECOVERY_REVIEWED and RECOVERY_AUTHORIZED are **operator incident-record stages**,
not runtime states or clear permissions. Record them in a restricted durable
incident system after the corresponding review/owner decision. Neither can
automatically transition SQL state or permit traffic. No normal-runtime API can
set them. An unresolved incident can remain contained indefinitely.

## Recovery runbook (future authorized operations only)

### Detection

Indicators: repeated generic provider-unavailable responses, a persisted occupied
slot after reconstruction, RECOVERY_REQUIRED, or usage reserved without a known
completion. Browser errors intentionally do not distinguish these conditions.
The operator uses a restricted state snapshot, never prompts, framing, board,
GameRecord, raw provider responses, API keys, or application requestIds.

For a future deployed SQLite object, [Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/)
can inspect SQL through the dashboard: Durable Objects → the verified namespace
→ Data Studio → the fixed coordinator name. It requires platform administration
permission and sends billed requests to the deployed object; do not use it during
this prelive task. Use only SELECT, with edit/delete capabilities left unused.
Queries run separately, so contain traffic first and repeat snapshots to identify
changes rather than claiming a multi-query atomic snapshot.

```sql
SELECT state, owner FROM coach_recovery WHERE singleton = 1;
SELECT owner FROM coach_slot WHERE singleton = 1;
SELECT id, day, units, state, terminated, finalized FROM coach_reservations
WHERE finalized = 0 ORDER BY id;
SELECT day, units FROM coach_days ORDER BY day;
```

The operation ID plus namespace identity is the incident correlation identifier;
store it only in the restricted operator record. No new content logging is added.
Before first live enablement, verify this inspection path and operator permissions
on the disabled deployment. If unavailable, remain disabled; do not add a public
admin endpoint as a workaround.

### Containment — always first

Disable the real provider, zero/remove live budget authorization, and close the
separately approved operator ingress. Preserve SQL, deployment identity, and
incident evidence. Do not clear ownership first. Configuration changes propagate
and old events may continue: a successful disable deployment is not termination
proof. Keep the persistent fence throughout containment.

### Diagnosis and safe wait

Record incident ID, UTC time, code/version, namespace, affected operation ID,
reservation state, slot owner, recovery state, and original-day units. Distinguish
ordinary contention, exhausted budget, storage error, and uncertain lifecycle.
If the original trusted drain is still present, it may complete its own guarded
settlement. A read-only operator snapshot saying `terminated=1` is not a bearer
credential for a force clear. No timeout duration authorizes action.

If the continuation is genuinely lost, keep provider disabled and ownership
fenced. `AUTOMATIC_SAFE_RECOVERY_AVAILABLE=NO`. Do not promise availability.
The safe v1 outcome is an operator-visible, contained, unresolved incident.

### Recovery decision

Mark RECOVERY_REVIEWED in the incident record after independent review. If no
operation-specific termination justification can be established, stop there.
Future exceptional state repair requires ALL of: explicit owner authorization,
global containment first, incident ID, current snapshot, independently reviewed
termination justification, precise generation-safe change specification, and an
audit trail. Authorization alone is not proof. This document intentionally
contains no SQL UPDATE/DELETE recovery recipe and no force-clear implementation.
If evidence remains insufficient, repair is forbidden, even for availability.

### Post-recovery validation and closure

Before any future re-enable, independently verify: slot/recovery consistency;
original-day units not refunded for attempted work; all reservations finalized at
most once; new operation identity strictly newer without sequence reuse; stale
completion cannot change current ownership or reservation; concurrency probe max
one; disabled zero-call probe; secret boundary; and full local regressions. Use
mocked/local probes for concurrency; a paid probe requires its own authorization.
Never delete evidence or roll back SQL to reduce usage. Record validation and
owner decision separately from incident closure. A contained but unresolved
incident is not closed as recovered. Even after safe settlement, re-enable needs
the owner enable gate; it is not a side effect of reviewing the incident.

## Future resources and owner decisions

| Item | Fixed identity / required decision |
| --- | --- |
| Worker | `chinese-chess-coach-openai-staging`, `prelive/worker.js`, separate from fake staging |
| Configuration | `wrangler.real-prelive.jsonc`; workers.dev and preview URLs remain false; no public routes |
| DO binding / class | `COACH_REAL_COORDINATOR` / `CoachRealProviderCoordinator` |
| Migration | `real-provider-v1`, `new_sqlite_classes: ["CoachRealProviderCoordinator"]` |
| Object identity | `review-coach-real-provider-global-v1`, only server `getByName` routing |
| Rate binding | `COACH_REAL_RATE_LIMITER`; unused account-wide numeric namespace selected later |
| Secret | `OPENAI_API_KEY`, Cloudflare Secret only, never vars/Git/browser/input |
| Budget | `COACH_REAL_DAILY_UNITS`; committed zero, future positive value is owner's decision |
| Enable | `COACH_REAL_PROVIDER_ENABLED`; committed false, independent owner decision |

OWNER_GATE_A: isolated Cloudflare deployment/migration/rate binding and any
restricted operator ingress. OWNER_GATE_B: dedicated OpenAI project/key creation
and secret provisioning. OWNER_GATE_C: non-zero live units and monetary guard
values. OWNER_GATE_D: enable=true. OWNER_GATE_E: exactly one paid validation
attempt, default economy. Later explicit authorization may combine named gates;
approval of this prelive plan cannot be inferred to approve any of them.

The singleton intentionally limits low-volume staging to one provider operation.
It is a throughput/availability bottleneck. C2 scalability review is mandatory
before materially higher production traffic; sharding must not evade global cost
or concurrency limits.

[Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
is abuse/frequency control, not exact global spend or concurrency accounting.
At deployment, inventory existing account namespace use and choose an unused
numeric namespace. The owner must approve the frequency limit and supported
period, accounting for two checks per successful POST plus readiness checks.
Neither value is selected here. Missing/throwing rate binding fails closed.

## OpenAI project, models, and spend controls

Use a dedicated API project and project-scoped restricted service credential;
grant only required endpoint/model access. Review project membership, per-model
rate limits, notification recipients, and usage alerts. Do not use a personal
all-project admin credential in the Worker. No project or credential is created
or accessed in C1D. See [project administration](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects).

Require an enforced project hard spend guard wherever available and review the
applicable organization guard too. Owner chooses amounts. [Current spend-limit
documentation](https://developers.openai.com/api/docs/guides/spend-limits) separates
alerts (traffic continues) from enforced hard limits (affected requests fail with
429). Enforcement can lag, so this is not an exact-dollar guarantee. Verify the
actual enforcement setting, not merely a monthly alert threshold. If an enforced
guard is unavailable to the account, stay disabled pending explicit review of
that limitation; do not silently substitute alerts. Local weighted daily units
remain the independent hard usage circuit breaker, not token/dollar accounting.

Mapping remains economy → `gpt-5.6-luna`, balanced → `gpt-5.6-terra`, quality →
`gpt-5.6-sol`. Availability/access is NOT_TESTED_BY_DESIGN in C1D. Before a live
attempt, freshly verify official availability and project access, including the
required Responses/structured-output parameters. Stop for separate review if the
mapping is unavailable; do not substitute another model. First paid validation
uses economy only unless the owner explicitly changes that choice.

## Ordered first-live plan — DO NOT EXECUTE IN C1D

1. Independent C1D review, later authorized integration/publication, then pin the
   approved Git SHA. Confirm clean worktree and freshly read origin/main. Confirm
   fake Worker version/secrets unchanged and no unexpected real resources.
2. Obtain gate B for project preparation, verify model access and hard spend guard
   capability without making a generation call. Document all remaining gates.
3. Obtain gate A. Prepare a separately reviewed deployment configuration based on
   the committed isolated config. Keep enable=false, budget=0, secret absent,
   workers.dev=false, previews=false, and no public routes. Use pinned Wrangler.
4. Deploy that disabled Worker with its SQLite class migration. The migration is
   part of the deployment, not a second guessed namespace-creation command.
   Confirm binding, class, migration and SQLite backend via remote metadata.
5. Add the reviewed rate-limit namespace/policy to the disabled configuration and
   deploy only after gate A covers it. It may be included in step 4 if reviewed
   together, but record it as a distinct resource decision. Never reuse fake config.
6. Establish the reviewed, restricted operator probe path. CORS is NOT access
   control against non-browser callers. Keep public routes disabled. A private
   service-binding caller with an independently verified one-shot dispatch guard
   is a possible later implementation, NOT supplied by C1D. Do not enable until
   exclusive operator access and one-attempt enforcement are proven; a curl
   command and operator timing alone are insufficient on a public endpoint.
7. Verify disabled/no-secret, missing bindings, malformed input and generic errors
   through that controlled path, with zero provider attempts. Inspect the SQL
   initialization through the approved operator method. Do not turn on the
   provider to test these resource/inspection steps.
8. With gate B, provision OPENAI_API_KEY through the Cloudflare Secret channel.
   The operator supplies it without chat, command-line literal, Git, file logging,
   or browser payload exposure. Verify the secret's NAME exists, not its value.
   Provider remains disabled and budget zero; repeat the zero-call check.
9. Gate C: owner selects a tiny non-zero staging usage ceiling and monetary hard
   guard, with a documented exposure calculation for economy's one-unit weight.
   This document chooses no live number. Still disabled; repeat zero-call check.
10. Confirm NORMAL/no active owner, correct UTC bucket, hard guard enabled, rate
    authority, secret boundary, exclusive one-shot operator path, and no pending
    incident. Get explicit gates D and E. No browser UI is enabled by this plan.
11. Enable only the isolated real Worker. The approved one-shot path sends one
    fixed valid economy request, with no automatic HTTP/client retries. A timeout
    counts as the one attempt; do not retry to obtain a nicer result. Persist the
    one-shot consumed state across caller failure before dispatch. If that later
    control is not available/reviewed, remain disabled at step 10.
12. Immediately disable again after the single attempt, also on success; inspect
    attempted units, reservation/finalization, slot/recovery state, and redacted
    outcome. On any invariant difference, preserve evidence and enter containment.
    No second paid call without new authorization. Check fake staging unchanged.

Future command templates, run from `coach-api` only after their named gates:

```powershell
# Read-only configuration validation; no remote deployment.
node -e "require('wrangler').unstable_readConfig({config:'wrangler.real-prelive.jsonc'})"
# Gate A ONLY, after deployment config/bindings are independently reviewed.
.\node_modules\.bin\wrangler.cmd deploy --config wrangler.real-prelive.jsonc
# Read-only remote metadata after the authorized deployment.
.\node_modules\.bin\wrangler.cmd deployments list --config wrangler.real-prelive.jsonc --json
.\node_modules\.bin\wrangler.cmd secret list --config wrangler.real-prelive.jsonc --format json
# Gate B ONLY; operator enters secret through secure interactive input.
.\node_modules\.bin\wrangler.cmd secret put OPENAI_API_KEY --config wrangler.real-prelive.jsonc
```

Validate DO metadata with read-only Cloudflare API
`GET /accounts/{verified_account_id}/workers/durable_objects/namespaces` (all pages)
and Worker binding metadata. Do not treat D1 commands as DO inspection commands.
Verify the exact class, script, SQLite backend and fixed name; a namespace existing
alone is not proof of correct execution. No remote IDs or rate numbers are guessed.
No enable or positive-budget command is supplied until the owner's values and
the one-shot ingress implementation are reviewed.

## Emergency disable, rollback, rotation, and failures

Under separately authorized emergency operations, close the operator ingress and
deploy the reviewed real configuration with explicit fail-closed overrides:

```powershell
.\node_modules\.bin\wrangler.cmd deploy --config wrangler.real-prelive.jsonc --var COACH_REAL_PROVIDER_ENABLED:false --var COACH_REAL_DAILY_UNITS:0
```

Verify remote version/config and disabled zero-call behavior, preserve SQL and
the fence, then inspect. Never run this against `wrangler.jsonc` or the fake Worker.
Propagation can leave old events alive; preserve all ownership evidence. Do not
use a deployment change as proof to release an operation. If containment cannot
be verified, keep ingress closed and escalate; no new probe may be paid.

Rollback is a separate owner decision, after schema/forward-backward compatibility
review, to a specifically approved disabled code version. Do not roll back the
database, migration, sequence, or accounting; never restore an enabled version as
an emergency shortcut. C1D does not supply destructive recovery commands.

Secret rotation: disable and verify containment first, replace the secret through
secure operator input, revoke the old project credential under authorization,
verify still disabled, and re-enable only through gate D (and E for a paid test).
Neither rotation nor revocation proves earlier upstream execution has terminated.

| Failure | Required response |
| --- | --- |
| Rate binding absent/throws | Deny before dispatch; investigate binding while disabled |
| Rate policy unexpectedly permissive | Disable pending policy review; SQL budget/concurrency still required |
| Budget storage failure | Generic unavailable; preserve unresolved state, no retry/refund assumption |
| Budget exhausted | No provider attempt; no automatic limit increase; owner review |
| Stuck concurrency / lost continuation | RECOVERY_REQUIRED, preserve units/fence, operator runbook |
| OpenAI 429 or spend-limit exceeded | Terminal unavailable for that attempt, consume attempted units, no retry |
| Provider/parser/framing failure | Generic unavailable, no raw content logging, no retry |

`organization_spend_limit_exceeded` and `project_spend_limit_exceeded` never trigger
retry or automatic limit increases. The adapter treats non-200 status generically;
any billing investigation uses restricted provider-side metadata, not a new
browser diagnostic surface. Secret creation alone, positive budget alone, and an
enable flag with missing other gates cannot authorize a provider call.

## Offline evidence and review handoff

`prelive-recovery-test.mjs` exercises SQLite reopen, idle/active reconstruction,
lost and retained continuations, UTC advancement, internal age/alarm observations,
HTTP/RPC client controls, stale operation IDs, accounting and separated live gates.
The hostile newer-generation fixture mutates only its test database to test state
isolation; it is not a runtime force-clear method or approved recovery procedure.
No runtime alarm exists; its mutation gate attacks the local read-only inspector
as though an alarm observation were incorrectly made authoritative.

Ten mutation gates run both LF and CRLF. Each imports executable mutated modules,
checks the healthy baseline, observes the exact intended broken outcome, then
requires the safety assertion to fail. Import/setup errors are not kills. Existing
C1C/C1B/C1A suites and the local workerd test remain part of backend regression.

Next: `R3C2_C1D_RECOVERY_AND_LIVE_PLAN_INDEPENDENT_REVIEW`. No push/merge/deploy in
C1D. The immediate handoff is INDEPENDENT_REVIEW_REQUIRED; the persistent external
authority boundary remains LIVE_RESOURCE_AND_SECRET_GATE.
