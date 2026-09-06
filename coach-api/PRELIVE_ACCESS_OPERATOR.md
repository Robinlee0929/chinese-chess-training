# C1F: Access operator transport — PRELIVE ONLY

This code is undeployed. It does not enable Access, create a policy, activate a
binding, provision a secret, choose a live budget, enable a provider or make a
paid call. The existing fake staging Worker and browser runtime are unchanged.
Public real-provider authority remains absent; one-shot starts DISARMED.

## Verified platform contract

Cloudflare's [Worker-level Access announcement](https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/)
documents whole-Worker protection covering associated domains and preview URLs,
trusted `ctx.access.aud`, `await ctx.access.getIdentity()`, and local
`access.dev` synthetic identity. Wrangler 4.129.0's installed config schema and
its Miniflare runtime support this facility. The local workerd test uses the
corresponding Miniflare `access: { aud, identity }` option, not spoofed headers.
Missing, missing-identity, wrong-audience, wrong-identity and allowed identity
run against the actual production entry point, RPC and SQLite. Identity lookup
exceptions and malformed values are also tested directly at the transport.

Read-only account preflight reported Access not enabled (API code 9999), only
the existing fake Worker, and no Durable Object namespaces. This does not
authorize enabling Access. Live protection must be established and verified
in the separate owner-controlled phase below.

## Authority and interaction

First-live mode: `CLOUDFLARE_ACCESS_INTERACTIVE_OPERATOR`. No service token,
static admin key, manually parsed cookie, email header or browser setting is
an operator authority. The server-owned deployment values below are all absent
from committed configuration; local fixtures use only synthetic values:

- `COACH_OPERATOR_ACCESS_AUD`: actual verified Worker Access application audience.
- `COACH_OPERATOR_EMAIL`: one explicitly selected human operator identity.
- `COACH_OPERATOR_ORIGIN`: exact HTTPS origin of the isolated operator Worker.

Only platform `ctx.access` supplies audience and identity. Both must exactly
match server policy. Missing, invalid or failed identity/policy denies. Policy
values are not inferred from request fields, repository owner or account email.
All operator identity remains request-scoped, never stored, logged, returned or
included in provider input. No request authorization is cached across requests.

Routes in the isolated real Worker only:

- `POST /__operator/one-shot/arm`
- `POST /__operator/one-shot/dispatch`

These are separate empty-body, query-free requests. Any supplied policy,
profile, prompt or identity body is rejected, even if otherwise authenticated.
Empty workerd POST streams must reach EOF within one second; content is never
parsed or forwarded. GET/OPTIONS cannot mutate. Origin must match both the
server-owned HTTPS origin and request origin. Missing/foreign Origin denies.
There is no CORS, GitHub Pages origin allowance, UI, status route or command-line
missing-Origin fallback. An operator may issue the two requests deliberately
from the authenticated same-origin browser context; no browser control ships
with the application. ARM does not dispatch.

The outer Worker constructs a minimal verified audience/email claim and passes
it via its private DO binding, never via HTTP payload forwarding. The internal
`accessOperator` RPC rechecks server policy and composes a per-request verifier
over the existing C1E `createOperatorDispatch`. It reuses the existing coordinator
execute closure, so request handling does not reconstruct budget/recovery state.
The binding is a trusted server boundary: do not expose it to other Workers or
add generic RPC forwarding. Direct public `arm`, `dispatch`, recovery or reset
RPC methods remain absent. The RPC claim is not an independently signed token
and must never be accepted from an untrusted caller.

Responses reconstruct only `denied`, `armed`, or `completed/failed` plus the
bounded consumed boolean, with no-store and no CORS. Provider framing, identity,
exceptions, request content, budget and SQL diagnostics are not relayed.
Public `/api/review-coach` retains its existing bounded generic empty unavailable
response. Access authentication does not enable that path, even after ARM.

The conjunction remains: verified Access + server operator policy + same-origin
explicit DISPATCH + persistent ARMED + atomic durable CONSUMED + real enable +
secret + rate + budget + global coordinator/concurrency + no recovery fence.
Replay/concurrent requests cannot create a second attempt. No retry, model
fallback, refund, reset, new dispatch identity or rearm operation is introduced.

## Separate owner-controlled live sequence (not authorized here)

1. Independently review and publish C1F repository code first. Reverify platform
   support, account ownership and unchanged fake staging before live actions.
2. Obtain explicit owner authority for Access/account activation and isolated
   real Worker deployment, DO migration and rate binding. Deploy disabled:
   public flag absent/false, real enable false, budget zero, no OpenAI secret.
3. Protect the **entire isolated Worker** with Worker-level Access. Cover every
   route, custom domain, workers.dev and preview URL; no public-coach bypass,
   bypass policy or unprotected alternate hostname. Keep unused surfaces off.
   Do not change fake staging or enable account-wide protection as a shortcut.
4. Owner selects the real interactive identity and restricted Access policy.
   Verify the actual audience, then provision the three server policy values.
   No real email, audience, team domain or policy ID belongs in Git.
5. Verify unauthenticated, wrong-user, wrong-audience and foreign-Origin denial,
   and zero provider calls. Inspect only bounded operator results. Verify ARM
   separately and zero calls. A disabled-prerequisite DISPATCH may be tested
   only with explicit awareness that it **permanently consumes** this one-shot.
   It cannot then be rearmed for a paid call. Any further attempt requires a new
   owner authorization cycle and separately reviewed rearm procedure; none is
   implemented. Do not validate by deleting/replacing state or redeploying.
6. **Verify Access before any OpenAI secret, nonzero budget or real enable.**
   If Access configuration, identity lookup or account setup fails, stop; no
   static-token fallback and no attempt to prove readiness through a paid call.
7. Separate approvals remain required for a dedicated project secret, tiny live
   budget, real-provider enable, ARM, and the first explicit paid DISPATCH.
   Never read/print secret values. Keep the public real flag absent/false.
8. With all checks satisfied and an unconsumed authorized one-shot, ARM alone,
   verify its bounded response and zero calls, then explicitly DISPATCH once.
   At most one fixed economy request is allowed. No second paid test on failure.
9. Contain by disabling the provider after success or failure. Inspect restricted
   operational metadata without logging identity/content. A lost continuation
   remains CONSUMED and recovery-fenced; follow C1D proof/containment, not age,
   alarms, SQL deletion, database replacement, refund or ownership clearing.

Accepted C1E P3 remains: prerequisite denial after consumption spends one-shot
authority even at zero provider calls. C1D lost-continuation limitations remain.
The existing backend strict U+2028/U+2029 contract is unchanged. No automatic
budget increase, second attempt, public real enable or C2 progression is implied.

## Validation and handoff

`node --test prelive-access-operator-test.mjs` includes local workerd tests and
LF/CRLF executable mutation coverage. All outbound workerd requests are
intercepted by a mock; no network passthrough exists. Synthetic approving
policies exist only in tests, never in Wrangler configuration.

Twenty-one mutation gates run in LF and CRLF (42 executions), requiring a passing
healthy baseline, exact replacement, successful import and the intended failing
behavioral assertion. Mutants actually mutate one-shot state or make mocked
provider calls. The client-quality mutant reaches the mocked quality model;
the client-prompt mutant demonstrably crosses the coordinator boundary but is
then rejected by unchanged C1A/C1C validation. The identity-leak mutant reaches
the intercepted OpenAI request body. No syntax/setup failure is a mutation kill.

Required handoff: `INDEPENDENT_REVIEW_REQUIRED`.
Next: `R3C2_C1F_LIVE_OPERATOR_TRANSPORT_INDEPENDENT_REVIEW`.
No push, merge, deployment, resource creation, secret or paid call is authorized
by this implementation task.
