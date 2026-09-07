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
Before C1J, construction marked an occupied slot RECOVERY_REQUIRED. C1J leaves
that raw row untouched and derives RECOVERY_REQUIRED from unresolved ownership
or inconsistent/incomplete evidence. Acquisition and ACTIVE_PROVIDER marking share one SQL
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
coordinator has `execute`, C1F `accessOperator`, and C1J `forensicSnapshot` RPC methods.
There is no HTTP route forwarding the forensic method. Query/body recovery fields
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

The earlier Data Studio procedure is NOT authorized for the current incident.
[Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/)
sends requests to the deployed object and emits audit records. SELECT alone does
not prevent the currently deployed pre-C1J constructor from changing recovery
evidence. Do not Explore/query, use RPC, or deploy under C1J prelive authority.
The following queries are schema documentation, NOT executable live instructions.

```sql
SELECT state, owner FROM coach_recovery WHERE singleton = 1;
SELECT owner FROM coach_slot WHERE singleton = 1;
SELECT id, day, units, state, terminated, finalized FROM coach_reservations
WHERE finalized = 0 ORDER BY id;
SELECT day, units FROM coach_days ORDER BY day;
```

The operation ID plus namespace identity is the incident correlation identifier;
store it only in the restricted operator record. No new content logging is added.
Any future inspection needs separate implementation review, rollout review and
explicit owner authority. Remain disabled; no public admin workaround.

## C1J evidence-preserving reconstruction (local/prelive only)

`prelive/provision.js` is an explicit bootstrap module, NOT imported by the Worker.
It requires the module-owned `INITIAL_PROVISIONING` capability and completely
empty application storage. It creates the original five-table schema atomically;
existing, partial or inconsistent databases are rejected, never repaired. There
is no initialization RPC, HTTP route, env flag or client-selectable migration.
Local fixture composition explicitly provisions before constructing the core.
A future fresh-object bootstrap caller requires separate server-composition
review and live authority. The incident object must NEVER take that path.

Ordinary construction creates only in-memory helpers and performs SELECT reads.
No schema initialization, singleton insertion, recovery rewrite, sync of new
writes, alarm, sequence change or ledger is performed. A constructor read failure
leaves budget admission unavailable for that instance. Missing/invalid schema,
rows or enums fail closed. A missing row remains missing in the snapshot.

`forensicSnapshot()` is an argument-free internal binding RPC returning bounded
JSON. It reads only storage, never env, secrets, Access claims or provider content.
No deployed HTTP route forwards to it; binding possession is a trusted server
capability, not browser identity. Do not grant new callers this binding without
review. No runtime initialization/clear/reset/rearm interface is added.

The snapshot separates `raw` rows from `derived` decisions. Existing ACTIVE_PROVIDER,
NORMAL, RECOVERY_REQUIRED or mismatched recovery/slot evidence is not normalized.
An occupied slot is conservatively recovery-required to an external observer.
The original trusted live continuation can still settle only its own generation;
its in-memory locally-owned marker is not persisted or used as termination proof.
Restart, age, alarm, deployment and abort never clear/refund unresolved work.

C1J orphan remediation makes ownership consistency bidirectional: an owner must
identify an unfinalized reservation, and every unfinalized `dispatching` or
`started` reservation must match that owner (slot and recovery owners must also
agree). Dispatch intent is potentially active work, not proof of cancellation.
`terminated=1` does not waive this relationship before finalization: existing C1D
termination retains ownership until the trusted finalize transaction converts the
row to `consumed` and clears only its own generation. An ownerless terminated
`started` row is SQL-representable, but is not ordinary finalized history.
`reserved` before acquisition and valid `released`/`consumed` finalized history
do not acquire this new ownership requirement. Matching active ownership remains
recognized, with C1D's existing reconstruction fence and original-continuation
settlement unchanged. No evidence is repaired, normalized or refunded by this
derived check. Truncated evidence remains recovery-required and admission-denied,
even if an orphan lies beyond the 16 displayed reservations. A denied operational
request may still reserve and settle its own new generation; that is distinct
from zero-write construction/snapshot and never changes the old incident rows.

Budget output is capped at 8 rows, reservations at 16. Completeness counts are
bounded observations (up to 9/17), NOT total counts when truncated. Truncation sets
accountingConsistency=UNKNOWN (or INVALID for observed inconsistency), never
CONSISTENT. Admission conservatively fails closed on incomplete evidence; expanding
this prelive envelope requires review, not client pagination or hidden repair.
CONSISTENT describes represented ledger arithmetic only, not proof of upstream
delivery, termination or billing. `attempted`, `providerFetchStarted` and
`upstreamDelivery` remain UNKNOWN; absent transition timestamps/kinds remain
NOT_AVAILABLE. Illegal values are rendered INVALID, never arbitrary raw strings.

Future forensic RPC still invokes the DO and may construct it, incur billing and
produce Cloudflare audit/runtime telemetry. The local guarantee is ZERO APPLICATION
persistent writes, not zero platform side effects. Current live incident rows and
C1H unknowns remain untouched. No claim of live post-remediation preservation is made.

Before any separately authorized rollout: retain class/namespace/binding/logical
identity/migration lineage; review old/new-version overlap and potential automatic
restart; keep provider=false, budget=0 and public=false; never deploy the test-only
bootstrap/seed/inspection transports. Prove the first new constructor plus snapshot
against preexisting SQLite fixtures locally before independent review. No object
delete/recreate, database reset, PITR restore, generation reset or force-clear is
part of this implementation. Do not backfill an incident ledger. D is deferred.

`prelive-forensics-test.mjs` measures SQL write attempts as well as complete
before/after schema/row equality. Its LF/CRLF mutants must import and exhibit the
intended broken behavior before the invariant assertion kills them. The local
workerd test persists seeded legacy-shape rows, disposes runtime, reopens using
the production constructor and exercises the production forensic RPC with SQL,
storage-write, env-read and outbound traps. All seed/transport hooks are test-only.

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
   initialization only through a separately reviewed server bootstrap composition;
   operator ARM/DISPATCH and forensic reads cannot initialize storage. Do not turn on the
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

### C1E exclusive first-call addition (PRELIVE, not deployed)

The ordinary real-staging HTTP path has a separate server-owned authority:
`COACH_REAL_PROVIDER_PUBLIC_ENABLED`. Only the exact server value `"true"`
approves it; absent, false, boolean true, and malformed values deny. It is absent
from committed configuration. Both outer admission/provider dispatch and the
Worker's public `execute` RPC check it. No header, query, body, browser preference,
operator approval, one-shot state, secret, budget, or ordinary provider-enable
flag can supply this independent authority. Errors retain the existing empty,
bounded generic disabled/unavailable contract. Fake staging and browser runtime
are unchanged. A separately reviewed later phase is required to enable public
real staging; first-call success never enables it.

`prelive/operator-dispatch.js` is an INTERNAL coordinator composition module,
not an HTTP route or exported Worker RPC. The core installs it against the SAME
SQLite storage and execution closure used by C1C. The deployed wrapper installs
no approving operator authority and exports no operator invocation transport.
`LIVE_OPERATOR_TRANSPORT_IMPLEMENTED=NO`; no live identity technology is selected.
Future wiring must remain inside this same named global coordinator, not an
outer-Worker object with an arbitrary namespace or volatile state.

`arm()` and `dispatch()` accept no arguments. A trusted, server-injected verifier
must return exactly true for the fixed action (`arm` or `dispatch`); absent,
false, malformed, or throwing authority denies. Test approving functions are
synthetic only, NOT production authentication. Future transport must be private
or strongly identity-authenticated with server-side verification, not an ordinary
user session, static public admin header, query token, or browser-local state.
Replay of authentication still encounters the persistent one-shot CAS gate.
Authentication/transport implementation and review remain an owner/resource gate.

The fixed logical identity is `review-coach-first-live-economy-v1`. A new schema
starts DISARMED; existing rows are never overwritten by construction, and missing
rows/unknown states deny. Arming conditionally changes only DISARMED to ARMED and
syncs storage, making zero provider calls. Dispatch authenticates, checks its
internal executor, atomically changes only ARMED to CONSUMED with SQL
`UPDATE ... WHERE ... RETURNING`, and awaits `storage.sync()` BEFORE invoking C1C.
Only then do C1C/C1B secret, enable, rate, budget, concurrency, recovery and C1A
input/validator checks run. This deliberately consumes even when a later
zero-cost prerequisite denies. Sync failure also never triggers a retry/rearm.
No await separates the SQL conditional test and update. See the
[Cloudflare SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Input is fixed `check-difference`, zh-Hant, child-neutral-teacher-v1, economy,
with the existing rule-owned minimal diagnostic framing purpose. No operator
free text, board, GameRecord, profile or model selection is accepted. C1A retains
store=false, reasoning=none, max_output_tokens=128, tools=0 and retry=0. Existing
economy model mapping is unchanged and must be rechecked before any future live
call. C1B and coordinator retries also remain zero. Operator results contain only
bounded status and (after consumption) consumed=true: no framing, prompt, key,
raw result/request ID, reservation/DO ID, accounting totals, or stack. No content
logging is added.

CONSUMED is terminal in this implementation. Success, network errors, 429/500,
parser/validator rejection, cancellation, timeout, or loss of continuation cannot
write the one-shot row. Stale completions cannot change newer one-shot state;
C1D still protects reservation generations and provider ownership. Reconstruction
does not prove termination. A genuinely lost attempt remains CONSUMED and fenced,
with no silent started-unit refund. Follow the C1D containment/proof procedure;
never clear ownership, delete SQL, restore a database, change logical identity,
or deploy to rearm. There is NO runtime rearm/reset/forceArm API. A second attempt
requires a new explicit owner authorization cycle, fresh safety verification and
a separately reviewed operator re-arm procedure (not implemented by C1E).

Future first-live order, ALL behind separate owner approvals:

1. Deploy reviewed real resources disabled, public authority false/absent.
2. Verify zero calls and unchanged fake staging.
3. Establish and independently review live operator authentication/transport.
4. Create the dedicated project secret through secure owner input.
5. Verify provider still disabled.
6. Owner selects a tiny non-zero budget (no value selected here).
7. Verify provider still disabled.
8. Owner explicitly authorizes the real-provider enable gate.
9. Verify ordinary public traffic STILL cannot start a real call; public authority stays false.
10. Explicitly ARM through verified operator authority.
11. Verify ARMED and zero provider calls, without exposing internal SQL to clients.
12. Explicitly DISPATCH once through the operator transport.
13. Atomically consume and durably sync authority before coordinator execution.
14. Allow at most one economy provider attempt; never retry or switch models.
15. Verify CONSUMED using restricted operator-side inspection.
16. Inspect coordinator, budget, concurrency and recovery state without logging content.
17. Disable real provider again after the attempt, success OR failure, before experimentation.

No automatic promotion, budget increase, second call or C2 progression occurs.
If any verification fails, contain and stop; a validation failure is not approval
to issue another paid call. The public authority is distinct from every first-live
gate and remains closed throughout this sequence.

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

C1E evidence: `prelive-one-shot-test.mjs` has 44 functional cases plus 28 viable
mutation gates run under both LF and CRLF (56 executions). The non-atomic mutant
actually starts two mocked calls: an adversarial scheduler delays the second
durability barrier until the first call drains, so C1C concurrency does not mask
duplicate consumption. This scheduler is not an authorization lock. Healthy
code rejects the second claim before that barrier. Timeout-rearm isolation uses
an explicitly test-only ownership-clear fixture to expose the illegal second
fetch; the separate lost-continuation test preserves and verifies the real fence.
The prompt mutation observes arbitrary purpose crossing the internal dispatch
boundary even though the unchanged C1A/C1C validators subsequently deny it.
Hostile newer-generation SQL fixtures are not approved rearm/recovery procedures.
No syntax, import, replacement or setup failure counts as a mutation kill.

Local workerd additionally verifies public HTTP/RPC denial, absence of operator
RPC methods, and one private synthetic operator attempt followed by denial. Its
test-only transport/verifier is not included in either deployment configuration.
C1C/C1D public success regression fixtures explicitly model a future server-
authorized public phase; they do not change committed runtime defaults.

The preceding transport-absence and handoff statements describe the C1E baseline.
C1F now supplies an undeployed Access transport; `PRELIVE_ACCESS_OPERATOR.md`
supersedes the live authentication sequencing above. Access must be verified
before secrets, nonzero budget or provider enable, and disabled-prerequisite
dispatch still irreversibly consumes the one-shot. No recovery contract changes.

Next: `R3C2_C1F_LIVE_OPERATOR_TRANSPORT_INDEPENDENT_REVIEW`.
The immediate handoff is INDEPENDENT_REVIEW_REQUIRED. No push/merge/deploy is
performed by this implementation task; live operator transport/authentication,
resources, secrets, positive budget and paid attempts remain separate owner gates.
