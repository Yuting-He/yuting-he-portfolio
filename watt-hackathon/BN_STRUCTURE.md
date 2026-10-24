# GridScout current-window BN

Implemented 24 October 2026. The graph structure is manually specified in
`gridscout/bn_structure.py`. The dashboard renders its declared edges and shows
the action workflow separately. Normal-baseline coefficients, residual scales
and mechanical correlation are fitted from 3,600 healthy synthetic records.
Priors, abnormal distributions, inspection reliability and losses are explicit
demonstration assumptions requiring field calibration.

## Variables and conditional model

M = mechanical anomaly; T = thermal anomaly; S = sensor/installation fault;
F = affected channel family; E = energized state. W is current weather/load
context, Q is quality/mode/calibration, O is the operating record and I is
inspection modality/quality/visibility. ZM is the joint vibration/tilt observation;
ZT and ZV are temperature and voltage observations. R is the inspection result.

```text
P(E,M,T,S,F,ZM,ZT,ZV,R | W,Q,O,I)
 = P(E|O) P(M|W) P(T|E) P(S|Q) P(F|S)
   P(ZM|M,F,W,Q) P(ZT|T,F,E,W,Q) P(ZV|F,E,Q) P(R|M,T,I)
```

F is marginalized over temperature (.40), mechanical (.40), voltage (.10) and
common (.10) fault families when S is true, and the healthy family when S is false.
ZM preserves vibration/tilt correlation. Each calculation uses its current
window and one eligible inspection. History stores independent window snapshots.

## Operating records

An explicit Boolean record clamps E, yielding eight M/T/S combinations. An unknown
record enumerates E off/on, yielding 16 combinations. The default unknown prior
is P(E=on)=.9; the dashboard allows an explicit alternative. Initial records are
labelled synthetic energized assumptions; LINE_024 retains its official preventive
de-energization record.

The healthy baseline predicts separate E=on/off temperature and voltage
distributions. The unknown-state display uses a mixture mean and an envelope of
both conditional reference intervals. The inference uses branch residuals and
physical-density Jacobians before summing over E. Missing conditional baselines
exclude operation-sensitive channels. Unknown load expands the energized
temperature uncertainty. Thermal priors are .025 on and .005 off.

Operating-record changes retain original readings and frozen inspection records.
Audit events record the stated source, prior and receipt time. Synthetic world
generation retains its independent operating state. Flight targets require an
explicit energized record at a listed powered site. An interrupted recharge
restarts the full 180 minutes after the record permits charging again.

## Inspection table

Usable, valid, clear views use the following probabilities of `supports`:

| M | T | RGB | Thermal | Combined |
|---|---|---:|---:|---:|
| false | false | .08 | .08 | .08 |
| true | false | .85 | .08 | .85 |
| false | true | .08 | .90 | .90 |
| true | true | .85 | .90 | .983696 |

Combined inspection uses a shared false-positive channel and a noisy-OR over
detectable defects. `clear` uses the complementary probability. `inconclusive`
has equal likelihood across states. Quality factors are valid=1 and suspect=.5;
visibility factors are clear=1, limited=.6, poor=.25, obscured=0. Discrimination
shrinks toward the .08 healthy rate by quality × visibility. The probability of
obtaining a usable view is .88 × quality × visibility. Unsupported metadata is
excluded. Complete observation packets retain modality, quality and visibility.

`inspection_model.py` supplies the shared table to inference, dashboard previews,
synthetic sampling and expected-value calculations. Action estimates enumerate
supports, clear and inconclusive branches. Legacy cost sensitivity/specificity
overrides apply to mechanical detection and the false-positive channel. Automatic
inspection uses the declared RGB default; manual and preview controls expose the
optional thermal and combined assumptions.

## Decisions and verification

Action ranking compares expected relative loss and inspection outcomes. The
scheduler applies flight, weather, recharge and coverage constraints. The dashboard
labels latent states, observation variables and known conditions; M/T/S/E probabilities
annotate their state nodes. F is exposed as a marginalized variable.

Tests cover analytic Bayes calculations, physical-density mixtures with unequal
branch scales, correlated states, inspection modality and visibility, three-outcome
EVSI, frozen history, observation freshness, charging interruption and UI workflows.
Dashboard explanations use direct definitions of variables, scope and actions.
