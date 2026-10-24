# Three-minute pitch

## 0:00–0:25 — Operational problem

“A severe storm has passed. Several lines may be damaged, but we have only two mobile inspection sensors. The operator's question is not simply: which line is most likely broken? It is: what should we inspect next to support the most valuable restoration decision?”

Show Live Operations, the default Severe Storm scenario and the two sensors at base. Explain that the grid and storm are synthetic and reproducible.

## 0:25–0:55 — Risk meets service impact

“Line colour shows a probability, not confirmed damage. Network connectivity tells us which customers, demand and critical services a failure could disconnect. A likely fault on a minor branch and a fault on a feeder serving a hospital have different operational consequences.”

Click **Recommend Next Inspection**, then show **Decision Explanation**. Point to probability, topology consequence, travel/inspection time and information gain. State that the score is a transparent heuristic.

## 0:55–1:30 — Evidence changes the plan

Return to Live Operations and click **Execute Inspection** twice. Explain that the scheduler dispatches idle sensors and advances to the next report. Open Bayesian Evidence. In the default seed-42 scene, L01 reports negative and L02 reports positive; L02 rises from about 42% to 91% and the West-zone high-severity belief rises from 65% to 81%.

“The sensor is imperfect. This report changes both our belief about this line and our belief about storm severity in the same zone. That updates nearby uninspected lines too. Each report is counted once.”

Point to prior/posterior severity bars and neighbouring probability changes. Use the actual displayed result; never claim a positive report if this run shows a negative.

## 1:30–2:00 — Adaptive decisions

Return to the recommendation and explain the new target and changed ranking. If the highest-priority remaining line stays the same, say so: “The probabilities changed, but the service consequence still makes this target most valuable.”

“GridScout considers immediate fault impact, information about the shared hazard and, in the advanced mode, the expected value of the next decision. Battery, time and an assured route home constrain every policy.”

Show repair-support opportunity: “Inspection is not repair. These are estimates of service that a later repair might unlock, not customers already restored.”

## 2:00–2:35 — Honest comparison

Open Strategy Benchmark with a previously completed paired run, or execute a small run. Show coverage, weighted true faults detected, remaining undetected impact, detection rate and runtime.

“Every policy receives the same hidden faults and the same per-line sensor randomness. These intervals show variability. Extra complexity is not automatically better, and this dashboard reports when the simpler strategy wins.”

Do not improvise numerical advantages. Read actual metrics and seed count.

## 2:35–3:00 — Close

“The core AI is the probabilistic decision system. Everything runs offline, without a chatbot, paid API or physical drone. This is a connectivity model rather than power-flow simulation; next we would calibrate it against real utility data and add verified repair dispatch.”

“GridScout does not just predict damage. It helps operators decide what information to collect next, and shows how that information can support restoration.”
