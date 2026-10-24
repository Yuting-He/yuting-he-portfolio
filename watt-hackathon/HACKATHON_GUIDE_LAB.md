# GridScout hackathon guide

## Launch commands — Windows PowerShell

```powershell
cd C:\Projects\personal_site\watt_hackathon
# First machine setup (requires a network connection or a prepared wheelhouse):
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# Validate:
.\.venv\Scripts\python.exe -m pytest -q
# Launch offline:
.\.venv\Scripts\python.exe -m streamlit run app.py --server.port 8501
```

Current workspace already has an installed `.venv`. Just use the final command. Open **http://127.0.0.1:8501**. If the port is in use, use `--server.port 8502` and open that port. Stop the foreground server with Ctrl+C.

## Before going on stage

1. Start the app and keep the browser tab open. Ensure the network map and all five tabs render.
2. Load **Demo Scenario: Severe Storm** in Scenario Configuration. The default is seed 42, two sensors and 90 minutes. Check that the mission clock is zero and no observations are present.
3. Run a benchmark once, allowing enough time for the selected seed count. Keep those results available; resets intentionally clear stale benchmark results, so do the reset first.
4. Rehearse Recommend → Execute twice → Evidence → new recommendation. Default seed 42 produces L01 negative then L02 positive: the second report changes L02 from about 42% to 91% and West-zone High severity from 65% to 81%. Use the actual displayed values if configuration changes.
5. If internet access is unavailable, no action is needed after dependencies are installed. The product does not fetch external tiles, weather, models or language APIs.

## Three-minute demo sequence

| Time | Screen/action | Point to communicate |
| --- | --- | --- |
| 0:00–0:25 | Live Operations, severe storm | Limited sensors, uncertain damage, critical services |
| 0:25–0:55 | Recommend, Decision Explanation | Probability × topology consequence, information, cost |
| 0:55–1:30 | Execute twice, Bayesian Evidence | Imperfect reports change a shared-zone posterior |
| 1:30–2:00 | New recommendation, repair opportunity | Adaptive next action; inspection is not restoration |
| 2:00–2:35 | Strategy Benchmark | Paired scenarios, honest variability and tradeoffs |
| 2:35–3:00 | Assumptions and closing sentence | Offline working method, clear path to deployment |

Full narration is in `PITCH_SCRIPT.md`.

## What to show judges

- A live application, not slides alone: produce one sensor observation and show its causal effect on beliefs and priority scores.
- Network impact based on actual graph reachability and load metadata, not an unexplained centrality score.
- The same hidden scenario and per-line observation randomness across policies.
- Independent Bayesian evidence, policy choice and evaluator truth. Sensor-positive is not certain failure.
- Time/endurance feasibility and exclusive assignments for two concurrent sensors.
- An honest benchmark even if an advanced strategy loses. Explain that information has value only when it changes useful downstream decisions.

## Emergency troubleshooting

| Symptom | Recovery |
| --- | --- |
| `streamlit` command not found | Use `.\.venv\Scripts\python.exe -m streamlit run app.py`; activation is unnecessary. |
| Dependency missing | Use `uv pip install --python .venv\Scripts\python.exe -r requirements.txt`, or recreate/seed `.venv` with `python -m venv .venv` then use pip. Offline: install from the prepared wheelhouse. |
| PowerShell blocks `launch.ps1` | Run the direct Python command; no execution-policy change is required. |
| Port already in use | Choose `--server.port 8502`; do not terminate unrelated processes. |
| Old observations after configuration edits | Click **Apply Configuration & Reset** or the preset; editing a form alone does not alter the active mission. |
| No feasible recommendation | The mission may be complete, sensors may be busy, or remaining time/endurance may be insufficient. Execute the next pending event, auto-run to completion, or reset. |
| Benchmark takes too long | Start with 3–5 seeds for the live demo, keep the final CSV for audit, and explain the limited sample. |
| Advanced policy underperforms | Show the actual comparison; discuss inspection opportunity cost and calibration. Do not change truth or hide seeds. |
| Need a clean scene | Reset Scenario clears mission state, recommendations, evidence and benchmark output. |
| Browser tab lost | Reopen `http://127.0.0.1:8501`; server must remain running. |

Headless checks:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m gridscout.evaluation --seeds 5 --output artifacts/benchmark.csv
Invoke-WebRequest http://127.0.0.1:8501/_stcore/health
```

## Known limitations

Synthetic, uncalibrated data; graph connectivity rather than load flow; fixed fault states; simplified straight-line travel; shared sensor accuracy; small-sample benchmark uncertainty. No real weather, hardware, flight-safety evaluation or charging from lines. No repair crew or completed restoration, and therefore no customer-interruption-duration metric. One-step planning is a heuristic and cannot guarantee optimal restoration.

## Features to cut if time runs short

Keep the digital twin, Bayesian update, impact calculation, one working adaptive policy, map and evidence view. Reduce the number of benchmark seeds for the live run. Hide advanced lookahead controls if needed and keep risk-plus-information mode. Defer repair simulation, routing, weather feeds, real data ingestion, drone hardware, LLM explanations and deployment integrations. Never cut truth separation, reproducibility or the tests that protect the demo.
