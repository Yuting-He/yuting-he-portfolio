# GridScout digital twin demo guide

## Explain the Bayesian probability to judges

Load the dynamic mission with seed42, jump to55 and advance5 to60. Select LINE_058 in **Inspect asset**, which turns off priority following, and open **Decision network**. Show its window prior, sensor-only88.4% and clear-inspection55.5%. The exact eight-state posterior table and raw/used residuals support those numbers. Explain that the clear view is imperfect and sensor/installation trouble can coexist with a physical anomaly.

Advance past75 to see the inspection expire. Current probability excludes it; choose its **Evidence snapshot** to replay the historical same-window update. Use the hypothetical inspection preview to compare supports, clear and inconclusive without affecting mission evidence. The time chart shows per-window beliefs and missing-observation gaps. The DBN assessment is documented in BN_TEMPORAL_DESIGN.md; no recursive confidence or unsupported transition rates control the mission.

## Default live digital twin

Open **Digital twin · Live simulation**. **Automatic dispatch & inspection** starts enabled. All telemetry, weather, warnings and inspection outcomes are hypothetical exercise data on the real mapped asset geometry. No connection or API key is needed. The simulation does not control aircraft or analyze camera images.

1. Press **Load dynamic mission** and start at T+000 with seed 42. Show five devices, 5/64 directly observed sites and the distinct Unknown map state. The clock is initially paused; automation runs when Play or an advance control moves it.
2. Press **Advance 1 min** or **Play stream**. Explain the latest plan change and the task reason shown in **Inspection progress**. Watch queued/deferred tasks, feasible flight routes, moving device positions and the subsequent stationary inspection. The scheduler consumes public reports and received evidence, without access to future faults.
3. Select a task and compare all five candidate drones. Read why this unit was selected and why another unit is unavailable, slower, protecting current evidence or still charging. Show the selected cruise speed and travel time. The confirmed maximum is 60 m/s; routine 20, high-priority 40 and critical 60 m/s are demo policy choices. Fast transit data have poor measurement quality and are excluded from line-state inference.
4. Show the map legend: dashed arrow = planned route, cyan path = travelled, ring = queued/inspecting. Show the task's arrival/result countdown and **Mission history**. An on-site check requires no flight. A committed flight continues to its destination, and a relocated drone recharges for a full 180 minutes while stationary sensing and inspection may continue.
5. In **Weather & provenance**, explain the received gust forecast and deferrals. The dynamic feed receives a lead at T+20, corrects its location at T+29 and withdraws it at T+32. Show superseded/cancelled pending work in the history; earlier versions remain auditable. Forecast hazard windows can delay flight even after a faster candidate has been considered. A warning alone does not confirm damage.
6. Continue until the new LINE_058 request arrives at T+46, or use **Jump to 55 min** to inspect the accumulated history. Show the selected drone and the pending related LINE_015 request received at T+50. Continue Play or controlled steps until a fresh inspection result arrives, then read how it changes the follow-up's priority and assignment. Arrival and completion times follow the selected speed, constraints and prior actions; do not narrate a fixed arrival minute.
7. Read what the check found: a simulated view supports an abnormality, reveals no visible cue or remains inconclusive. Compare the displayed BN values before and after the view using the same telemetry window. A clear view remains uncertain evidence. Show any bounded recheck or new episode and its reason. The scheduler is an explainable heuristic rather than a globally optimal mission planner.
8. Show **HUMAN ACTION REQUIRED** when current evidence or an unresolved deadline requires a person. Read its asset, requested action and reason. Critical evidence can request immediate review without waiting for another inspection. Use **Acknowledge** to record receipt; the request remains unresolved and monitoring continues.
9. Open **Evidence & baseline** for channel values, conditional normal intervals and missing evidence. **Decision network** explains the mechanical/thermal/sensor hypotheses and hypothetical action losses. **Follow priority asset** focuses the main view on an open request or active task; disable it to explore another asset. Cost sliders are an explanatory comparison, without a claim of real savings.
10. Reset to **Strong gusts · no injected damage** for the normal-weather contrast, or **dropout** for missing measurements. Missing data and unobserved assets stay Unknown. Drift detection remains imperfect across seeds. Export the evidence and mission audit to review reports, assignments, checks, plan revisions and human requests.

For manual experiments, turn off **Automatic dispatch & inspection** and expand **Manual controls**. Flights and inspections already underway finish; queued tasks wait and no new automatic tasks are created. Choose a hypothetical visual result or an eligible relocation. Manual visual evidence is imperfect and expires after 15 exercise minutes. To reproduce the original stationary baseline experiment, reset and disable automation before advancing the clock.

Play advances one 60-second feature window every two wall-clock seconds. Pause before switching workspaces. Use **Reset stream** to clear the replay, evidence, tasks and requests; it restores automatic mode. The sidebar preserves the previous official inspection mode and synthetic laboratory. The offline evaluator explicitly retains the six stationary scenarios and excludes the dynamic mission; it does not measure autonomous mission effectiveness.

Dynamic mission public-message milestones:

| Exercise time | Visible event |
| --- | --- |
| Initial steps | Existing public reports seed checks; feasible drones move or inspect locally. Other units can remain available for later evidence. |
| T+20 | An unverified observer lead requests LINE_028 during the gust episode. |
| T+29 | The observer corrects the location to LINE_002. The new version supersedes pending work. |
| T+32 | The observer withdraws that lead. Cancellation does not establish asset health. |
| T+46 | A new high-priority lead concerns LINE_058 after the gust warning ended; compare candidate drones and read the selection reason. |
| T+50 | A routine LINE_015 follow-up arrives with an explicit dependency on obtaining the LINE_058 inspection result. Geographic grouping does not establish electrical connectivity. |
| T+55 and later | Review dispatch progress, then continue to the inspection result and subsequent plan change. Read the displayed times and evidence rather than assuming a predetermined route or diagnosis. |

These report receipt times belong to the explicit synthetic scenario. Flight, reassignment and inspection outcomes are computed from the current mission state and received evidence. Changing the seed, automation or manual actions can change the outcome. Local checks can repeat within bounded rules or start a new episode after fresh evidence; a report correction cannot divert an aircraft already committed to flight. The simulator produces neither repair execution nor restored electricity.

## Prior official inspection workspace

## Launch — Windows PowerShell

```powershell
cd C:\Projects\personal_site\watt_hackathon
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m streamlit run app.py --server.address 127.0.0.1 --server.port 8501
```

Open **http://127.0.0.1:8501** (or your launch port). The default workspace is **Digital twin · Live simulation**; choose **Official challenge · Bavaria** for the earlier single-inspection workflow below. For first installation see README.md; runtime requires no network access or API key. All official source files are bundled locally, with checksums. No new dependencies were introduced.

Headless mission / evidence export:

```powershell
.\.venv\Scripts\python.exe -m gridscout.challenge --output artifacts/official_mission.json
.\.venv\Scripts\python.exe -m gridscout.challenge --conservative --output artifacts/official_conservative.json
```

## Rules to demonstrate

- Five sensors start fully charged and perched on five declared line IDs.
- Each flight is at most 30 minutes.
- Every flight requires 180 minutes of uninterrupted charging before the next flight.
- Only energized lines with sufficient charging power can recharge a sensor. Voltage tags do not establish either condition.
- LINE_024 is officially reported de-energized. Its fault state remains unknown.
- Other eligible sites in the default demo are explicit assumptions, shown as squares. Conservative mode removes them.
- Four-hour mission window; measurements can overlap charging while perched.

## Three-minute sequence

| Time | Screen/action | Message |
| --- | --- | --- |
| 0:00–0:25 | Initial Reports | Six uncertain reports; all available from the start |
| 0:25–0:50 | Live map / starting IDs | Five sensors, actual mapped corridors, explicit charging assumptions |
| 0:50–1:20 | Choose Inconclusive, Execute Inspection | Missing clarity does not mean no fault; request additional evidence |
| 1:20–1:45 | Decision & Evidence | Shared-zone updates for informative hypothetical results; transparent scores |
| 1:45–2:25 | Auto-Run, Mission Audit | Flight constraints, a full 180-minute charge, then permitted relocation |
| 2:25–3:00 | LINE_024 / limitations / export | Known de-energized versus unknown damage; unknown customer supply; evidence trail |

Use **Reset Scenario** before a new live run. For a stronger positive/negative Bayesian illustration, choose Positive or Negative for the first hypothetical report at the next observation event. Always identify it as an example. Auto-Run uses seeded posterior-predictive examples. Full narration: PITCH_SCRIPT.md.

## Explain to judges

Show which line IDs the five packages start on and why the heuristic chose them. Explain what the reports actually establish. Explain that an unknown charging condition must be resolved or explicitly assumed, and show the time cost of relocating. A positive anomaly suggests verification, not automatic repair.

This official map does not contain verified source-to-customer connectivity or loads. Do not quote the synthetic laboratory's customer outage totals as real outcomes. The separate laboratory and its historical benchmarks remain available in Workspace → Synthetic laboratory; the earlier guide is HACKATHON_GUIDE_LAB.md.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Browser shows the older synthetic app | Reload and select Official challenge · Bavaria. If source changed, click Streamlit Rerun. |
| No immediate recommendation | Sensors may be charging, flying, or lacking eligible destinations. Use Advance Next Event or inspect site statuses. |
| Conservative mode stops after initial measurements | Expected: no unverified charging sites are eligible. Add an explicit site assumption, enable terminal visits, or reset to a demo configuration. |
| Sensor is awaiting power | Both energized and sufficient-power states must be true. A new 180-minute charge then begins. |
| Need to inspect noncharging LINE_024 | It can be selected as an initial full-battery site, or enable terminal visits. It cannot recharge and cannot be switched live in this prototype. |
| Official package checksum error | Restore the original source files; do not edit them in place. Provenance is recorded in data/official/manifest.json. |
| Port is occupied | Use --server.port 8502 and open that port; do not kill unrelated processes. |
| Missing Streamlit command | Use the explicit .venv Python command above; activation is unnecessary. |
| PowerShell blocks launch.ps1 | Use the direct Python command; no execution-policy changes are needed. |

Stop the foreground server with Ctrl+C. Flight safety, attachment hardware, live telemetry and repairs are outside the model. If time is short, keep official map/report integration, charging audit and one clear evidence example; use the laboratory only as supporting methodology.
