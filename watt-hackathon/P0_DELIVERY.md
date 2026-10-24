# P0 judge delivery

The default experience is a 75-second, six-chapter replay generated from the
existing autonomous simulation (`dynamic`, seed 42). The public website runs
without a Python server, external scripts, API keys or map-tile requests.

## Entry points

- Public build: `dist/index.html` (self-contained HTML, also opens offline).
- Python app: `app.py` defaults to Judge showcase. Interactive dashboard retains
  the original live, official challenge and laboratory workspaces.
- Online Dashboard: a read-only evidence viewer tied to a recorded asset and
  time. Its five panels retain operations, baselines, Bayesian calculations,
  weather and audit records. Use the Python app for mutable mission experiments.

## Evidence and chronology

The LINE_058 report arrives at T+46. Drone 5 leaves LINE_009 at T+47, reaches the
target at T+56 and finishes a stationary RGB inspection at T+60. The departure
decision uses the received report and coverage gap. It does not use target
telemetry that is collected after arrival. Drone 1 is closer but must retain
coverage at an anomalous origin; the full candidate comparison is inspectable.

At T+60 the same-window anomaly estimate changes from 88.4% to 55.5% after a
clear RGB view. A human field-review request created at T+58 remains open. The
current recommendation to check the sensor does not cancel that request.

All telemetry, weather, reports, inspection outcomes, likelihoods and costs are
synthetic assumptions. The map geometry is supplied by the challenge organizer.
Flight lines are simulated point-to-point legs. No field calibration, real drone
commands, obstacle/airspace planning, repair or restoration is claimed.

## Reproduction

```powershell
.\.venv\Scripts\python.exe -m gridscout.showcase_data
.\.venv\Scripts\python.exe web/build.py
.\.venv\Scripts\python.exe -m pytest -q --disable-warnings --basetemp artifacts\p0_regression_tmp
.\.venv\Scripts\python.exe -m http.server 8510 --bind 127.0.0.1 --directory dist
```

The public replay and `artifacts/validation_summary.json` bind the current model
and a line-ending-independent source fingerprint. A version mismatch fails the
production build. The old full `artifacts/twin_validation.json` is retained only
as a historical BN 1.0 record, and is not published or used as the P0 scorecard.

## Verification record

- Complete Python regression: **270 passed**, two Streamlit/NumPy deprecation
  warnings, in 72.03 seconds on 24 October 2026.
- The new data checks cover event order, absence of future/hidden evidence,
  route positions, candidate explanations, same-window inspection updates,
  unresolved human requests, source binding and LF/CRLF consistency.
- Streamlit checks cover the default entry, fallback, pause and state isolation,
  workspace retention and all existing live/official/laboratory UI workflows.
- Current six-scenario snapshot evaluation: 180 stationed slots; 174 observed,
  six missing. Asset TP12/FP0/TN162/FN0; drift TP1/FP1/TN167/FN5. The protocol is
  six paired seeds at T+55 with fixed positions. It excludes the dynamic mission
  and does not establish field accuracy or autonomous task effectiveness.

- Final production-build checks: **3 passed**, including rejection of matching
  but stale data/validation and missing validation. The rebuilt Streamlit entry
  was checked again outside the socket-restricted sandbox: **4 passed**.
- Browser checks verified all five evidence tabs, T+47 step linkage, selecting
  T+60 then returning to the paused T+47 story, the BN's 13 nodes/20 edges/eight
  states, the current validation figures and no console errors. Desktop
  1440×900 fits the controls in the first screen; 390px layout has no horizontal
  overflow. Main explanation text is at least 14px.

The GitHub Pages target is
https://yuting-he.github.io/yuting-he-portfolio/watt-hackathon/.
