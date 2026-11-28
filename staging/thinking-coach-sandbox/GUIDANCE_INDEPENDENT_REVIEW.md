# U3-01B-2 independent review

**INDEPENDENT_REVIEW_PASS. New unresolved P1 = 0; P2 = 0.**

Base: `67ed4f5ece5f1c9a47bfd38b5507a41afd560875`. Reviewed 2026-11-27T11:16:04.702Z. This is independent local verification, not GitHub CI PASS or release authorization.

## Review scope

Read-only review of the staging teaching adapter, guidance model, rendering, tests and documentation. The reviewer independently exercised behavior in isolated full Chrome contexts with synthetic data, then checked frozen code hashes, raw Git/Artifact bytes and protected worktrees. No reviewer changes to product/source, Git refs, PRs, other worktrees or Snapshot.

The JSON-only boundary, source-history replay, Session/branch/node/stage identity, stale-result rejection, evidence categories and default no-answer contract remain intact. Free text is recorded without grading. Predictions do not move the board; requested facts cover the submitted move and immediate recapture, not optimality or a complete line. Source data and production storage/Worker entrypoints remain untouched.

## Independent executions and evidence review

| Verification | Result | Basis |
| --- | --- | --- |
| Guidance Node | 29 PASS / 0 FAIL / 0 skipped | Independently run on final bytes |
| Original sandbox model | 16 PASS / 0 FAIL / 0 skipped | Independently run |
| Original core | 42 PASS, including original 11 negative controls | Independently run; source unchanged |
| Original baseline | 667 PASS / 0 FAIL / 0 skipped, all 27 suites | Independently run; source unchanged |
| Guidance Chrome | 30 PASS, 21/21 faults detected | Independently run; five viewports |
| Original sandbox Chrome | 32 PASS, 11/11 faults detected | Final implementation evidence reviewed; app hash matches |
| Browser core | 29 Chrome PASS, 14/14 faults; 70 SHA vectors; 2 Node groups | Preserved source-matched evidence reviewed |
| Generator / AST | PASS; 11 modules, 16 edges, zero Node runtime dependencies | Generator and parser/negative-control evidence reviewed |
| Jekyll Safe Build | PASS; 74 approved Artifact files | Actual build script/log reviewed; output independently compared |
| Runtime / Cache | 70 raw Git byte matches; `356f6af929` | Independently compared; no newline normalization |
| Other worktrees / Snapshot | 21 worktrees, 148 Snapshot files unchanged | Independent full hash/ref/status check |

These overlapping sets are not added into an independent case total. Chrome 158.0.8127.38, Node 22.23.2; 320x568, 375x812, 390x844, 844x390, 1440x1000. Mouse, simulated touch, keyboard, Esc, branch switching, reset/cancel, delayed checks, editable predictions and bounded records were covered. Mobile rendering was independently inspected.

All 21 new mutants loaded and initialized successfully before the detection assertions. Only behavioral assertion failures counted, not import/startup errors. Historical redundant draft protections are disabled together where needed to reproduce the old fault, not counted as separate coverage.

## Seven original findings retained and fixed

| Finding | Original evidence in independent root | Final disposition |
| --- | --- | --- |
| R1: cancel reset loses unsaved draft | `preliminary-ui-probes.json` | Fixed; `fixed-ui-probes-01.json` and final Chrome |
| R2: saved draft leaves stale navigation closures | `preliminary-ui-probes.json` | Fixed; `fixed-ui-probes-01.json` and final Chrome |
| R3: malformed option removes check=yes | `expectation-isolation-diagnostic.log` | Fixed; `expectation-isolation-fixed-01.json` |
| R4: expectation controls mix branch/reset/fixture contexts | `expectation-isolation-02.json` | Fixed; `expectation-isolation-fixed-01.json` |
| R5: awaited check overwrites newly typed draft | `async-draft-initial.json` | Fixed; `async-draft-fixed-01.json` |
| R6: saving dirty text discards changed challenge selection | `limits-and-challenge-02.json` | Fixed; `limits-and-challenge-fixed-01.json` |
| R7: revision limit blocks navigation/reset | `limits-and-challenge-02.json` | Fixed; `revision-boundary-extended.json` |

All were P2 reproducers during development; R1/R5 share draft-ownership causes and are not seven independent risk classes. Original logs, probes, screenshots and implementation source preimages remain intact. Later success does not erase the original failures. The reviewer's first challenge probe timed out because its details panel was collapsed; corrected probe 02 supplied actual behavior evidence.

The revision-boundary retest preserved all 16 archived revisions plus the latest draft across Root/branch/reflection, canceled reset and confirmed reset. Record-capacity behavior uses a test-only in-memory limit of 1 to exercise the actual production limit branch; production remains 1024. This is not a stress/performance claim.

## Reviewed frozen file SHA-256

All filenames below are relative to `staging/thinking-coach-sandbox/`. The seven code/test hashes were identical before and after the independent final run and match the source used by the Artifact gate. Documentation was read after its final edit.

| File | SHA-256 |
| --- | --- |
| `app.mjs` | `bb41ac6f9354cb36a3010f3312d795e097a8da9c5ff3075750cb37d9003f5ece` |
| `index.html` | `ee87eb06b4213146b8f986c0b32c8a7fe95dbd1f325a385db9b0c155f27d417d` |
| `style.css` | `5b0000a692352234e4db33c3b111d385e0f7ea0ca8f3e05fd7b1a8aa40eaf56d` |
| `guidance-model.mjs` | `d2d9bc201413796a5cf74188d465c732af6fdce33e17e6149cdf9657dd1fe998` |
| `teaching-adapter.mjs` | `5c7a9c8ea6d720f68c0ea25d110a79000bc4d32a7a639a31a4eb76a34e9c392a` |
| `guidance-test.mjs` | `f3921cfe81b05d93ebfa6503bd915714695c6f05d80d958ad375918a9d4667e8` |
| `guidance-browser-test.mjs` | `15873a0864ccec24a496258d60cd27b627c49716e6ae4353f00c6626234d4699` |
| `README.md` | `9a627f3bd137232a162c2a17c37f4e9713d28f99bfd3d3465517807a325d1109` |
| `GUIDANCE_DESIGN.md` | `4ef73ba3f65ab47c4ab7d77e5b0109ae3efd7725d5005c8e54a0f4c8f14395df` |
| `GUIDANCE_TEST_REPORT.md` | `89d5dffe13e356c249b4a32950d7f144017319b34e8d0993e04aa75b672f5488` |

The copied independent report and final staged/commit manifest are packaging checks to perform without changing these runtime bytes. No merge or deployment is approved by this review.

## Evidence roots and hashes

Independent root: `C:/Users/Robin/AppData/Local/Temp/chess-u3-01b2-review-20261127/`. Implementation root: `C:/Users/Robin/AppData/Local/Temp/chess-u3-01b2-20261127/`. These are owner-local evidence paths, not public download URLs. `FINAL_REVIEW.json` contains the machine-readable review, full dispositions, limitations and this report's hash.

| Evidence | SHA-256 |
| --- | --- |
| independent / `preliminary-ui-probes.json` | `51bd08cc84267fbeeb8ff1cda458a3257b10c9aea2ec1847d7efafaffe0e5aef` |
| independent / `fixed-ui-probes-01.json` | `e64ee6bd8a645faf70e6bc756b419a4530c749cc23081c57a2a3b80c129491fb` |
| independent / `expectation-isolation-initial.mjs` | `0363fb838acadbe4cc9d05d1f629cc14eaef5e7761a2d45106ee5d6576da9975` |
| independent / `expectation-isolation-diagnostic.log` | `9fdfa9b1a1953fae5ce343c55a86e10903390c2cc64db701ab4c6514140213a4` |
| independent / `expectation-isolation-02.json` | `e311e4e592291663970b4ad1a379c2e59740fea53f750622f525cef1e6701225` |
| independent / `expectation-isolation-fixed-01.json` | `87f16002ad9cf965753fe7d6cbffd694098caee5787e4dc5a3bd186c4e1d4cf4` |
| independent / `async-draft-initial.json` | `1c360b7261cd80c5484d8b0466d7c3cc77bf73f4dca1c16ca9b57aec639b4924` |
| independent / `async-draft-fixed-01.json` | `dbef211052456dbd137ce83089ef9db00ccf8e679ee7153fccd918e746eed431` |
| independent / `limits-and-challenge-initial.mjs` | `f32d22417424bf64b8e4d86eecd3014d79e9b6b5166bd547ab4e154325318ae0` |
| independent / `limits-and-challenge-02.json` | `0e6774af2ad06feea943a48bafc2b51c2afb1c7623df034005641c883821235b` |
| independent / `limits-and-challenge-fixed-01.json` | `1034cb90b38ca3622508d065fa83ce79ea9f84f6ee181e2f086a59ba64f3fcea` |
| independent / `revision-boundary-extended.json` | `62fc88821f1152aef21073fd25f620cbce5d21dbd026cd505920bccf55461b11` |
| independent / `core-independent-01.log` | `831f68ce1ad0bd93c4bdc6c66af23b40616a4ba477ebb28c3fb2f83bd65f7bb6` |
| independent / `baseline-independent-01.log` | `74e1a163e3e7452b6dfdd2c61a5e1f44a5f024b01da081fa28df55d79042da82` |
| independent / `guidance-independent-final.log` | `c537411782440ec00d92fb28d925308d65d0a6d97ed9b97695e02f07c8f14cd9` |
| independent / `model-independent-final.log` | `da03aaf8767891bb1ba1dbec4a609411e5e22fcd014b76248ab4241efa370484` |
| independent / `guidance-browser-independent-final/results.json` | `486090f7a1c7f1f4d60c731f8ba350eec855d42ffe1af68ac129002306002dfa` |
| independent / `guidance-browser-independent-final.log` | `df6f8147a1b9beb3fe8cf2f6c07ac2156ae37f5c6b3b4343be6e68d87cd834cd` |
| independent / `final-code-hashes-before.json` | `09c75ed47d4706f786ab528219b00bbc1a982afdda4651fb03a4fd0b5a31f1e1` |
| independent / `final-code-hashes-after.json` | `09c75ed47d4706f786ab528219b00bbc1a982afdda4651fb03a4fd0b5a31f1e1` |
| independent / `artifact-independent-verification.json` | `42b5169a13749fa4a96bb0c8de20f5698b0096e322d2f26e2bcd38a5de164214` |
| independent / `protection-independent-final.json` | `800e96c8f3cc98740c1b59fc9a722a7eb7bd762f002991a09244c8591bff78fb` |
| implementation / `AST_GATE.json` | `32f2e6fda167623eca06030f431019e23abb88b3c5aa8c9ca3f0f3337ab12e14` |
| implementation / `artifact-integrity.json` | `d1d699d388433da290b97b39f5a52e74816d316f5b6535f7d738d1347bdf6b98` |
| implementation / `jekyll-build.log` | `64a797b7be1e7f33d18105ddd5fc50af5376ac52fd777a5c47a7335d3d7c49a7` |
| implementation / `source-manifest.json` | `954edd1d9cd9bba93c6af460b132d9892e32ba253b8191f41ab967052a7c910e` |
| implementation / `guidance-browser-03/results.json` | `f991b53a08fa721ca6913ede6a8ef3268e1ae2877f2e42ebe26b427e33b6d17d` |
| implementation / `legacy-browser-final-02/results.json` | `e241a3ddd1df7a562d095eaa166382b00873077e0cd8a564d6af5a51e033153a` |
| implementation / `browser-core/results.json` | `2844fa86203df2e689651997f3742e17bec364b81eb1e523cdef403de7d867d9` |
| implementation / `generator.json` | `a97e88e32680679c40f4570230d1b3b30ce207ca25abc984100561758490a869` |
| implementation / `protection-review.json` | `800e96c8f3cc98740c1b59fc9a722a7eb7bd762f002991a09244c8591bff78fb` |
| implementation / `app-before-review-fixes.mjs` | `1a3c21a9fc68ac54fa427449bb2fec03c0ff95ea65e4073c3aa935e66a072d1c` |
| implementation / `guidance-model-before-review-fixes.mjs` | `d7f21f0f5d2b1d6390dcb9b5bd9823880566edebca5c98c91d42ea0a3c42c0a7` |
| implementation / `app-before-expectation-fixes.mjs` | `8e3d1df2bee325c313c0dbb82d694f422987795ae956829b94c265b41b625640` |
| implementation / `index-before-expectation-fixes.html` | `b4abb7b47a7836d05bc1ddc7a841b5d163888e08f09328b700021fca47369e99` |
| implementation / `app-before-async-draft-fix.mjs` | `d9b2a7877fc65d557c9224c84558d0b682f28f17a692d0105480c1cbeaab680c` |

## Remaining limits and historical status

No real-device, screen-reader, human UAT, actual BFCache, long-term heap/performance or teaching-outcome study was performed. No educational effectiveness is claimed. The trusted-realm boundary does not defend against hostile same-origin JavaScript or replaced browser intrinsics. Current drafts are memory-only and bounded, not durable journals.

The original four BASELINE_FAIL results, subsequent test maintenance, Proxy reentry P2, focus/reset failures, CRLF manifest, scanner false positives, timing/probe exceptions and HTTP503 evidence remain historical facts. PR #21 remains `BLOCKED_PRODUCTION_ACCEPTANCE`; Issue #22 stays OPEN and its HTTP paths were not retried. Local PASS and NO_CHECKS_REPORTED do not mean GitHub CI PASS.

No remaining review blocker. No authorization for merge, deployment, rollback or U3-01C.
