# Three-minute pitch — official challenge

For the new default live digital twin, use [PITCH_TWIN.md](PITCH_TWIN.md). The script below describes the preserved **Official challenge · Bavaria** inspection workspace.

**0:00–0:25**

“A storm has passed through this mapped region in Bavaria. We have six incomplete reports and five mobile sensors. We need to decide where to collect evidence first, and when we know enough to ask an operator to investigate.”

Show Initial Reports. The geography is real mapping data; the storm and reports are fictional exercise material.

**0:25–0:50**

“Each sensor can fly for thirty minutes, then needs three hours of charging before flying again. Charging works only on a live line with enough power. That makes every relocation a decision about our next three hours.”

Show the five starting line IDs and assumed charging squares. “Other than the explicitly reported de-energized line, operational power status is missing. These charging sites are declared demo assumptions, and we can run conservatively without them.”

**0:50–1:20**

Choose an Inconclusive hypothetical next report and Execute Inspection.

“This reading is unclear. We do not turn uncertainty into a negative result. The model keeps its prior belief and recommends additional evidence, including an in-place follow-up while the sensor waits.”

**1:20–1:45**

Show Decision & Evidence. If useful, collect a Positive or Negative example next.

“An informative report updates a shared geographic hazard belief and nearby line probabilities. The ranking combines modeled anomaly risk, expected information gain and collection time. These probabilities are illustrative assumptions, not calibrated utility failure forecasts.”

**1:45–2:25**

Auto-run and open Mission Audit.

“Here is the full event trace. Even a short flight starts a full three-hour recharge. The sensor can observe while perched, but it cannot depart again before charging completes. No charging is credited on a dead line, an unknown-power line, or a line with insufficient power.”

**2:25–3:00**

“LINE_024 is known to be de-energized; we do not assume it is broken. The map also does not identify customer supply paths, so we do not invent restored-customer figures. GridScout produces an explainable investigation plan and exports its assumptions and evidence for operator review.”

“Everything shown runs offline. Our next validation would use operator-confirmed power states and real sensor performance. GridScout helps decide what information to collect next, and preserves the ability to act on it.”
