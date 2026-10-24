# Modeling assumptions and scientific boundaries

## Official challenge workspace

The default workspace now loads the organizer's 64-segment/59-node map and six fictional reports. All reports are initial evidence, never replayed as later updates. Unknown electrical connectivity, loads, live status and charging power remain unknown. LINE_024 is known de-energized; its damage is unknown. Default charging eligibility at twelve other sites is an explicit demo assumption, with a conservative no-assumptions mode.

Five fully charged packages start perched at declared line IDs. Every flight is at most 30 minutes and requires a full uninterrupted 180-minute charge after arrival before the next flight. Live=True AND sufficient_power=True are mandatory; voltage tags do not establish eligibility. Perched measurements may overlap charging. Interrupted charging restarts from zero. The official four-hour horizon is used. Positive/negative/inconclusive later readings are hypothetical; only informative readings update beliefs. No official fault ground truth, customer supply or actual restoration is inferred. Details and formulas: OFFICIAL_CHALLENGE.md.

The remaining sections describe the separate, preserved **Synthetic laboratory**, whose service-impact model and mission endurance are not the official operational rules.

## Data and electrical service

- The network is synthetic: 22 nodes, 21 radial lines, one energized source, three geographic hazard zones, four critical sites and default two sensors. Coordinates, customer counts and demand are illustrative; local x/y values are kilometres. Geographic coordinates provide context, not an actual utility model.
- A load is supplied if an intact path connects it to any energized source. The reachability functions also support redundant paths and multiple sources, verified by tests.
- There is no AC/DC load flow, voltage, thermal capacity, protection, switching, phase imbalance, distributed generation, cascading failure or islanding control. Connectivity can overestimate the service a real feeder could safely provide.
- Failure states are fixed for one mission. Sources are always available. Lines have binary intact/failed states; nodes do not fail.
- Critical sites are counted equally within the criticality term. This is not a monetary valuation or clinical priority model.

## Hazard and Bayesian inference

Severity index `s` is 0, 1 or 2 for Low, Medium and High. Vulnerability `v` and exposure `e` are line-specific values in `[0,1]`:

`P(failure | s,v,e,hazard) = 1 / (1 + exp(−(b_h + a_h s + 2v + e)))`.

| Hazard | Intercept `b_h` | Severity coefficient `a_h` |
| --- | ---: | ---: |
| Storm | −4.50 | 1.35 |
| Wildfire | −4.75 | 1.60 |
| Heatwave | −4.90 | 1.15 |

| Scenario setting | P(Low) | P(Medium) | P(High) |
| --- | ---: | ---: | ---: |
| Low | 0.78 | 0.18 | 0.04 |
| Medium | 0.18 | 0.64 | 0.18 |
| High | 0.08 | 0.27 | 0.65 |

These coefficients and priors are pedagogical, not empirically calibrated. The hidden severity is sampled once independently per zone. Conditional on severity, individual line failures are sampled independently. Different zones are independent, so cross-zone storm correlation is omitted.

Sensors share fixed sensitivity and specificity over the mission. A positive report may be a false positive; a negative report may miss a real fault. Reports are conditionally independent given the corresponding line state. Only one report per line is permitted; repeated updates are idempotent and are not treated as extra evidence. There is no external confirmation stage.

Inference enumerates all three severity states. Original priors and each unique likelihood produce the current posterior. Previous observations remain evidence when later reports update their zone. No hidden truth enters policy scoring. Information gain is expected entropy reduction in **zone severity**, rather than reduction in total grid-state entropy or a guarantee of better service.

## Impact and restoration

The normalized impact combines demand, customer count and critical sites with configurable weights (default 0.5/0.3/0.2, normalized to unit sum). Isolated edge contingencies assume all other lines are intact. They describe structural consequences and can overlap.

Expected outage uses finite Monte Carlo samples of the joint posterior, preserving shared-zone correlation. The UI uses a fixed sampling seed to reduce visual noise; estimates retain numerical Monte Carlo error. Actual simulated outage is available only to the evaluator and is not sensor-observed service status.

Repair-support opportunity is the expected marginal service gain if one line were made intact while all other sampled states stayed fixed. It is an instantaneous counterfactual. No crew, safety validation, travel-to-repair, repair time, protection check, dispatch, restoration completion or interruption duration is modeled. An inspected line remains failed in the hidden environment. Do not label reports as verified faults or estimated opportunity as delivered restoration.

## Missions and decisions

- Travel is Euclidean and constant-speed (0.6 km/min by default). Inspection durations are deterministic line attributes. Detailed flight dynamics, routing around obstacles, regulatory authorization, airspace, visibility, precipitation, wind, vegetation, wildfire exclusion zones, electromagnetic interference, communications and landing safety are omitted.
- The storm scenario describes a post-event inspection window that is assumed safe; the software does not authorize flight.
- Battery is represented by remaining travel-plus-inspection endurance. Idle waiting is assumed landed and has no endurance cost. Every assignment reserves a return-to-base route within both remaining endurance and mission time. Sensors cannot recharge from de-energized lines; no in-mission charging is implemented.
- Assignments are exclusive and nonpreemptive. Other sensors' pending lines cannot be selected. A report triggers replanning for available sensors; in-flight assignments are not redirected.
- Scores are transparent heuristics. Benefit terms are normalized over the current feasible candidates before weighted combination; therefore scores are relative and need not be comparable across decision times.
- Information collection and repair support are distinct. A one-step lookahead can value changes to subsequent choices, but it cannot provide long-horizon optimality or actual restoration guarantees.

## Evaluation

Scenario truth and per-line report randomness are matched across policies using separate deterministic streams. A policy only detects a true fault when the simulated line is failed **and** the report is positive. Coverage counts completed inspections regardless of report sign. Weighted detected and undetected fault impact is an additive contingency proxy; it is not an additive estimate of actual disconnected demand.

Time to first detected critical fault is conditional on detecting one. The detection rate and nondetection count must be shown. Some seeds contain no critical faults; do not interpret nondetection automatically as poor policy performance. Small-seed empirical variability or bootstrap intervals are descriptive; do not claim statistical significance. Computational runtime includes policy planning, including heuristic lookahead, but varies by machine and concurrent load.

Real-world performance requires representative topology, hazards, sensing data, calibration, safety review and validation against service outcomes. This hackathon prototype is not production-ready or suitable for autonomous grid operations.
