# Three-minute pitch — dynamic inspection and human handoff

**0:00–0:25 — What should the operator need to do?**

“Five mobile sensors cover only part of this region. GridScout turns received reports and live evidence into feasible inspection tasks. The operator sees where attention is needed, why a drone was chosen and whether a person needs to act.”

Open Mission control and press **Load dynamic mission**. Identify the human-request area, five device cards and fresh coverage. State that the map uses official challenge geometry, while telemetry, observer reports, weather, costs and inspection outcomes are synthetic.

**0:25–1:00 — Watch an inspection happen.**

Press **Play stream** or advance in controlled steps. Select a task and compare all five drone candidates. Read the chosen unit's reason and another candidate's constraint. Show the route, selected cruise speed and arrival/inspection countdown.

“The planner uses received information and checks weather, travel time, current coverage and charging. The user confirmed a 60 m/s maximum; the 20/40/60 m/s cruise choices are demonstration policies. Fast transit observations are unsuitable for line diagnosis, so the BN uses stationary evidence. Every flight still requires a full three-hour recharge after arrival.”

The planner is an explainable heuristic. It revises pending assignments and retains committed flights. An inspection generates imperfect synthetic evidence; no actual aircraft command or camera analysis occurs.

**1:00–1:40 — Show evidence changing the plan.**

Use **Jump to 55 min** to reach the later mission, then continue controlled steps through the next inspection result. Show the latest plan change and history: a report received at T+20 was corrected at T+29 and withdrawn at T+32; a new LINE_058 lead arrived at T+46; a related LINE_015 follow-up arrived at T+50 and waits for the first inspection result.

“A new report can redirect pending work. A completed inspection can raise or lower a related lead's priority. We preserve both the old decision and the reason for changing it. Geographic report grouping is an operational lead, without a claim about electrical connectivity.”

Read the actual result rather than promising a positive finding. Show the observation description and BN values before and after that view, computed with the same telemetry window. A clear view can lower the probability while persistent sensor residuals still justify human review. An inconclusive view retains uncertainty. These probabilities are not field-calibrated.

**1:40–2:15 — Make the human handoff explicit.**

Show an open **HUMAN ACTION REQUIRED** card. Read its asset, evidence, requested action and review deadline where shown.

“Strong wind can explain ordinary vibration. The frozen baseline conditions on weather, while the BN compares asset and sensor explanations. We automate routine evidence collection and bounded follow-ups. Critical evidence goes directly to a person, and unresolved uncertainty has a review limit.”

Click Acknowledge and explain that it records receipt, not resolution or repair. Monitoring continues. The Decision network tab provides hypothetical costs and alternatives.

**2:15–2:40 — Make the process easy to audit.**

“The first screen answers: does a person need to act, what are the five drones doing, and why did the plan change? Select any task for the candidate comparison and findings. The map shows routes and inspection progress; detailed measurements and model assumptions have their own tabs.”

Show a delayed or superseded task and its reason. Missing or departed measurements remain Unknown. On-site inspection can continue during charging. Bounded rechecks or a new anomaly episode can create later tasks; the system keeps the incident history. Turning automation off lets committed flights and inspections finish; queued tasks wait.

**2:40–3:00 — State what the prototype establishes.**

“This is a working, auditable simulation from a changing evidence stream through task revision to human handoff. Real telemetry, calibrated models and hardware interfaces remain integration work. Sensor drift remains difficult. The six-scenario stationary evaluation excludes this dynamic mission and does not establish real operational effectiveness.”

Close on the latest plan change and human-request card. Describe maximum speed as user-supplied information; weather limits and cruise policy remain exercise assumptions. Do not claim globally optimal routing, real cost savings, repair execution or an engineering-precision 3D twin.
