# Repeated certified frozen event cursor: finite CPU measurements

This 2026-10-11 research batch supports a narrow local benefit for immediately rereading the same already-certified frozen array. S1 paired baseline/candidate elapsed-median ratios were 16.17–97.62× for the cursor on Node 22.23.2 and 24.03–76.43× on Node 24.19.0; flow ratios were 11.54–50.36× and 9.92–41.61× respectively. S2–S4 show no consistent benefit across the control groups; slower candidate observations remain in the results.

Root adopted this report on 2026-10-11 after reading the draft, checking its bindings and reconciling all 32 displayed result groups with the completed provider-free batch. It is not release acceptance or a timing threshold. Exact public parity passed within the measured fixture scope, as independently reconciled by root's existing FULLPARSE receipt.

## Source and measurement identity

Baseline B is commit `43e484ee64d28af01c5d378422c10cc0dfa578bd`, tree `28297ea26b818d359a96f44ef3153aff652a907e`. Candidate C is commit `c29018c9929b29fd534d0cf60229b7706917a257`, tree `d21a056f753a955d33ee6fa2d6559a7e34ee513d`. Each complete frozen source contains 215 tracked files with no excluded paths; the recorded variant delta is exactly `lib/plugins/event-projection.mjs`, `docs/PERFORMANCE.md`, and `docs/ORCHESTRATION.md`. Their tests are identical.

The candidate includes the product implementation accepted at `8f02d99b1c2ffdd4b62972f9f9d0d8e8e015443b`; root implementation acceptance SHA256 is `b2ae336dbdfcd79f6aea2182dfbdca6b2ece4e90967e76c35fa647ce8b105a50`. That acceptance and the later measurement evidence have distinct scopes.

The fixed V2 harness ran on Linux 6.18.44, x86_64, with recorded affinity CPUs 0–4. The root launcher removed only the ambient `NODE_PATH`; the collector and children inherited that remaining environment unchanged. Environment identity is SHA256 `5e8315c50b3f37372d07e4f74177c7dbe684975fbdf1ca25b0f981037296dfcd`; stable CPU identity is `ac3eb1736651fb7535aa0fa0d7278500217b82d1b163f3e9524f0d43703eac21`. Source, both binaries, authority and host/environment bindings were checked at recorded endpoints; this does not establish continuous global quiescence.

## Fixed method and public checks

One batch completed 12 serial child processes: Node 22.23.2 first, then 24.19.0, with pair order B/C, C/B, B/C for each pin. Each child used sizes 40,000 and 100,000, S1–S4 in order, and separate cursor/flow fixtures and instances: 16 series. Every series performed one separately recorded setup read, three warmups and ten measured reads. Counts are 224 total / 160 measured reads per child and 2,688 total / 1,920 measured reads for the batch. No retry, resume, calibration or added sample was used.

| Scenario | Fixed input and required public behavior |
| --- | --- |
| S1 | One strongly held deeply frozen dense array, repeated by exact identity; after setup, cursor returns a fresh empty tail and flow retains `processedEvents=n`. |
| S2 | Fourteen prebuilt distinct frozen arrays sharing immutable event references; full distinct-input comparison remains, with fresh empty tails and `processedEvents=n`. |
| S3 | Fourteen distinct frozen append snapshots of lengths `n…n+13`; each later cursor tail contains the actual appended reference and flow has `processedEvents=n+i`. |
| S4 | One frozen outer array with mutable event graphs; event 0's tool name alternates before every read. Cursor resets on every read; flow replays and has `processedEvents=n*(i+1)`. |

The timed API call was `createEventCursor().read(input)` or `createFlowProjection(new Set(['subagent']), 'tool-result').read(input)`. S4's cursor can reject the mutable graph early; its flow call also performs replay, so their timings describe different work.

Fixture preparation, imports, instance creation, full-fold oracle preparation, independent closed-form checking, public-result validation and reporting are outside each timed read. Timer order is elapsed start, CPU start, synchronous read, CPU delta, elapsed end. Raw elapsed includes both CPU accounting calls; raw CPU is user plus system microseconds and excludes the final elapsed-clock read.

Every read has a separately recorded empty timing window. Across series/processes, its measured-sample medians range from 0.9265 to 1.8225 µs elapsed and 0 to 1 µs CPU. These values are descriptive only: no overhead subtraction, clamping, zero removal, slow-sample discard or threshold was applied. Setup and warmup values remain in the raw files, outside the predetermined ten-sample medians.

Root reconciled the cursor's reset, tail length, identity and freshness records, the exact flow snapshots and counters against the closed form, timing-field consistency, counts and cross-child public-result fingerprints. The harness also checked flow against full replay and asserted the appended-event reference. All 12 children completed and were reaped with exit 0 and empty stderr. Their recorded 30-second benchmark targets / 35-second collector bounds concern this optional batch only.

## Complete results

All times below are µs. Each time cell lists the three **per-process medians in pair order 1 / 2 / 3**, followed by their **minimum–maximum across those three medians** in brackets. Each median uses that process's ten measured samples. Brackets are not raw-sample ranges or confidence intervals. Ratios are B elapsed median / C elapsed median for each corresponding pair; values below 1 mean C was slower. Values are rounded to three decimals here; exact values and raw timings remain in the receipt/files.

There are 32 groups: two Node pins × four scenarios × two sizes × two APIs. Samples are never pooled across processes, pins, scenarios, sizes or APIs.

| Node | Case | n | API | B elapsed: 1 / 2 / 3 [range] | C elapsed: 1 / 2 / 3 [range] | B CPU: 1 / 2 / 3 [range] | C CPU: 1 / 2 / 3 [range] | Paired elapsed B/C: 1 / 2 / 3 |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| 22.23.2 | S1 | 40,000 | cursor | 259.58 / 261.152 / 260.607 [259.58–261.152] | 16.049 / 16.074 / 12.118 [12.118–16.074] | 258.5 / 259.5 / 260 [258.5–260] | 15 / 15 / 11.5 [11.5–15] | 16.174 / 16.247 / 21.506 |
| 22.23.2 | S1 | 40,000 | flow | 293.421 / 270.126 / 280.798 [270.126–293.421] | 24.828 / 23.4 / 21.587 [21.587–24.828] | 292 / 269 / 280 [269–292] | 24 / 23 / 21 [21–24] | 11.818 / 11.544 / 13.007 |
| 22.23.2 | S1 | 100,000 | cursor | 679.922 / 630.062 / 959.066 [630.062–959.066] | 11.042 / 10.07 / 9.825 [9.825–11.042] | 678.5 / 629.5 / 955.5 [629.5–955.5] | 10 / 10 / 9 [9–10] | 61.576 / 62.568 / 97.62 |
| 22.23.2 | S1 | 100,000 | flow | 652.38 / 659.281 / 944.73 [652.38–944.73] | 18.348 / 18.567 / 18.758 [18.348–18.758] | 650.5 / 656.5 / 940.5 [650.5–940.5] | 18 / 18 / 18 [18–18] | 35.556 / 35.507 / 50.363 |
| 22.23.2 | S2 | 40,000 | cursor | 2188.519 / 2055.869 / 2384.564 [2055.869–2384.564] | 2376.231 / 2433.697 / 2583.202 [2376.231–2583.202] | 2187 / 2053.5 / 2380.5 [2053.5–2380.5] | 2372 / 2430 / 2579 [2372–2579] | 0.921 / 0.845 / 0.923 |
| 22.23.2 | S2 | 40,000 | flow | 1130.514 / 1149.062 / 1247.93 [1130.514–1247.93] | 1236.863 / 1242.523 / 1171.195 [1171.195–1242.523] | 1129.5 / 1148 / 1244.5 [1129.5–1244.5] | 1235 / 1240 / 1170.5 [1170.5–1240] | 0.914 / 0.925 / 1.066 |
| 22.23.2 | S2 | 100,000 | cursor | 3163.454 / 3199.583 / 3216.168 [3163.454–3216.168] | 3043.494 / 3123.403 / 3413.014 [3043.494–3413.014] | 3157.5 / 3196.5 / 3188 [3157.5–3196.5] | 3041 / 3118.5 / 3408 [3041–3408] | 1.039 / 1.024 / 0.942 |
| 22.23.2 | S2 | 100,000 | flow | 3147.69 / 2965.712 / 3212.979 [2965.712–3212.979] | 3118.051 / 3096.413 / 3261.406 [3096.413–3261.406] | 3144 / 2962 / 3210 [2962–3210] | 3100 / 3091.5 / 3257.5 [3091.5–3257.5] | 1.01 / 0.958 / 0.985 |
| 22.23.2 | S3 | 40,000 | cursor | 2146.275 / 2367.398 / 2485.159 [2146.275–2485.159] | 2648.546 / 2531.544 / 1197.039 [1197.039–2648.546] | 2144.5 / 2343 / 2482 [2144.5–2482] | 2645 / 2529.5 / 1195 [1195–2645] | 0.81 / 0.935 / 2.076 |
| 22.23.2 | S3 | 40,000 | flow | 1160.208 / 1255.231 / 1185.046 [1160.208–1255.231] | 1248.706 / 1327.825 / 1165.702 [1165.702–1327.825] | 1159 / 1253.5 / 1184 [1159–1253.5] | 1247 / 1325 / 1164.5 [1164.5–1325] | 0.929 / 0.945 / 1.017 |
| 22.23.2 | S3 | 100,000 | cursor | 3131.981 / 3434.441 / 3094.515 [3094.515–3434.441] | 3221.145 / 3668.372 / 3445.978 [3221.145–3668.372] | 3127.5 / 3431.5 / 3090.5 [3090.5–3431.5] | 3218.5 / 3662 / 3442.5 [3218.5–3662] | 0.972 / 0.936 / 0.898 |
| 22.23.2 | S3 | 100,000 | flow | 3286.739 / 3057.89 / 3186.534 [3057.89–3286.739] | 3337.311 / 3081.365 / 3286.574 [3081.365–3337.311] | 3282 / 3055.5 / 3182 [3055.5–3282] | 3334 / 3078.5 / 3282.5 [3078.5–3334] | 0.985 / 0.992 / 0.97 |
| 22.23.2 | S4 | 40,000 | cursor | 16.835 / 19.45 / 17.281 [16.835–19.45] | 21.197 / 19.38 / 21.532 [19.38–21.532] | 16.5 / 19 / 17 [16.5–19] | 20.5 / 18 / 21 [18–21] | 0.794 / 1.004 / 0.803 |
| 22.23.2 | S4 | 40,000 | flow | 17238.339 / 19319.607 / 19783.541 [17238.339–19783.541] | 17545.09 / 19275.648 / 18723.415 [17545.09–19275.648] | 17774 / 19770 / 20374 [17774–20374] | 18124 / 19583 / 19585.5 [18124–19585.5] | 0.983 / 1.002 / 1.057 |
| 22.23.2 | S4 | 100,000 | cursor | 14.732 / 12.579 / 13.581 [12.579–14.732] | 14.953 / 14.402 / 14.001 [14.001–14.953] | 14 / 12 / 13 [12–14] | 15 / 14 / 14 [14–15] | 0.985 / 0.873 / 0.97 |
| 22.23.2 | S4 | 100,000 | flow | 49688.549 / 46472.755 / 46690.289 [46472.755–49688.549] | 45452.135 / 43758.959 / 50201.678 [43758.959–50201.678] | 51337 / 47458 / 47583 [47458–51337] | 46070.5 / 44574 / 50902.5 [44574–50902.5] | 1.093 / 1.062 / 0.93 |
| 24.19.0 | S1 | 40,000 | cursor | 303.751 / 302.68 / 302.454 [302.454–303.751] | 12.639 / 11.402 / 11.994 [11.402–12.639] | 303 / 308 / 319.5 [303–319.5] | 12 / 11 / 11.5 [11–12] | 24.034 / 26.546 / 25.218 |
| 24.19.0 | S1 | 40,000 | flow | 287.837 / 283.871 / 272.539 [272.539–287.837] | 27.026 / 22.559 / 27.477 [22.559–27.477] | 285.5 / 282.5 / 272 [272–285.5] | 26 / 22.5 / 26.5 [22.5–26.5] | 10.65 / 12.584 / 9.919 |
| 24.19.0 | S1 | 100,000 | cursor | 1265.316 / 1111.601 / 1162.171 [1111.601–1265.316] | 16.555 / 16.66 / 16.7 [16.555–16.7] | 1262 / 1109.5 / 1170 [1109.5–1262] | 16 / 16 / 16 [16–16] | 76.433 / 66.723 / 69.591 |
| 24.19.0 | S1 | 100,000 | flow | 1156.693 / 1142.903 / 1016.528 [1016.528–1156.693] | 27.857 / 27.466 / 25.729 [25.729–27.857] | 1155 / 1156.5 / 1014.5 [1014.5–1156.5] | 27.5 / 26.5 / 25.5 [25.5–27.5] | 41.523 / 41.612 / 39.509 |
| 24.19.0 | S2 | 40,000 | cursor | 2232.449 / 2049.244 / 1985.113 [1985.113–2232.449] | 2202.6 / 2130.847 / 1253.113 [1253.113–2202.6] | 2229.5 / 2039.5 / 1983 [1983–2229.5] | 2198.5 / 2127 / 1251.5 [1251.5–2198.5] | 1.014 / 0.962 / 1.584 |
| 24.19.0 | S2 | 40,000 | flow | 1213.153 / 1210.274 / 1252.131 [1210.274–1252.131] | 1275.772 / 1337.695 / 1213.709 [1213.709–1337.695] | 1212 / 1209.5 / 1250.5 [1209.5–1250.5] | 1274 / 1335.5 / 1212 [1212–1335.5] | 0.951 / 0.905 / 1.032 |
| 24.19.0 | S2 | 100,000 | cursor | 3649.194 / 3148.551 / 3150.775 [3148.551–3649.194] | 3236.423 / 3273.184 / 3453.689 [3236.423–3453.689] | 3645.5 / 3146 / 3149 [3146–3645.5] | 3234.5 / 3271 / 3451.5 [3234.5–3451.5] | 1.128 / 0.962 / 0.912 |
| 24.19.0 | S2 | 100,000 | flow | 3826.21 / 3278.151 / 3246.98 [3246.98–3826.21] | 3399.874 / 3521.387 / 3254.546 [3254.546–3521.387] | 3822 / 3276.5 / 3245.5 [3245.5–3822] | 3397 / 3519.5 / 3252.5 [3252.5–3519.5] | 1.125 / 0.931 / 0.998 |
| 24.19.0 | S3 | 40,000 | cursor | 1543.133 / 1515.693 / 1444.06 [1444.06–1543.133] | 1609.369 / 1454.702 / 1485.512 [1454.702–1609.369] | 1544 / 1514.5 / 1451 [1451–1544] | 1607 / 1482.5 / 1497.5 [1482.5–1607] | 0.959 / 1.042 / 0.972 |
| 24.19.0 | S3 | 40,000 | flow | 1303.789 / 1232.979 / 1303.524 [1232.979–1303.789] | 1217.314 / 1223.269 / 1346.994 [1217.314–1346.994] | 1302 / 1232 / 1302.5 [1232–1302.5] | 1216 / 1222.5 / 1346 [1216–1346] | 1.071 / 1.008 / 0.968 |
| 24.19.0 | S3 | 100,000 | cursor | 3360.52 / 3200.053 / 3232.342 [3200.053–3360.52] | 3649.82 / 3619.434 / 3237.635 [3237.635–3649.82] | 3357.5 / 3198 / 3230.5 [3198–3357.5] | 3647.5 / 3616 / 3235 [3235–3647.5] | 0.921 / 0.884 / 0.998 |
| 24.19.0 | S3 | 100,000 | flow | 3598.347 / 3311.251 / 3421.521 [3311.251–3598.347] | 3370.25 / 3298.812 / 3307.59 [3298.812–3370.25] | 3645 / 3309.5 / 3419 [3309.5–3645] | 3368 / 3296 / 3305.5 [3296–3368] | 1.068 / 1.004 / 1.034 |
| 24.19.0 | S4 | 40,000 | cursor | 18.277 / 15.388 / 17.236 [15.388–18.277] | 16.22 / 17.201 / 13.345 [13.345–17.201] | 18 / 15 / 17 [15–18] | 15.5 / 16 / 13 [13–16] | 1.127 / 0.895 / 1.292 |
| 24.19.0 | S4 | 40,000 | flow | 17922.503 / 16207.515 / 17189.296 [16207.515–17922.503] | 18164.531 / 16729.315 / 16097.189 [16097.189–18164.531] | 18158 / 16526.5 / 17258.5 [16526.5–18158] | 18372 / 17355 / 16237 [16237–18372] | 0.987 / 0.969 / 1.068 |
| 24.19.0 | S4 | 100,000 | cursor | 12.934 / 13.11 / 12.599 [12.599–13.11] | 13.445 / 12.789 / 13.225 [12.789–13.445] | 13 / 13 / 12 [12–13] | 13 / 12.5 / 13 [12.5–13] | 0.962 / 1.025 / 0.953 |
| 24.19.0 | S4 | 100,000 | flow | 50065.201 / 42262.883 / 45027.817 [42262.883–50065.201] | 42908.215 / 51621.933 / 44698.813 [42908.215–51621.933] | 51774.5 / 43567.5 / 45926.5 [43567.5–51774.5] | 44873 / 54195 / 47222.5 [44873–54195] | 1.167 / 0.819 / 1.007 |

S1 is consistent with the reviewed source change: after current iterator checks, an immediate exact repeat of an already-certified frozen dense immutable array may skip only the prior-reference loop through an optional WeakRef. Distinct or uncertified inputs retain the original comparison/reset/early-exit path; lost or failing hints fall back. Fresh tails, reducer append and snapshot still occur, and no snapshot result is cached.

Control ratios span 0.794–2.076 across individual pairs. For example, Node 22 S2/100,000/cursor has a slower candidate pair, and Node 24 S4/100,000/flow records 1.167 / 0.819 / 1.007. The table retains this variability and does not imply statistical significance from three pairs or general speedup of distinct-array, append or mutable-replay workloads.

## Evidence locations and SHA256 bindings

Let E be `/workspace/imperator-evidence/20261011`, R be `E/root-integration-twenty`, P be `E/frozen-cursor-cpu-benchmark-preparation-v2`, and BATCH be `E/task20-cpu-batch-20261011-c29018c-v1`. The following are exact file identities, not reproduction commands.

| Artifact | SHA256 |
| --- | --- |
| R/cpu-batch-task20-cpu-batch-20261011-c29018c-v1-root-read-v1.json | `29207fc2105b60e6e9ae6c2de85170a4fd8e3a6867c700c78335f35e348b7190` |
| BATCH/batch-result.json | `26d5374e49299090f3b6fc23f1bf8e54b764340ad3b768b589f90788386e01d3` |
| BATCH/raw-artifact-manifest.json | `6e4050ee5d4a8cc2c8668d53bc442598129b2aec66e9285fbae3626bfca20235` |
| R/cpu-runtime-go-20261011-c29018c-v1.json | `b02dac87baee0634a177f0581bacf53768b1d7a2036a7c64af9fae72c94943ed` |
| R/benchmark-baseline-frozen/source-manifest.json | `d6c8387ebea0e4c107c6c1888d233b003d1484d251660a2ac19acfaace423a78` |
| R/benchmark-candidate-frozen/source-manifest.json | `2e2e10b0be81540dabc51c75d37338305c5531cd81aff0a20105a9532d6a3167` |
| P/artifact-manifest.json | `2293b3550f1e8029443e0d466c8846dd3d88e1b1e1637af80097122a0deb914b` |
| P/benchmark-child.mjs | `b89b223f57ef60e1c0b32e975bb47d20050b0e6f86dc5c57caa19a81f8a712a4` |
| P/collect_benchmark.py | `f143be6b781528f5d2b764c4c4497159624702f4bfbddc72a1d457be67ef9038` |
| Node 22.23.2 binary, exact path in runtime GO | `3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327` |
| Node 24.19.0 binary, exact path in runtime GO | `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12` |

Each following file is `BATCH/<child>/stdout.ndjson`; all setup, warmup and measured read records remain available there.

| Child | Raw stdout SHA256 |
| --- | --- |
| 01-node22.23.2-pair1-baseline | `8d4d772c2afbcf4c56ddcf1ef98b9284402a53aa3002d84de9d9e132e2515c4c` |
| 02-node22.23.2-pair1-candidate | `43b765496aa91ce504348e3ef5ec90da1bfe9c318156b77f639c52c44ef6eeb4` |
| 03-node22.23.2-pair2-candidate | `7202d66acf6c905577353c82dd8d7dc13157b203a0c5183fd9d763a2efc97964` |
| 04-node22.23.2-pair2-baseline | `442b0a355104f0ac0150bc728b056261326804d3d5414e8c233ab17e702709ee` |
| 05-node22.23.2-pair3-baseline | `0df6e8e0daf5a7a500753e4aeae237ca36b8d51cfabb5e716e4c0502769fb00c` |
| 06-node22.23.2-pair3-candidate | `f698c848183ce67666e8f7703c25afa6ba8863f35cde8018bcc001273cff6495` |
| 07-node24.19.0-pair1-baseline | `df67608f13e92a865dac86c207cd17cdfcdb2a1b12b59619bacfada2287b08a6` |
| 08-node24.19.0-pair1-candidate | `107fc75088dbeb086d2d9d72d14fcb2e37ce9c4f7b0cdbfd51b0a29779bab03d` |
| 09-node24.19.0-pair2-candidate | `b4d286552769bd03406bfc622acffc5d9562540f13879c6a9f45a0639a9f560c` |
| 10-node24.19.0-pair2-baseline | `0f329596a8388c8d8920f87c6acb8621c934c3f5fb6ccf01253d7aa1bc26580f` |
| 11-node24.19.0-pair3-baseline | `00e6bdf03c87456ceca7a544cb4ba9e6eba3fb09d7cfbdfd8e4ae110b506c2ba` |
| 12-node24.19.0-pair3-candidate | `18f715a22eaa560c5e4dbda0887c36fc964d444a2d062da3a2064dda512a5d57` |

Root's receipt records 73 manifest artifacts rehashed and all 259 records per child parsed, including all 2,688 public-read/timing/oracle assertions; its cross-child semantic fingerprint is `dc306f27c8b2e61d1baa68a1986b3643be13c34032a2867926a1344411123ded`. This draft author read methodology, harness and root-reader source as text, inspected the receipt's derived metrics and scope, checked all 96 pair-to-child metric mappings, and rehashed the cited raw stdout files. This is not an independent author revalidation of all 2,688 raw reads. Root's receipt field `runtime_executed:false` describes its static reader; the completed batch is recorded separately.

## Limits and unchanged acceptance status

The fixtures strongly own the arrays, and all 14 reads in each series execute synchronously in one job. WeakRef creation/dereference keeps targets alive through that job; the fixed `setImmediate` boundary is after the series and outside timing. No forced GC occurs. This does not measure cross-job hint survival, production hit rates, collection timing, retained memory or a leak.

These cursor/flow windows do not measure complete guard/context pre-step hooks, native startup or cold boots, model/provider latency, production duration, or the cause of historical production stops. No O(1) whole-step claim, native-deadline saving or original-gate PASS follows. The historical paid result 8237 remains FAILED; the latest recorded native 60-second failures remain failures. Historical green runs elsewhere in PERFORMANCE.md do not replace current candidate acceptance.

The original 60,000 ms verifier-child limit, 12,000 ms native targets/watchdogs, both 10,000 ms cleanup budgets, 180,000 ms model stage, request cap 80, output cap 8192, Node/SDK pins, cases, cold boots, CLI/reporters/concurrency/order and acceptance gates remain unchanged. The 65,000 ms standalone native diagnostic collector does not supply an aggregate verify-all deadline. The SDK adapter stays closed. This finite measurement addresses only the local research question; every later integration or release decision remains separate.
