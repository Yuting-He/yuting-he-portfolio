/* GridScout's public viewer reads frozen, received-evidence snapshots only. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (v, digits = 1) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
  const pct = v => typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'Unknown';
  const pretty = value => esc(JSON.stringify(value, null, 2));
  const label = value => String(value ?? 'Unknown').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const clock = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let data, frames, chapters, boundaries, duration = 75, cursor = 0, playing = false, page = 'showcase', evidenceTab = 'operations', evidenceFrame, lastTick, renderedKey, activeNode = null, bindingOK = false;
  const titleShort = ['Conditions', 'Received report', 'Choose a drone', 'Fly the route', 'Collect evidence', 'Update action'];
  const titleMain = ['Limited coverage.<br>A changing environment.', 'A report is a reason<br>to investigate.', 'The closest drone<br>cannot always leave.', 'From a dispatch<br>to an inspection.', 'Let the evidence<br>challenge the model.', 'New evidence.<br>A clearer next step.'];
  const statusNames = ['Coverage gap', 'Unverified lead', 'Drone 5 selected', 'Mission in progress', 'Stationary inspection', 'Human review open'];
  const channels = [['temperature_c', 'Conductor temperature', '°C'], ['vibration_rms', 'Vibration RMS', 'RMS'], ['tilt_deg', 'Relative tilt', '°'], ['voltage_pu', 'Energization proxy', 'p.u.']];
  const palette = {teal:'#68e0c4', amber:'#efbd75', red:'#ff8b91', blue:'#8ab9ec', grey:'#647b87'};
  const panel = (title, content, eyebrow = '', full = false) => `<section class="evidence-panel${full ? ' full' : ''}">${eyebrow ? `<div class="panel-eyebrow">${eyebrow}</div>` : ''}<h3>${title}</h3>${content}</section>`;
  const details = (title, value, open = false) => `<details${open ? ' open' : ''}><summary>${esc(title)}</summary><pre>${pretty(value)}</pre></details>`;
  const tag = (text, tone = '') => `<span class="tag ${tone}">${esc(text)}</span>`;
  const table = (headings, rows, selected = -1) => `<div class="data-table-wrap"><table class="data-table"><thead><tr>${headings.map(x => `<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr${i === selected ? ' class="selected"' : ''}>${r.map(x => `<td>${x ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const metric = (value, text, tone = '') => `<div class="metric"><strong class="${tone}">${value}</strong><span>${text}</span></div>`;
  const empty = message => `<div class="empty-state">${message}</div>`;
  const keyValues = obj => table(['Property', 'Frozen value'], Object.entries(obj || {}).map(([k,v]) => [esc(label(k)), esc(typeof v === 'object' ? JSON.stringify(v) : v)]));
  const snapshotFor = minute => frames.find(f => f.minute === minute) || frames.filter(f => f.minute <= minute).at(-1) || frames[0];
  function chapterIndex() { let i = boundaries.findIndex((start, j) => cursor >= start && cursor < (boundaries[j + 1] ?? duration + 1)); return i < 0 ? chapters.length - 1 : i; }
  function currentFrame() {
    const i = chapterIndex(), chapter = chapters[i], local = Math.min(1, (cursor - boundaries[i]) / chapter.duration_seconds);
    const minutes = chapter.frame_minutes?.length ? chapter.frame_minutes : [chapter.minute];
    return snapshotFor(minutes[Math.min(minutes.length - 1, Math.floor(local * minutes.length))]);
  }
  function goChapter(index) { cursor = boundaries[Math.max(0, Math.min(chapters.length - 1, index))]; pause(); renderShowcase(true); }
  function pause() { playing = false; renderControls(); }
  function play() { if (cursor >= duration) cursor = 0; playing = true; lastTick = performance.now(); renderShowcase(true); }
  function setPage(next) {
    if (page === 'showcase' && next === 'dashboard') evidenceFrame = currentFrame();
    if (next !== 'showcase') pause();
    page = next;
    document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== `page-${next}`; });
    document.querySelectorAll('[data-page]').forEach(el => { const active = el.dataset.page === next; el.classList.toggle('active', active); active ? el.setAttribute('aria-current', 'page') : el.removeAttribute('aria-current'); });
    if (next === 'dashboard') { evidenceFrame ||= currentFrame(); renderEvidence(); }
    if (next === 'validation') renderValidation();
    if (next === 'showcase') renderShowcase(true);
    window.history.replaceState(null, '', `#${next}`);
  }
  function renderControls() {
    $('play-toggle').textContent = playing ? 'Ⅱ' : '▶';
    $('play-toggle').setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
    $('elapsed').textContent = `${clock(cursor)} / ${clock(duration)}`;
    $('scrubber').value = cursor;
    $('playback-status').textContent = cursor >= duration ? 'Replay complete · explore the evidence' : playing ? 'Playing a frozen mission' : reduced ? 'Paused · reduced-motion preference' : 'Paused · your place is saved';
    $('previous').disabled = chapterIndex() === 0;
    $('next').disabled = chapterIndex() === chapters.length - 1;
  }
  function renderShowcase(force = false) {
    if (!data) return;
    renderControls();
    const i = chapterIndex(), chapter = chapters[i], frame = currentFrame(), key = `${i}-${frame.minute}`;
    if (!force && renderedKey === key) return;
    renderedKey = key;
    document.querySelectorAll('[data-chapter]').forEach((btn, j) => {
      btn.classList.toggle('active', i === j); btn.classList.toggle('completed', i > j);
      if (i === j) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
    });
    $('chapter-number').textContent = `${String(i + 1).padStart(2, '0')} / 06`;
    $('stage-status').textContent = frame.narrative?.status || statusNames[i];
    $('story-title').innerHTML = titleMain[i] || esc(chapter.title);
    const useNarrative = [3,4,5].includes(i);
    $('story-what').textContent = useNarrative && frame.narrative?.what ? frame.narrative.what : chapter.what;
    $('story-why').textContent = chapter.why;
    $('story-next').textContent = useNarrative && frame.narrative?.next ? frame.narrative.next : chapter.next;
    const calc = frame.explanation?.calculation || {}, sums = calc.summaries || {}, route = frame.route;
    const inspectionUsed = Boolean(frame.explanation?.visual?.used);
    const openHumanReview = (frame.human_alerts || []).some(a => ['open', 'acknowledged'].includes(a.status));
    let content = '';
    if (i === 0) content = `<div class="story-metrics">${metric(String(frame.fleet.length), 'mobile sensing drones')}${metric(String(data.geometry.length), 'mapped line segments')}${metric('Unknown', 'unobserved line status', 'amber')}</div>`;
    if (i === 1) content = `<div class="story-metrics">${metric('LINE_058', 'received high-priority report', 'amber')}${metric('Unknown', 'no stationary measurement')}</div>`;
    if (i === 2) { const selected = (frame.candidates || []).find(c => c.sensor_id === 'Drone 5'); content = `<div class="story-metrics">${metric('Drone 5', 'feasible dispatch', 'teal')}${metric(selected ? `${selected.flight_minutes} min` : '—', 'simulated flight time')}</div>`; }
    if (i === 3 && route) content = `<div class="story-metrics">${metric(`${fmt(route.distance_km)} km`, 'simulated flight leg')}${metric(`${route.flight_speed_mps} m/s`, 'model speed')}${metric(`T+${route.arrival_at}`, frame.minute >= route.arrival_at ? 'arrived' : 'scheduled arrival', 'teal')}</div>`;
    if (i >= 4 && inspectionUsed && sums.telemetry_only && sums.with_visual) {
      const before = sums.telemetry_only.anomaly, after = sums.with_visual.anomaly;
      content = `<div class="probability-compare">${metric(pct(before), 'sensors only')}<span class="arrow">→</span>${metric(pct(after), `+ ${esc(frame.explanation.visual.evidence?.result)} ${esc(String(frame.explanation.visual.evidence?.modality || '').toUpperCase())} view`, 'teal')}<span class="delta">${fmt((after-before)*100)} pp<br>same window</span></div>`;
    } else if (i >= 4 && calc.available) content = `<div class="story-metrics">${metric(pct(sums.telemetry_only?.anomaly), 'model P(asset anomaly)', 'amber')}${metric(openHumanReview ? 'Open' : 'In progress', openHumanReview ? 'human field-review request' : 'stationary RGB inspection')}</div>`;
    $('story-metric').innerHTML = content;
    $('story-snapshot').textContent = `${frame.snapshot_id} · ${data.metadata.asset_id} · T+${frame.minute}`;
    $('map-clock').textContent = `T+${frame.minute} min`;
    $('map-location').textContent = i < 1 ? 'Post-storm inspection network' : 'LINE_058 · inspection mission';
    $('map-context').innerHTML = i === 0 ? '<strong>Coverage is incomplete</strong><span class="context-divider">/</span><span>Unobserved lines remain Unknown</span>' : i === 1 ? '<strong>Observer lead received at T+46</strong><span class="context-divider">/</span><span>Not yet verified on site</span>' : route ? `<strong>${esc(route.origin_asset)} → ${esc(route.target_asset)}</strong><span class="context-divider">/</span><span>${frame.minute < route.arrival_at ? 'Time compressed · recorded 1-minute positions' : frame.minute < 60 ? 'Stationary evidence collection' : 'Inspection received · human review stays open'}</span>` : '';
    renderMap(frame, i);
  }
  function renderMap(frame, chapter) {
    const all = data.geometry.flatMap(g => g.coordinates), west = Math.min(...all.map(p => p[0])), east = Math.max(...all.map(p => p[0])), south = Math.min(...all.map(p => p[1])), north = Math.max(...all.map(p => p[1]));
    const cosLat = Math.cos((north + south) / 2 * Math.PI / 180), scale = Math.min(690 / ((east-west)*cosLat), 350 / (north-south));
    const project = p => [425 + (p[0]-(east+west)/2)*cosLat*scale, 278 - (p[1]-(north+south)/2)*scale];
    const path = points => points.map((p,i) => `${i ? 'L' : 'M'}${project(p).map(v => v.toFixed(2)).join(',')}`).join(' ');
    let svg = '<defs><pattern id="map-grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M 50 0 H 0 V 50" fill="none" stroke="#2c424d" stroke-width=".7" opacity=".38"/></pattern><radialGradient id="target-glow"><stop stop-color="#efbd75" stop-opacity=".2"/><stop offset="1" stop-color="#efbd75" stop-opacity="0"/></radialGradient><filter id="soft-glow"><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="850" height="540" fill="url(#map-grid)"/>';
    for (let lat = Math.ceil(south*10)/10; lat < north; lat += .1) { const y = project([west,lat])[1]; svg += `<text x="22" y="${y}" font-size="8" fill="#526e7c">${lat.toFixed(1)}°N</text>`; }
    for (const g of data.geometry) {
      const state = frame.map_states?.[g.asset_id], unknown = !state || /unknown|stale/i.test(state.status || ''), risk = state?.anomaly;
      const color = unknown ? palette.grey : risk > .65 ? palette.red : risk > .2 ? palette.amber : '#6dbaad';
      const target = g.asset_id === data.metadata.asset_id && chapter >= 1;
      svg += `<path d="${path(g.coordinates)}" fill="none" stroke="${target ? palette.amber : color}" stroke-width="${target ? 4 : 1.7}" stroke-linecap="round" opacity="${target ? 1 : .62}"${unknown && !target ? ' stroke-dasharray="2 3"' : ''}><title>${esc(g.asset_id)}: ${esc(unknown ? 'Unknown · no current usable observation' : `${state.status}; model anomaly ${pct(risk)}`)}</title></path>`;
    }
    const targetGeometry = data.geometry.find(g => g.asset_id === data.metadata.asset_id), t = project(targetGeometry.position);
    if (chapter >= 1) svg += `<circle cx="${t[0]}" cy="${t[1]}" r="48" fill="url(#target-glow)"/><circle cx="${t[0]}" cy="${t[1]}" r="15" fill="none" stroke="${palette.amber}" stroke-opacity=".55" stroke-dasharray="3 4"/><circle cx="${t[0]}" cy="${t[1]}" r="4" fill="${palette.amber}"/><path d="M${t[0]+12},${t[1]+10} l20,21 h79" fill="none" stroke="#a18556"/><rect x="${t[0]+29}" y="${t[1]+25}" width="96" height="23" rx="3" fill="#292a22" stroke="#6c5d3e"/><text x="${t[0]+39}" y="${t[1]+40}" fill="#f1cf96" font-size="11" letter-spacing="1">LINE_058</text>`;
    const route = frame.route;
    if (route && chapter >= 2) {
      const start = project(route.coordinates[0]), end = project(route.coordinates.at(-1));
      const drone = frame.fleet.find(d => d.sensor_id === 'Drone 5');
      svg += `<path d="${path(route.coordinates)}" fill="none" stroke="${palette.teal}" stroke-width="2" stroke-dasharray="7 6" opacity=".65"/>`;
      if (drone) svg += `<path d="${path([route.coordinates[0], drone.position])}" fill="none" stroke="${palette.teal}" stroke-width="3.5"/><path d="${path([route.coordinates[0], drone.position])}" fill="none" stroke="${palette.teal}" stroke-width="7" opacity=".2" filter="url(#soft-glow)"/>`;
      svg += `<circle cx="${start[0]}" cy="${start[1]}" r="5" fill="#0c2229" stroke="#68e0c4"/><text x="${start[0]+12}" y="${start[1]-15}" fill="#a8d5cc" font-size="10">LINE_009 · departure</text>`;
      const mx = (start[0]+end[0])/2, my = (start[1]+end[1])/2;
      svg += `<rect x="${mx-39}" y="${my-12}" width="78" height="23" rx="4" fill="#142e30" stroke="#3b665e"/><text x="${mx}" y="${my+3}" fill="#a9e6d6" font-size="10" text-anchor="middle">${fmt(route.distance_km)} km ↘</text>`;
    }
    for (const d of frame.fleet) {
      const p = project(d.position), selected = d.sensor_id === 'Drone 5' && chapter >= 2;
      svg += `<g><title>${esc(d.sensor_id)}: ${esc(d.status)} · ${esc(d.asset_id)}</title>${selected ? `<circle cx="${p[0]}" cy="${p[1]}" r="17" fill="#68e0c4" opacity=".09"/><circle cx="${p[0]}" cy="${p[1]}" r="11" fill="none" stroke="#68e0c4" opacity=".4"/>` : ''}<path d="M${p[0]},${p[1]-6} l6,6 -6,6 -6,-6 Z" fill="${selected ? palette.teal : '#c7d6df'}" stroke="#10212b" stroke-width="2"/><rect x="${p[0]-12}" y="${p[1]-29}" width="26" height="17" rx="3" fill="${selected ? '#244840' : '#172b38'}" stroke="${selected ? '#4b8b75' : '#3f5663'}"/><text x="${p[0]+1}" y="${p[1]-17}" text-anchor="middle" font-size="9" fill="${selected ? '#a9f1d8' : '#c5d9e1'}">${esc(d.sensor_id.replace('Drone ', 'D'))}</text></g>`;
    }
    const km = 5, linePx = km / 111.2 * scale;
    svg += `<g transform="translate(730 458)"><path d="M0,-4 V0 H${linePx} V-4" fill="none" stroke="#7897a6"/><text x="${linePx/2}" y="14" text-anchor="middle" fill="#7897a6" font-size="8">5 km</text></g><g transform="translate(797 91)"><path d="M0 23 V0 l-4 7 M0 0 l4 7" fill="none" stroke="#839eaa"/><text x="0" y="-7" text-anchor="middle" fill="#839eaa" font-size="9">N</text></g>`;
    $('mission-map').innerHTML = `<title id="map-title">${esc(chapters[chapter].title)} · T+${frame.minute}</title><desc id="map-description">Official challenge line geometry. Grey is Unknown. ${chapter >= 2 ? 'Cyan shows Drone 5’s simulated point-to-point route from LINE_009 to LINE_058.' : 'Five drones cover a subset of lines.'}</desc>${svg}`;
  }
  function probabilityPanel(explanation) {
    const calc = explanation?.calculation || {}, s = calc.summaries || {}, used = explanation?.visual?.used;
    if (!calc.available) return empty('Unknown: no fresh, usable stationary telemetry at this step. No asset probability is asserted.');
    const stages = [['Window prior', s.prior?.anomaly], ['After sensors', s.telemetry_only?.anomaly], ...(used ? [['After inspection', s.with_visual?.anomaly]] : [])];
    return `<div class="comparison-bars">${stages.map(([name,p]) => `<div class="comparison-row"><span>${name}</span><div class="bar-track"><div class="bar-fill" style="width:${Number(p||0)*100}%"></div></div><span class="probability-value">${pct(p)}</span></div>`).join('')}</div><p class="tiny-note">${used ? 'One frozen telemetry window, one baseline and one prior. Only the eligible inspection factor changes.' : 'Inspection results have not been received or are not eligible at this step.'} These are model outputs under synthetic assumptions.</p>`;
  }
  function renderEvidence() {
    const f = evidenceFrame, ex = f.explanation || {}, op = f.operation;
    $('dashboard-context').textContent = `${data.metadata.asset_id} · T+${f.minute} simulated minutes · historical, received-evidence snapshot. Replay stays paused while you inspect this record.`;
    $('evidence-binding').textContent = `${f.snapshot_id} · ${op?.id || op?.operation_id || 'no assigned operation yet'}`;
    $('snapshot-select').value = f.snapshot_id;
    document.querySelectorAll('[data-evidence]').forEach(b => { b.classList.toggle('active', b.dataset.evidence === evidenceTab); b.setAttribute('aria-pressed', String(b.dataset.evidence === evidenceTab)); });
    let html = '';
    if (evidenceTab === 'operations') {
      html = '<div class="evidence-grid">';
      html += panel('What is known at this step', `<div class="notice teal">${esc(f.narrative?.what || chapters.find(c => c.minute === f.minute)?.what || 'Frozen mission state.')}</div><div class="inline-metrics">${metric(esc(ex.assessment?.status || 'Unknown'), 'current assessment')}${metric(pct(ex.assessment?.status === 'Unknown' ? null : ex.assessment?.anomaly), 'model P(asset anomaly)')}</div>${probabilityPanel(ex)}${details('Full operation and dispatch scoring', op)}`, 'ASSET / LINE_058');
      const alerts = (f.human_alerts || []).filter(a => ['open', 'acknowledged'].includes(a.status));
      html += panel('Actions and human handoff', `${alerts.length ? `<div class="notice danger">${alerts.length} human field-review request${alerts.length > 1 ? 's' : ''} recorded. A clear image does not resolve an open request.</div>${details('Human review records — exact status and timestamps', alerts, true)}` : '<p class="panel-copy">No unresolved human field-review request for this asset is recorded at this snapshot.</p>'}${(f.recommendations || []).length ? table(['Current recommendation', 'Expected loss', 'Status'], f.recommendations.map(r => [esc(r.label || label(r.action)), fmt(r.expected_loss, 2), r.recommended ? tag('recommended', 'teal') : tag('alternative')])) : empty('No asset action can be inferred without current evidence.')}<p class="tiny-note">Relative loss units and action assumptions are synthetic. Recommendations are distinct from completed actions.</p>`, 'RECOMMENDATION ≠ EXECUTION');
      html += panel('Five-drone fleet', table(['Drone', 'At / origin', 'State', 'Target', 'Arrival / ready'], f.fleet.map(d => [esc(d.sensor_id), esc(d.asset_id), esc(d.status), esc(d.target_asset || '—'), d.status === 'flying' ? `T+${d.arrival_at}` : d.charge_ready_at ? `T+${d.charge_ready_at}` : 'Ready'])), 'FROZEN POSITIONS');
      const candidates = f.candidates || [];
      html += panel('Why this drone?', candidates.length ? table(['Candidate', 'Flight', 'Eligible', 'Reason'], candidates.map(c => [esc(c.sensor_id), `${c.flight_minutes} min`, tag(c.eligible ? 'yes' : 'no', c.eligible ? 'teal' : 'amber'), esc(c.reason)]), candidates.findIndex(c => c.sensor_id === op?.sensor_id)) + '<p class="tiny-note">Candidate comparison was frozen at dispatch. It is not rescored with later inspection evidence.</p>' : empty('No dispatch comparison has been made for this asset at this step.'), 'DISPATCH CONSTRAINTS');
      html += panel('Received observer reports', (f.inspection_requests || []).length ? (f.inspection_requests || []).map(r => `<div class="audit-item"><span class="audit-time">T+${r.received_at}</span><div><strong>${esc(r.source)} · ${esc(r.priority)}</strong><p>${esc(r.reason)}</p></div></div>`).join('') + details('Report lifecycle data', f.inspection_requests) : empty('No report for LINE_058 has arrived yet.'), 'PUBLICLY RECEIVED INPUT', true);
      html += '</div>';
    }
    if (evidenceTab === 'baseline') {
      const rows = channels.map(([key,name,unit]) => { const b = ex.baseline?.[key], ev = ex.assessment?.evidence?.find(e => e.channel === key), v = ex.reading?.[key]; return [esc(name), `${fmt(v,3)} ${unit}`, b ? `${fmt(b.mean,3)} ${unit}` : 'Unknown', b ? `${fmt(b.low,3)} – ${fmt(b.high,3)}` : 'Unknown', fmt(ev?.z,2)]; });
      html = `<div class="evidence-grid">${panel('Observed versus expected', ex.reading ? table(['Channel', 'Observed', 'Expected', 'Healthy reference range', 'Residual z'], rows) : empty('No fresh stationary reading has arrived for this line. Unknown is preserved.'), 'WEATHER-CONDITIONED HEALTHY BASELINE', true)}${panel('What changed the estimate?', probabilityPanel(ex) + details('Frozen reading, observation identity and timing', ex.reading) + details('Baseline means, scales and reference ranges', ex.baseline), 'SAME-WINDOW COMPARISON')}${panel('Inspection provenance', `${ex.visual?.used ? `<div class="inspection-result"><strong>${esc(String(ex.visual.evidence?.modality || 'inspection').toUpperCase())} result: ${esc(ex.visual.evidence?.result)}</strong>${ex.visual.evidence?.result === 'clear' ? 'No corresponding visible cue was found. Thermal-only defects are not excluded.' : 'Interpret this inspection within its recorded modality, quality and coverage.'}</div>` : empty('No eligible inspection factor is used at this step.')}<p class="panel-copy">Inspection freshness, modality, visibility and quality control whether the evidence can enter the model.</p>${details('Eligibility and raw inspection evidence', ex.visual, true)}${details('Historical frozen inspection comparisons', ex.inspection_history)}`, 'CURRENT ELIGIBILITY / ORIGINAL SNAPSHOTS')}${panel('How the baseline is used', '<ul class="detail-list"><li><strong>Weather changes normal behavior</strong>Ambient temperature, wind, solar exposure and uncertain load condition healthy expectations.</li><li><strong>Reference ranges describe healthy variation</strong>They are not confidence intervals on the probability of a fault.</li><li><strong>Vibration and tilt are modeled together</strong>Their correlation is retained instead of counting the same mechanical evidence twice.</li><li><strong>Flight samples are excluded</strong>Only fresh, stationary, quality-eligible measurements can diagnose this asset.</li></ul>' + details('Conditioning context', ex.context) + details('Assessment, missing inputs and alternative explanations', ex.assessment) + details('Freshness rules', ex.freshness), `${data.metadata.baseline_training_count || 3600} HEALTHY SYNTHETIC FIT RECORDS`)}${panel('Across observation windows', historyChart(ex.history) + '<p class="tiny-note">Each window is recomputed. Adjacent posteriors are not multiplied, because correlated windows would create excessive confidence.</p>' + details('All available assessment windows', ex.history), 'HISTORICAL WINDOWS / NOT A RECURSIVE DBN')}</div>`;
    }
    if (evidenceTab === 'network') {
      const calc = ex.calculation || {}, rows = calc.states || [];
      html = `<div class="evidence-grid">${panel('An inspection can revise a strong sensor signal', probabilityPanel(ex), 'SAME WINDOW', true)}${panel('A declared dependency model', '<p class="panel-copy">Select a variable to inspect its parents and children. The arrows declare conditional dependencies; they do not prove physical causality.</p><svg id="network-svg" viewBox="0 0 1050 510" role="img" aria-label="Bayesian dependency network with selectable variables"></svg><div id="network-node-info" class="network-tooltip"></div>', 'CONDITIONS → STATES → OBSERVATIONS', true)}${panel(`Exact joint-state enumeration · ${rows.length || 'no'} states`, rows.length ? table(['M', 'T', 'Sensor issue', 'Energized', 'Prior', 'Sensor log L', 'Inspection L', 'After sensors', 'Posterior'], rows.map(r => [r.mechanical ? '1' : '0', r.thermal ? '1' : '0', r.sensor_fault ? '1' : '0', r.energized ? '1' : '0', pct(r.prior_probability), fmt(r.log_sensor_likelihood,2), fmt(r.visual_likelihood,3), pct(r.posterior_without_visual), pct(r.posterior_probability)])) + '<p class="tiny-note">M and T can coexist with a sensor issue. Known energized state is fixed; an unknown energized state is explicitly enumerated. Tiny probabilities are rounded here; the export preserves precision.</p>' : empty('No current calculation is available without a usable observation.'), 'NORMALIZED JOINT PROBABILITIES', true)}${panel('Inference and parameter assumptions', '<p class="panel-copy">Posterior ∝ prior × sensor likelihood × eligible inspection likelihood. Mechanical observation channels enter as one correlated likelihood group. The inspection factor uses state-specific modality coverage.</p>' + details('Priors and evidence availability', {priors:calc.priors, evidence_state:calc.evidence_state}, true) + details('Likelihood groups', calc.likelihood_groups) + details('Inspection likelihood assumptions', calc.visual) + details('All calculation assumptions', calc.assumptions), 'EXACT ENUMERATION', true)}</div>`;
    }
    if (evidenceTab === 'weather') html = `<div class="evidence-grid">${panel('Weather available at this snapshot', keyValues(Object.fromEntries(Object.entries(f.weather || {}).filter(([,v]) => typeof v !== 'object'))) + details('Full received weather and warnings', f.weather), 'NOT FUTURE WEATHER')}${panel('Flight decision constraints', keyValues(Object.fromEntries(Object.entries(f.weather_decision || {}).filter(([,v]) => typeof v !== 'object'))) + details('Weather decision and uncertainty', f.weather_decision) + details('Route model and executed timings', f.route), 'SIMULATED LEG / NOT AIRSPACE PLANNING')}${panel('Where each assumption comes from', table(['Component', 'Source and boundary'], Object.entries(data.metadata.provenance || {}).map(([k,v]) => [esc(label(k)), esc(v)])) + '<p class="tiny-note">Official geometry is not a validated electrical topology. Assumed charging availability and simulated point-to-point routes require operational validation.</p>', 'SOURCE REGISTER', true)}${panel('Frozen release binding', keyValues({model:data.metadata.model_version, baseline:data.metadata.baseline_version, scenario:data.metadata.scenario, seed:data.metadata.seed, code_hash:data.metadata.code_hash, snapshot_id:f.snapshot_id}) + details('All release metadata and policy assumptions', data.metadata), 'REPRODUCIBLE SNAPSHOT', true)}</div>`;
    if (evidenceTab === 'audit') {
      const audit = f.audit || [];
      html = `<div class="evidence-grid">${panel('The event trail', audit.length ? audit.map(e => `<div class="audit-item"><span class="audit-time">T+${e.minute ?? e.received_at ?? '—'}</span><div><strong>${esc(label(e.type || e.event || 'Mission event'))}</strong><p>${esc(e.reason || e.note || e.source || e.sensor_id || '')}</p></div></div>`).join('') + details('Exact audit records', audit) : empty('No related mission event has been received yet.'), 'RECEIVED EVENTS ONLY')}${panel('Replanning and decisions', (f.replans || []).map(r => `<div class="audit-item"><span class="audit-time">T+${r.minute}</span><div><strong>${esc(r.trigger)}</strong><p>${esc(r.summary)}</p></div></div>`).join('') + details('Complete replanning records', f.replans, true), 'COMMITTED FLIGHTS ARE RETAINED')}${panel('Expected-loss action comparison', (f.recommendations || []).length ? table(['Action', 'Expected loss', 'Immediate cost', 'Reason'], f.recommendations.map(r => [esc(r.label || r.action), fmt(r.expected_loss,3), fmt(r.cost,2), esc(r.reason)])) + details('Outcome branches, cost breakdowns and information value', f.recommendations) : empty('No evidence-based action comparison is available yet.'), 'SYNTHETIC COSTS / ONE-STEP ACTION MODEL', true)}${panel('Complete snapshot export', '<p class="panel-copy">The export includes exactly this asset, operation, fleet, weather, received reports and evidence window. It contains no simulator fault labels and does not advance the simulation.</p><button class="outline-button" id="download-snapshot-inner">↓ Download JSON snapshot</button>' + details('Inspect the full JSON', f), esc(f.snapshot_id), true)}</div>`;
    }
    $('evidence-content').innerHTML = html;
    if (evidenceTab === 'network') renderNetwork(ex.calculation?.structure || data.metadata.model_structure);
    $('download-snapshot-inner')?.addEventListener('click', exportSnapshot);
  }
  function historyChart(history) {
    const points = (history || []).filter(r => typeof r.anomaly === 'number' || typeof r.assessment?.anomaly === 'number');
    if (points.length < 2) return empty('Not enough observed windows for a probability history at this step.');
    const min = Math.min(...points.map(p=>p.minute)), max = Math.max(...points.map(p=>p.minute));
    const d = points.map((p,i) => `${i?'L':'M'}${35+(p.minute-min)/Math.max(1,max-min)*480},${110-(p.anomaly??p.assessment.anomaly)*85}`).join(' ');
    return `<svg class="sparkline" viewBox="0 0 550 135" role="img" aria-label="Model probability by observation window"><path d="M35 25H520 M35 67H520 M35 110H520" stroke="#2b424e" fill="none"/><text x="4" y="28" font-size="9" fill="#8da7b4">100%</text><text x="16" y="113" font-size="9" fill="#8da7b4">0%</text><path d="${d}" fill="none" stroke="#68e0c4" stroke-width="2"/><text x="35" y="129" font-size="9" fill="#8da7b4">T+${min}</text><text x="490" y="129" font-size="9" fill="#8da7b4">T+${max}</text></svg>`;
  }
  function renderNetwork(structure) {
    if (!structure?.nodes) { $('network-svg').innerHTML = ''; $('network-node-info').textContent = 'Dependency metadata unavailable.'; return; }
    const positions = {Q:[165,100],O:[165,210],I:[165,320],W:[165,430],S:[520,90],F:[520,175],E:[520,260],T:[520,345],M:[520,430],ZV:[875,110],ZT:[875,220],ZM:[875,330],R:[875,440]};
    const selected = structure.nodes.find(n=>n.id===activeNode), neighbors = new Set([activeNode]);
    for (const [a,b] of structure.edges) if (a===activeNode || b===activeNode) { neighbors.add(a); neighbors.add(b); }
    let svg = '<defs><marker id="network-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6" fill="#608f93"/></marker></defs>';
    const groups = [[20,'BACKGROUND CONDITIONS','#152632'],[375,'HIDDEN STATES','#142d2d'],[730,'OBSERVATIONS','#142937']];
    for(const [x,name,color] of groups) svg+=`<rect x="${x}" y="0" width="300" height="500" rx="8" fill="${color}"/><text x="${x+150}" y="25" fill="#9cb7c2" text-anchor="middle" font-size="11" letter-spacing="1">${name}</text>`;
    structure.edges.forEach(([a,b],edgeIndex) => {
      const p=positions[a],q=positions[b]; if (!p||!q) return;
      const focused = !activeNode || a===activeNode || b===activeNode;
      let path;
      if(p[0]===q[0]) path=`M${p[0]},${p[1]+25} L${q[0]},${q[1]-25}`;
      else if (p[0]===165 && q[0]===875) { const y = 480 + (edgeIndex%4)*5; path=`M${p[0]+126},${p[1]} H${p[0]+144+(edgeIndex%3)*7} V${y} H${q[0]-143-(edgeIndex%3)*7} V${q[1]} H${q[0]-127}`; }
      else path=`M${p[0]+127},${p[1]} C${p[0]+167},${p[1]} ${q[0]-167},${q[1]} ${q[0]-128},${q[1]}`;
      svg+=`<path d="${path}" fill="none" stroke="${focused?'#608f93':'#334a51'}" stroke-width="${activeNode&&focused?2.8:1.2}" opacity="${focused?.85:.22}" marker-end="url(#network-arrow)"><title>${esc(a)} → ${esc(b)}</title></path>`;
    });
    structure.nodes.forEach(node => {
      const p=positions[node.id];if(!p)return;
      const text=node.label.replace(/^[A-Z] · /,'');
      const split=text.length>28 ? text.lastIndexOf(' ',28) : -1;
      const lines=split>0?[text.slice(0,split),text.slice(split+1)]:[text];
      svg+=`<g class="network-node${node.id===activeNode?' selected':''}" role="button" tabindex="0" data-node="${node.id}" aria-label="Inspect ${esc(node.label)}" opacity="${!activeNode||neighbors.has(node.id)?1:.35}"><rect x="${p[0]-127}" y="${p[1]-25}" width="254" height="50" rx="5" fill="${node.kind==='latent'?'#1b3b37':'#1b3342'}" stroke="#3d5c64"/><text x="${p[0]-115}" y="${p[1]+4}" font-size="12" font-weight="650" fill="#68e0c4">${node.id}</text>${lines.map((line,i)=>`<text x="${p[0]+9}" y="${p[1]+(lines.length===2?-3:4)+i*14}" text-anchor="middle" font-size="11" fill="#d7e7e9">${esc(line)}</text>`).join('')}</g>`;
    });
    $('network-svg').innerHTML=svg;
    $('network-node-info').innerHTML=selected?`<strong>${esc(selected.id)} · ${esc(selected.label)}</strong>Parents: ${structure.edges.filter(e=>e[1]===activeNode).map(e=>esc(e[0])).join(', ')||'None (conditioned input)'}<br>Children: ${structure.edges.filter(e=>e[0]===activeNode).map(e=>esc(e[1])).join(', ')||'None (observed evidence)'}<br>Type: ${esc(selected.kind)}. ${selected.kind==='latent'?'This state is inferred; it is not directly observed.':'Input or observation is conditioned on its recorded availability.'}`:'13 declared variables · 20 dependency edges. Select any variable to trace its immediate dependencies.';
    $('network-svg').querySelectorAll('[data-node]').forEach(g=>{ const select=()=>{activeNode=activeNode===g.dataset.node?null:g.dataset.node;renderNetwork(structure);};g.addEventListener('click',select);g.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}}); });
  }
  function renderValidation() {
    const v=data.validation, m=v?.metadata, overall=v?.overall;
    if(!v||!m||!overall){$('validation-content').innerHTML=empty('The frozen validation report is unavailable. No performance claim is displayed.');return;}
    if(!bindingOK){$('validation-content').innerHTML='<div class="notice danger">This report does not match the replay model or source fingerprint. Performance results are withheld until the release is rebuilt.</div>'+details('Replay metadata',data.metadata,true)+details('Validation metadata',m,true);return;}
    const counts=overall.counts, a=overall.asset_detection.confusion, d=overall.sensor_drift_detection.confusion;
    $('validation-content').innerHTML=`<div class="notice teal">Release binding verified: ${esc(m.model_version)} · source ${esc(m.code_hash.slice(0,12))}. The report and replay use the same frozen inference source.</div><div class="validation-stats"><div class="validation-stat"><div class="label">Usable observations</div><div class="number">${counts.observed}<small> / ${counts.stationed_samples}</small></div><div class="note">${counts.missing} missing slots kept separate</div></div><div class="validation-stat"><div class="label">Asset anomalies detected</div><div class="number">${a.true_positive}<small> / ${a.true_positive+a.false_negative}</small></div><div class="note">${a.false_positive} false alarms in ${a.true_negative+a.false_positive} negative slots</div></div><div class="validation-stat"><div class="label">Sensor drift detected</div><div class="number" style="color:var(--amber)">${d.true_positive}<small> / ${d.true_positive+d.false_negative}</small></div><div class="note">${d.false_negative} misses · ${d.false_positive} false positive</div></div><div class="validation-stat"><div class="label">Evaluation protocol</div><div class="number">6 <small>scenarios × 6 seeds</small></div><div class="note">Five stationed slots · T+${m.minute} only</div></div></div><div class="notice">These are matched synthetic observations, not independent field trials. No real-world accuracy, calibrated risk, optimal route or reduction in human visits has been established.</div><div class="evidence-grid">${panel('Three different reliability questions', '<ul class="detail-list"><li><strong>Computation: can the result be reconstructed?</strong>Exact enumeration, normalized probabilities, same-window inspection updates and explicit evidence expiry make each result auditable. Regression tests support implementation consistency.</li><li><strong>Synthetic behavior: does it respond as configured?</strong>Six static synthetic scenarios are evaluated at one timestamp. Missing observations are excluded from confusion matrices and reported separately.</li><li><strong>Field performance: does the method generalize?</strong>Real labeled events, parameter calibration, independent scenario holdouts and human escalation/latency evaluation remain to be done.</li></ul>', 'MECHANISM / SIMULATION / DEPLOYMENT')}${panel('The failure case stays visible', `<div class="notice danger">Only ${d.true_positive} of ${d.true_positive+d.false_negative} injected sensor-drift slots was detected. Sensor diagnosis is an unresolved weakness.</div><p class="panel-copy">The strong asset result does not establish probability calibration or dynamic mission benefit. A Brier score and reliability bins, supported by enough independent data, are still needed.</p><p class="panel-copy">Next comparisons: fixed thresholds, conditional residual thresholds and full BN under identical constraints; then event misses, discovery delay and unnecessary human escalations.</p>`, 'KNOWN LIMITS')}${panel('Scenario-level results', table(['Scenario','Observed / slots','Missing','Asset TP / FN / FP','Drift TP / FN / FP'],v.scenarios.map(s=>{const c=s.summary.counts,ac=s.summary.asset_detection.confusion,dc=s.summary.sensor_drift_detection.confusion;return[esc(s.label),`${c.observed} / ${c.stationed_samples}`,c.missing,`${ac.true_positive} / ${ac.false_negative} / ${ac.false_positive}`,`${dc.true_positive} / ${dc.false_negative} / ${dc.false_positive}`];})), 'SEEDS 42–47 / T+55 / STATIC STATIONED SNAPSHOT',true)}${panel('Parameter provenance',table(['Component','Established source / remaining assumption'],Object.entries(data.metadata.provenance||{}).map(([k,val])=>[esc(label(k)),esc(val)]))+details('Frozen configuration and action costs',data.metadata.assumptions), 'MANUAL STRUCTURE, SYNTHETIC FIT AND EXPLICIT ASSUMPTIONS')}${panel('Reproduce the protocol',`<p class="panel-copy">${esc(m.protocol)}</p><p class="panel-copy">${esc(m.scope)}</p><p class="tiny-note">Run from the project directory: <code>python -m gridscout.showcase_data</code>. The public page uses the precomputed record; opening it never runs the evaluation.</p>${details('Complete protocol metadata',m,true)}${details('Full validation result',v)}`, 'FROZEN MODEL / SOURCE FINGERPRINT')}</div>`;
  }
  function exportSnapshot() {
    const blob=new Blob([JSON.stringify({metadata:data.metadata,snapshot:evidenceFrame},null,2)],{type:'application/json'}), url=URL.createObjectURL(blob), a=document.createElement('a');a.href=url;a.download=`gridscout-${evidenceFrame.snapshot_id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function bind() {
    document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.page)));
    document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();setPage('showcase');});
    $('chapter-nav').innerHTML=chapters.map((c,i)=>`<button data-chapter="${i}" aria-label="Chapter ${i+1}: ${esc(c.title)}"><span class="chapter-index">${String(i+1).padStart(2,'0')}</span><span>${titleShort[i]||esc(c.title)}</span></button>`).join('');
    document.querySelectorAll('[data-chapter]').forEach(b=>b.addEventListener('click',()=>goChapter(Number(b.dataset.chapter))));
    $('play-toggle').addEventListener('click',()=>playing?pause():play());
    $('previous').addEventListener('click',()=>goChapter(chapterIndex()-1));
    $('next').addEventListener('click',()=>goChapter(chapterIndex()+1));
    $('replay').addEventListener('click',()=>{cursor=0;reduced?pause():play();renderShowcase(true);});
    $('scrubber').max=duration;$('scrubber').addEventListener('input',()=>{cursor=Number($('scrubber').value);pause();renderShowcase(true);});
    $('evidence-link').addEventListener('click',()=>{evidenceFrame=currentFrame();evidenceTab=chapterIndex()>=4?'baseline':'operations';setPage('dashboard');});
    $('return-showcase').addEventListener('click',()=>{pause();setPage('showcase');});
    $('snapshot-select').innerHTML=frames.map(f=>`<option value="${esc(f.snapshot_id)}">T+${f.minute} · ${esc(f.snapshot_id)}</option>`).join('');
    $('snapshot-select').addEventListener('change',()=>{evidenceFrame=frames.find(f=>f.snapshot_id===$('snapshot-select').value);renderEvidence();});
    document.querySelectorAll('[data-evidence]').forEach(b=>b.addEventListener('click',()=>{evidenceTab=b.dataset.evidence;renderEvidence();}));
    $('download-snapshot').addEventListener('click',exportSnapshot);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
    window.addEventListener('hashchange',()=>{const target=location.hash.slice(1);if(['showcase','dashboard','validation'].includes(target))setPage(target);});
  }
  async function init() {
    try {
      const embedded=$('showcase-data').textContent.trim();
      data=embedded&&embedded!=='__SHOWCASE_DATA__'?JSON.parse(embedded):await fetch('../artifacts/showcase_data.json').then(r=>{if(!r.ok)throw Error('Mission data request failed');return r.json();});
      if(!data.frames?.length||data.chapters?.length!==6||!data.geometry?.length)throw Error('Incomplete mission record');
      frames=data.frames;chapters=data.chapters;duration=chapters.reduce((n,c)=>n+c.duration_seconds,0);boundaries=[];let sum=0;for(const c of chapters){boundaries.push(sum);sum+=c.duration_seconds;}
      const vm=data.validation?.metadata;bindingOK=Boolean(vm&&vm.model_version===data.metadata.model_version&&vm.code_hash===data.metadata.code_hash);
      $('replay-stage').hidden=false;
      if(bindingOK)$('load-notice').hidden=true;else{$('load-notice').classList.add('error');$('load-notice').textContent='Release check failed: the validation report and replay do not share a model/source fingerprint. Autoplay is paused and performance claims are withheld. Chapters remain available for inspection.';}
      $('version-footer').textContent=`${data.metadata.model_version} · source ${data.metadata.code_hash.slice(0,8)}`;
      $('source-link').href=data.metadata.repository_url||'https://github.com/Yuting-He/yuting-he-portfolio/tree/main/watt-hackathon';
      bind();evidenceFrame=frames[0];renderShowcase(true);
      const initial=location.hash.slice(1);if(['dashboard','validation'].includes(initial))setPage(initial);else if(!reduced&&bindingOK)play();
      window.GridScout={getState:()=>({page,playing,cursor,chapter:chapterIndex(),minute:currentFrame().minute,snapshot_id:currentFrame().snapshot_id,evidence_snapshot_id:evidenceFrame?.snapshot_id,evidenceTab,bindingOK,duration}),pause,play,goChapter,setPage};
      requestAnimationFrame(tick);
    }catch(error){$('load-notice').classList.add('error');$('load-notice').innerHTML=`The frozen mission record could not be loaded. ${esc(error.message)}<br>Please reload the page or inspect the project source. No performance claim is displayed.`;console.error('GridScout load:',error);}
  }
  function tick(now){if(playing&&page==='showcase'){cursor=Math.min(duration,cursor+Math.min(.25,(now-(lastTick||now))/1000));if(cursor>=duration)playing=false;renderShowcase();}lastTick=now;requestAnimationFrame(tick);}
  init();
})();



