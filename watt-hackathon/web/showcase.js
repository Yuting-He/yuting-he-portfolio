/* GridScout's public viewer reads frozen, received-evidence snapshots only. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (v, digits = 1) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
  const pct = (v, digits = 1) => typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : 'Unknown';
  const pretty = value => esc(JSON.stringify(value, null, 2));
  const label = value => String(value ?? 'Unknown').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const clock = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let data, frames, chapters, boundaries, duration = 0, cursor = 0, playing = false, page = 'showcase', evidenceTab = 'operations', evidenceFrame, lastTick, renderedKey, activeNode = null, bindingOK = false;
  const channels = [['temperature_c', 'Conductor temperature', '°C'], ['vibration_rms', 'Vibration RMS', 'RMS'], ['tilt_deg', 'Relative tilt', '°'], ['voltage_pu', 'Energization proxy', 'p.u.']];
  const palette = {teal:'#68e0c4', amber:'#efbd75', red:'#ff8b91', blue:'#8ab9ec', grey:'#647b87'};
  const panel = (title, content, eyebrow = '', full = false) => `<section class="evidence-panel${full ? ' full' : ''}">${eyebrow ? `<div class="panel-eyebrow">${eyebrow}</div>` : ''}<h3>${title}</h3>${content}</section>`;
  const details = (title, value, open = false) => `<details${open ? ' open' : ''}><summary>${esc(title)}</summary><pre>${pretty(value)}</pre></details>`;
  const tag = (text, tone = '') => `<span class="tag ${tone}">${esc(text)}</span>`;
  const table = (headings, rows, selected = -1) => `<div class="data-table-wrap"><table class="data-table"><thead><tr>${headings.map(x => `<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr${i === selected ? ' class="selected"' : ''}>${r.map(x => `<td>${x ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const metric = (value, text, tone = '') => `<div class="metric"><strong class="${tone}">${value}</strong><span>${text}</span></div>`;
  const empty = message => `<div class="empty-state">${message}</div>`;
  const keyValues = obj => table(['Property', 'Frozen value'], Object.entries(obj || {}).map(([k,v]) => [esc(label(k)), esc(typeof v === 'object' ? JSON.stringify(v) : v)]));
  const assetFor = frame => frame.asset_id || frame.operation?.asset_id || data.metadata.asset_id;
  const snapshotFor = (minute, asset) => {
    const matching = frames.filter(f => assetFor(f) === asset);
    return matching.find(f => f.minute === minute) || matching.filter(f => f.minute <= minute).sort((a,b) => b.minute-a.minute)[0] || matching[0];
  };
  function chapterIndex() { let i = boundaries.findIndex((start, j) => cursor >= start && cursor < (boundaries[j + 1] ?? duration + 1)); return i < 0 ? chapters.length - 1 : i; }
  function currentFrame() {
    const i = chapterIndex(), chapter = chapters[i], local = Math.min(1, (cursor - boundaries[i]) / chapter.duration_seconds);
    const minutes = chapter.frame_minutes?.length ? chapter.frame_minutes : [chapter.minute];
    return snapshotFor(minutes[Math.min(minutes.length - 1, Math.floor(local * minutes.length))], chapter.asset_id || data.metadata.asset_id);
  }
  function goChapter(index) { cursor = boundaries[Math.max(0, Math.min(chapters.length - 1, index))]; pause(); renderShowcase(true); }
  function pause() { playing = false; renderControls(); }
  function play() { if (cursor >= duration) cursor = 0; playing = true; lastTick = performance.now(); renderShowcase(true); }
  function setPage(next) {
    if (page === 'showcase' && next === 'dashboard') evidenceFrame = currentFrame();
    if (next !== 'showcase') pause();
    page = next;
    document.body.classList.toggle('schedule-open', next === 'schedule');
    const schedule = $('schedule-frame');
    if (next === 'schedule' && !schedule.dataset.loaded) {
      const documentText = $('schedule-document').textContent.trim();
      if (documentText === '__SCHEDULE_DOCUMENT__') schedule.src = 'schedule.html';
      else schedule.srcdoc = JSON.parse(documentText);
      schedule.dataset.loaded = 'true';
    } else if (next !== 'schedule' && schedule.dataset.loaded) {
      schedule.contentWindow?.postMessage({type:'gridscout:pause-route'}, '*');
    }
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
    const i = chapterIndex(), chapter = chapters[i], frame = currentFrame(), asset = assetFor(frame), key = `${chapter.id}-${frame.snapshot_id}`;
    if (!force && renderedKey === key) return;
    renderedKey = key;
    document.querySelectorAll('[data-chapter]').forEach((btn, j) => {
      btn.classList.toggle('active', i === j); btn.classList.toggle('completed', i > j);
      if (i === j) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
    });
    $('chapter-number').textContent = `${String(i + 1).padStart(2, '0')} / ${String(chapters.length).padStart(2, '0')}`;
    $('stage-status').textContent = frame.narrative?.status || label(chapter.kind || chapter.id);
    $('story-title').innerHTML = esc(chapter.headline || chapter.title).replace(/\n/g, '<br>');
    $('story-what').textContent = frame.narrative?.what || chapter.what;
    $('story-why').textContent = chapter.why;
    $('story-next').textContent = frame.narrative?.next || chapter.next;
    $('story-metric').innerHTML = storyMetrics(frame, chapter);
    $('story-snapshot').textContent = `${frame.snapshot_id} · ${asset} · T+${frame.minute}`;
    $('map-clock').textContent = `T+${frame.minute} min`;
    $('map-location').textContent = chapter.kind === 'coverage' ? 'Post-storm inspection network' : `${asset} · inspection mission`;
    const op = frame.operation, access = op?.inspection_access, route = frame.route, latestReport = frame.inspection_requests?.at(-1);
    $('map-context').innerHTML = chapter.kind === 'coverage' ? '<strong>Coverage is incomplete</strong><span class="context-divider">/</span><span>Unobserved lines remain Unknown</span>' : chapter.kind === 'report' ? `<strong>${esc(asset)} · report received${latestReport ? ` at T+${latestReport.received_at}` : ''}</strong><span class="context-divider">/</span><span>Unverified lead · seek target evidence</span>` : access?.mode === 'nearby_stationary' ? `<strong>${esc(op.sensor_id)} at ${esc(access.observer_asset_id)}</strong><span class="context-divider">/</span><span>Nearby RGB view · ${fmt(access.distance_m)} m · no takeoff</span>` : route ? `<strong>${esc(route.origin_asset)} → ${esc(route.target_asset)}</strong><span class="context-divider">/</span><span>${frame.minute < route.arrival_at ? 'Recorded simulated flight' : 'Stationary target measurements'}</span>` : `<strong>${esc(asset)}</strong><span class="context-divider">/</span><span>${esc(op?.sensor_id || 'Awaiting assignment')} · target-specific evidence</span>`;
    renderMap(frame, chapter);
  }
  function storyMetrics(frame, chapter) {
    const kind = chapter.kind || chapter.id, op = frame.operation, access = op?.inspection_access;
    const ex = frame.explanation || {}, sums = ex.calculation?.summaries || {}, image = ex.visual?.evidence, route = frame.route;
    const selected = (frame.candidates || []).find(c => c.sensor_id === op?.sensor_id);
    const metrics = (...items) => `<div class="story-metrics">${items.join('')}</div>`;
    if (kind === 'coverage' || kind === 'context') return metrics(metric(String(frame.fleet.length), 'mobile sensing drones'),metric(String(data.geometry.length), 'mapped line segments'),metric('Unknown', 'unobserved line status', 'amber'));
    if (kind === 'report') return metrics(metric(esc(assetFor(frame)), 'received observer report', 'amber'),metric(esc(ex.assessment?.status || 'Unknown'), 'current target assessment'));
    if (kind === 'selection') return metrics(metric(esc(op?.sensor_id || 'Pending'), selected?.observation_mode === 'nearby_stationary' ? 'nearby stationary view' : 'feasible assignment', 'teal'),metric(selected ? `${selected.flight_minutes} min` : '—', 'additional flight time'), selected?.observation_mode === 'nearby_stationary' ? metric(`${fmt(access?.distance_m ?? selected.observation_distance_m)} m`, 'to the adjacent line') : route ? metric(`T+${route.arrival_at}`, 'scheduled arrival') : metric(selected ? `${selected.flight_speed_mps} m/s` : '—', 'planned flight speed'));
    if (kind === 'flight' && route) return metrics(metric(`${fmt(route.distance_km)} km`, 'simulated flight leg'),metric(`${route.flight_speed_mps} m/s`, 'model cruise speed'),metric(`T+${route.arrival_at}`, frame.minute >= route.arrival_at ? 'arrived' : 'scheduled arrival', 'teal'));
    if (kind === 'inspection' && op?.status === 'inspecting') {
      const observer = frame.fleet.find(d=>d.sensor_id === op.sensor_id);
      return metrics(metric(access?.mode === 'nearby_stationary' ? '0' : esc(op.sensor_id), access?.mode === 'nearby_stationary' ? 'extra flights' : 'stationary observer', 'teal'),metric(`${Math.max(0, (op.inspection_due_at || frame.minute)-frame.minute)} min`, 'until image received'),metric(esc(label(observer?.status)), `${esc(op.sensor_id)} at ${esc(observer?.asset_id)}`));
    }
    if (kind === 'telemetry') return metrics(metric(ex.reading ? `${channels.filter(([key]) => Number.isFinite(ex.reading[key])).length} channels` : 'Unknown', 'stationary target telemetry', ex.reading ? 'teal' : 'amber'),metric(pct(sums.telemetry_only?.anomaly,3), 'sensors-only P(anomaly)'),metric(op?.inspection_due_at ? `T+${op.inspection_due_at}` : 'Pending', 'image result due'));
    if (ex.visual?.used && sums.telemetry_only && sums.with_visual) {
      const before = sums.telemetry_only.anomaly, after = sums.with_visual.anomaly;
      if (chapter.id === 'bn_update' && sums.prior) {
        const action = frame.recommendations?.find(r=>r.recommended) || frame.recommendations?.[0];
        return `<div class="probability-compare three-stage">${metric(pct(sums.prior.anomaly,3), 'window prior')}<span class="arrow">→</span>${metric(pct(before,3), 'after sensors')}<span class="arrow">→</span>${metric(pct(after,3), `+ ${esc(String(image?.modality || 'RGB').toUpperCase())} image`, 'teal')}<span class="same-window">T+${frame.minute} · same window · P(asset anomaly)</span></div><div class="inference-action"><span>Current recommendation</span><strong>${esc(action?.label || label(action?.action))}</strong></div>`;
      }
      return `<div class="probability-compare">${metric(pct(before,3), 'sensors only')}<span class="arrow">→</span>${metric(pct(after,3), `+ ${esc(image?.result)} ${esc(String(image?.modality || '').toUpperCase())} view`, 'teal')}<span class="delta">${fmt((after-before)*100,2)} pp<br>same window</span></div>`;
    }
    if (ex.calculation?.available) return metrics(metric(pct(sums.telemetry_only?.anomaly), 'model P(asset anomaly)'),metric(esc(ex.assessment?.status), 'current target assessment', 'teal'));
    const openReview = (frame.human_alerts || []).some(a=>['open','acknowledged'].includes(a.status));
    return metrics(metric(image ? esc(label(image.result)) : 'Pending', 'target RGB image', 'teal'),metric('Unknown', 'target telemetry unavailable', 'amber'),metric(openReview ? 'Open' : 'Pending', 'coverage review'));
  }
  // Only the badges move: their leaders always end at the recorded coordinates.
  // A stable order and candidate grid keep nearby or coincident drones legible.
  function layoutMapLabels(markers, {bounds, obstacles = [], gap = 8} = {}) {
    const area = bounds || {x:58, y:91, width:752, height:346};
    const overlaps = (a, b, padding = gap) => a.x < b.x + b.width + padding && a.x + a.width + padding > b.x && a.y < b.y + b.height + padding && a.y + a.height + padding > b.y;
    const anchorBoxes = markers.map(m => ({x:m.x - (m.radius || 8), y:m.y - (m.radius || 8), width:(m.radius || 8)*2, height:(m.radius || 8)*2}));
    const placed = [], ordered = [...markers].sort((a,b) => (a.priority || 0) - (b.priority || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const marker of ordered) {
      const width = marker.width || 44, height = marker.height || 24, space = marker.offset || 13;
      const preferred = marker.preferBelow ? {x:marker.x + space, y:marker.y + space} : {x:marker.x - width/2, y:marker.y - height - space};
      const candidates = [], seen = new Set();
      const add = (x, y) => {
        x = Math.max(area.x, Math.min(area.x + area.width - width, x));
        y = Math.max(area.y, Math.min(area.y + area.height - height, y));
        const key = `${x.toFixed(2)},${y.toFixed(2)}`;
        if (!seen.has(key)) { seen.add(key); candidates.push({x,y,width,height}); }
      };
      add(preferred.x, preferred.y);
      for (let ring = 0; ring <= markers.length; ring++) {
        for (let row = -ring; row <= ring; row++) for (let col = -ring; col <= ring; col++) {
          if (ring && Math.max(Math.abs(row), Math.abs(col)) !== ring) continue;
          add(preferred.x + col*(width + gap), preferred.y + row*(height + gap));
        }
      }
      // The full map grid is a fallback for dense groups beside the edge.
      for (let y = area.y; y <= area.y + area.height - height; y += height + gap) for (let x = area.x; x <= area.x + area.width - width; x += width + gap) add(x,y);
      const blocked = [...obstacles, ...anchorBoxes, ...placed];
      const score = box => {
        const collision = blocked.reduce((n,b) => n + (overlaps(box,b) ? 1 : 0), 0);
        const dx = box.x - preferred.x, dy = box.y - preferred.y;
        return collision*1e9 + dx*dx + dy*dy;
      };
      candidates.sort((a,b) => score(a) - score(b) || a.y - b.y || a.x - b.x);
      const box = candidates[0];
      placed.push({...marker, ...box, anchorX:marker.x, anchorY:marker.y, leaderX:Math.max(box.x,Math.min(box.x + width,marker.x)), leaderY:Math.max(box.y,Math.min(box.y + height,marker.y))});
    }
    return placed;
  }
  function renderMap(frame, chapter) {
    const asset = assetFor(frame), showTarget = !['coverage','context'].includes(chapter.kind || chapter.id), showOperation = showTarget && chapter.kind !== 'report';
    const all = data.geometry.flatMap(g => g.coordinates), west = Math.min(...all.map(p => p[0])), east = Math.max(...all.map(p => p[0])), south = Math.min(...all.map(p => p[1])), north = Math.max(...all.map(p => p[1]));
    const cosLat = Math.cos((north + south) / 2 * Math.PI / 180), scale = Math.min(690 / ((east-west)*cosLat), 350 / (north-south));
    const project = p => [425 + (p[0]-(east+west)/2)*cosLat*scale, 278 - (p[1]-(north+south)/2)*scale];
    const path = points => points.map((p,i) => `${i ? 'L' : 'M'}${project(p).map(v => v.toFixed(2)).join(',')}`).join(' ');
    let svg = '<defs><pattern id="map-grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M 50 0 H 0 V 50" fill="none" stroke="#2c424d" stroke-width=".7" opacity=".38"/></pattern><radialGradient id="target-glow"><stop stop-color="#efbd75" stop-opacity=".2"/><stop offset="1" stop-color="#efbd75" stop-opacity="0"/></radialGradient><filter id="soft-glow"><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="850" height="540" fill="url(#map-grid)"/>';
    for (let lat = Math.ceil(south*10)/10; lat < north; lat += .1) { const y = project([west,lat])[1]; svg += `<text x="22" y="${y}" font-size="8" fill="#526e7c">${lat.toFixed(1)}°N</text>`; }
    for (const g of data.geometry) {
      const state = frame.map_states?.[g.asset_id], unknown = !state || /unknown|stale/i.test(state.status || ''), risk = state?.anomaly;
      const color = unknown ? palette.grey : risk > .65 ? palette.red : risk > .2 ? palette.amber : '#6dbaad';
      const target = g.asset_id === asset && showTarget;
      svg += `<path d="${path(g.coordinates)}" fill="none" stroke="${target ? palette.amber : color}" stroke-width="${target ? 4 : 1.7}" stroke-linecap="round" opacity="${target ? 1 : .62}"${unknown && !target ? ' stroke-dasharray="2 3"' : ''}><title>${esc(g.asset_id)}: ${esc(unknown ? 'Unknown · no current usable observation' : `${state.status}; model anomaly ${pct(risk)}`)}</title></path>`;
    }
    const targetGeometry = data.geometry.find(g => g.asset_id === asset), t = project(targetGeometry.position);
    const selectedId = frame.operation?.sensor_id || chapter.focus_sensor_id, access = frame.operation?.inspection_access;
    const nearbyView = frame.operation?.observation_mode === 'nearby_stationary';
    const mapWidth = $('mission-map').getBoundingClientRect().width || 850;
    const badgeScale = Math.max(1, Math.min(2.4, 850/mapWidth)), labelGap = 7*badgeScale;
    const obstacles = [], labelMarkers = [];
    if (showTarget) {
      svg += `<circle cx="${t[0]}" cy="${t[1]}" r="48" fill="url(#target-glow)"/><circle cx="${t[0]}" cy="${t[1]}" r="15" fill="none" stroke="${palette.amber}" stroke-opacity=".55" stroke-dasharray="3 4"/><circle cx="${t[0]}" cy="${t[1]}" r="4" fill="${palette.amber}"/>`;
      labelMarkers.push({id:'target', x:t[0], y:t[1], width:(nearbyView && showOperation ? 145 : 96)*badgeScale, height:(nearbyView && showOperation ? 40 : 24)*badgeScale, radius:15, offset:22*badgeScale, preferBelow:true, priority:0, target:true});
    }
    const route = frame.route;
    if (route && showOperation) {
      const start = project(route.coordinates[0]), end = project(route.coordinates.at(-1));
      const drone = frame.fleet.find(d => d.sensor_id === selectedId);
      svg += `<path d="${path(route.coordinates)}" fill="none" stroke="${palette.teal}" stroke-width="2" stroke-dasharray="7 6" opacity=".65"/>`;
      if (drone) svg += `<path d="${path([route.coordinates[0], drone.position])}" fill="none" stroke="${palette.teal}" stroke-width="3.5"/><path d="${path([route.coordinates[0], drone.position])}" fill="none" stroke="${palette.teal}" stroke-width="7" opacity=".2" filter="url(#soft-glow)"/>`;
      const departure = {x:Math.min(660,Math.max(58,start[0]+12)), y:Math.max(91,start[1]-27), width:150, height:18};
      svg += `<circle cx="${start[0]}" cy="${start[1]}" r="5" fill="#0c2229" stroke="#68e0c4"/><text x="${departure.x}" y="${departure.y+12}" fill="#a8d5cc" font-size="10">${esc(route.origin_asset)} · departure</text>`;
      obstacles.push(departure);
      const mx = (start[0]+end[0])/2, my = (start[1]+end[1])/2;
      svg += `<rect x="${mx-39}" y="${my-12}" width="78" height="23" rx="4" fill="#142e30" stroke="#3b665e"/><text x="${mx}" y="${my+3}" fill="#a9e6d6" font-size="10" text-anchor="middle">${fmt(route.distance_km)} km ↘</text>`;
      obstacles.push({x:mx-39,y:my-12,width:78,height:23});
    }
    for (const d of frame.fleet) {
      const p = project(d.position), selected = d.sensor_id === selectedId && showOperation;
      labelMarkers.push({id:d.sensor_id, x:p[0], y:p[1], width:46*badgeScale, height:25*badgeScale, offset:13*badgeScale, radius:8, priority:selected ? 1 : 2, drone:d, selected});
    }
    const labels = layoutMapLabels(labelMarkers, {obstacles, gap:labelGap});
    // Paint every leader before the badges so no later line crosses a label.
    for (const mark of labels) svg += `<path data-map-leader="${esc(mark.id)}" d="M${mark.anchorX},${mark.anchorY} L${mark.leaderX},${mark.leaderY}" fill="none" stroke="${mark.target ? '#a18556' : mark.selected ? '#68e0c4' : '#7894a3'}" stroke-width="${badgeScale}" opacity=".85"/>`;
    for (const mark of labels) {
      if (mark.target) {
        svg += `<g data-map-label="target" data-map-asset="${esc(asset)}"><rect x="${mark.x}" y="${mark.y}" width="${mark.width}" height="${mark.height}" rx="${3*badgeScale}" fill="#292a22" stroke="#6c5d3e"/><text x="${mark.x+10*badgeScale}" y="${mark.y+16*badgeScale}" fill="#f1cf96" font-size="${11*badgeScale}" letter-spacing="1">${esc(asset)}</text>${nearbyView && showOperation ? `<text x="${mark.x+10*badgeScale}" y="${mark.y+31*badgeScale}" fill="#cfb98f" font-size="${10*badgeScale}">Stationary view · ${fmt(access?.distance_m,0)} m</text>` : ''}</g>`;
        continue;
      }
      const {drone, selected} = mark, anchor = project(drone.position), cx = mark.x + 11*badgeScale, cy = mark.y + mark.height/2;
      svg += `<g data-map-drone="${esc(drone.sensor_id)}"><title>${esc(drone.sensor_id)}: ${esc(drone.status)} · ${esc(drone.asset_id)}. Leader ends at its recorded position.</title>${selected ? `<circle cx="${anchor[0]}" cy="${anchor[1]}" r="17" fill="#68e0c4" opacity=".09"/><circle cx="${anchor[0]}" cy="${anchor[1]}" r="11" fill="none" stroke="#68e0c4" opacity=".6"/>` : ''}<circle data-map-anchor="${esc(drone.sensor_id)}" cx="${anchor[0]}" cy="${anchor[1]}" r="3" fill="${selected ? palette.teal : '#c7d6df'}" stroke="#10212b" stroke-width="1.5"/><g data-map-label="${esc(drone.sensor_id)}"><rect x="${mark.x}" y="${mark.y}" width="${mark.width}" height="${mark.height}" rx="${4*badgeScale}" fill="${selected ? '#244840' : '#172b38'}" stroke="${selected ? '#68e0c4' : '#7894a3'}" stroke-width="${badgeScale}"/><path d="M${cx},${cy-5*badgeScale} l${5*badgeScale},${5*badgeScale} ${-5*badgeScale},${5*badgeScale} ${-5*badgeScale},${-5*badgeScale} Z" fill="${selected ? palette.teal : '#c7d6df'}"/><text x="${mark.x+30*badgeScale}" y="${cy+4*badgeScale}" text-anchor="middle" font-size="${12*badgeScale}" fill="${selected ? '#a9f1d8' : '#d6e6ec'}">${esc(drone.sensor_id.replace('Drone ', 'D'))}</text></g></g>`;
    }
    const km = 5, linePx = km / 111.2 * scale;
    svg += `<g transform="translate(730 458)"><path d="M0,-4 V0 H${linePx} V-4" fill="none" stroke="#7897a6"/><text x="${linePx/2}" y="14" text-anchor="middle" fill="#7897a6" font-size="8">5 km</text></g><g transform="translate(797 91)"><path d="M0 23 V0 l-4 7 M0 0 l4 7" fill="none" stroke="#839eaa"/><text x="0" y="-7" text-anchor="middle" fill="#839eaa" font-size="9">N</text></g>`;
    const missionDescription = showOperation && selectedId ? nearbyView ? `${selectedId} observes ${asset} from its nearby stationary position; no flight is required.` : route ? `Cyan shows ${selectedId}’s simulated point-to-point route from ${route.origin_asset} to ${route.target_asset}.` : `${selectedId} is assigned to the inspection of ${asset}.` : 'Five drones cover a subset of lines.';
    $('mission-map').innerHTML = `<title id="map-title">${esc(chapter.title)} · ${esc(asset)} · T+${frame.minute}</title><desc id="map-description">Official challenge line geometry. Grey is Unknown. ${esc(missionDescription)} Drone badges avoid each other; leaders show recorded positions.</desc>${svg}`;
  }
  function probabilityPanel(explanation) {
    const calc = explanation?.calculation || {}, s = calc.summaries || {}, used = explanation?.visual?.used;
    if (!calc.available) return empty(explanation?.visual?.evidence ? `RGB result: ${esc(label(explanation.visual.evidence.result))}. Target telemetry is missing; the image is recorded separately and no asset probability is asserted.` : 'Unknown: no fresh, usable stationary telemetry at this step. No asset probability is asserted.');
    const stages = [['Window prior', s.prior?.anomaly], ['After sensors', s.telemetry_only?.anomaly], ...(used ? [['After inspection', s.with_visual?.anomaly]] : [])];
    return `<div class="comparison-bars">${stages.map(([name,p]) => `<div class="comparison-row"><span>${name}</span><div class="bar-track"><div class="bar-fill" style="width:${Number(p||0)*100}%"></div></div><span class="probability-value">${pct(p,3)}</span></div>`).join('')}</div><p class="tiny-note">${used ? 'One frozen telemetry window, one baseline and one prior. Only the eligible inspection factor changes.' : 'Inspection results have not been received or are not eligible at this step.'} These are model outputs under synthetic assumptions.</p>`;
  }
  function renderEvidence() {
    const f = evidenceFrame, ex = f.explanation || {}, op = f.operation, asset = assetFor(f);
    const frameChapter = chapters.find(c => (c.asset_id || data.metadata.asset_id) === asset && (c.frame_minutes || [c.minute]).includes(f.minute));
    $('dashboard-context').textContent = `${asset} · T+${f.minute} simulated minutes · historical, received-evidence snapshot. Replay stays paused while you inspect this record.`;
    $('evidence-binding').textContent = `${asset} · ${f.snapshot_id} · ${op?.id || op?.operation_id || 'no assigned operation yet'}`;
    $('snapshot-select').value = f.snapshot_id;
    document.querySelectorAll('[data-evidence]').forEach(b => { b.classList.toggle('active', b.dataset.evidence === evidenceTab); b.setAttribute('aria-pressed', String(b.dataset.evidence === evidenceTab)); });
    let html = '';
    if (evidenceTab === 'operations') {
      html = '<div class="evidence-grid">';
      html += panel('What is known at this step', `<div class="notice teal">${esc(f.narrative?.what || frameChapter?.what || 'Frozen mission state.')}</div><div class="inline-metrics">${metric(esc(ex.assessment?.status || 'Unknown'), 'current assessment')}${metric(pct(ex.assessment?.status === 'Unknown' ? null : ex.assessment?.anomaly,3), 'model P(asset anomaly)')}</div>${probabilityPanel(ex)}${details('Full operation and dispatch scoring', op)}`, `ASSET / ${esc(asset)}`);
      if (op?.observation_mode === 'nearby_stationary') html += panel('Reuse the nearby view', `<div class="notice teal">${esc(op.sensor_id)} stays at ${esc(op.inspection_access?.observer_asset_id)} and inspects ${esc(f.asset_id)} from ${fmt(op.inspection_access?.distance_m)} metres away. Recharge continues; no additional flight is assigned.</div><p class="panel-copy">The assumed viewing radius is ${fmt(op.inspection_access?.radius_m, 0)} metres and the mapped lines share an endpoint. A usable view is assumed; line of sight is not validated. The target receives its own image record, while contact telemetry stays with the line where it was measured.</p>${details('Stationary inspection access and observation location', op.inspection_access)}`, 'NEARBY RGB / ASSET-SPECIFIC EVIDENCE');
      const alerts = (f.human_alerts || []).filter(a => ['open', 'acknowledged'].includes(a.status));
      html += panel('Actions and human handoff', `${alerts.length ? `<div class="notice danger">${alerts.length} human field-review request${alerts.length > 1 ? 's' : ''} recorded. A clear image does not resolve an open request.</div>${details('Human review records — exact status and timestamps', alerts, true)}` : '<p class="panel-copy">No unresolved human field-review request for this asset is recorded at this snapshot.</p>'}${(f.recommendations || []).length ? table(['Current recommendation', 'Expected loss', 'Status'], f.recommendations.map(r => [esc(r.label || label(r.action)), fmt(r.expected_loss, 2), r.recommended ? tag('recommended', 'teal') : tag('alternative')])) : empty('No asset action can be inferred without current evidence.')}<p class="tiny-note">Relative loss units and action assumptions are synthetic. Recommendations are distinct from completed actions.</p>`, 'RECOMMENDATION ≠ EXECUTION');
      html += panel('Five-drone fleet', table(['Drone', 'At / origin', 'State', 'Target', 'Arrival / ready'], f.fleet.map(d => [esc(d.sensor_id), esc(d.asset_id), esc(d.status), esc(d.target_asset || '—'), d.status === 'flying' ? `T+${d.arrival_at}` : d.charge_ready_at ? `T+${d.charge_ready_at}` : 'Ready'])), 'FROZEN POSITIONS');
      const candidates = f.candidates || [];
      html += panel('Why this drone?', candidates.length ? table(['Candidate', 'Flight', 'Eligible', 'Reason'], candidates.map(c => [esc(c.sensor_id), `${c.flight_minutes} min`, tag(c.eligible ? 'yes' : 'no', c.eligible ? 'teal' : 'amber'), esc(c.reason)]), candidates.findIndex(c => c.sensor_id === op?.sensor_id)) + '<p class="tiny-note">Candidate comparison was frozen at dispatch. It is not rescored with later inspection evidence.</p>' : empty('No dispatch comparison has been made for this asset at this step.'), 'DISPATCH CONSTRAINTS');
      html += panel('Received observer reports', (f.inspection_requests || []).length ? (f.inspection_requests || []).map(r => `<div class="audit-item"><span class="audit-time">T+${r.received_at}</span><div><strong>${esc(r.source)} · ${esc(r.priority)}</strong><p>${esc(r.reason)}</p></div></div>`).join('') + details('Report lifecycle data', f.inspection_requests) : empty(`No report for ${esc(asset)} has arrived yet.`), `PUBLICLY RECEIVED INPUT / ${esc(asset)}`, true);
      html += '</div>';
    }
    if (evidenceTab === 'baseline') {
      const rows = channels.map(([key,name,unit]) => { const b = ex.baseline?.[key], ev = ex.assessment?.evidence?.find(e => e.channel === key), v = ex.reading?.[key]; return [esc(name), `${fmt(v,3)} ${unit}`, b ? `${fmt(b.mean,3)} ${unit}` : 'Unknown', b ? `${fmt(b.low,3)} – ${fmt(b.high,3)}` : 'Unknown', fmt(ev?.z,2)]; });
      html = `<div class="evidence-grid">${panel('Observed versus expected', ex.reading ? table(['Channel', 'Observed', 'Expected', 'Healthy reference range', 'Residual z'], rows) : empty('No fresh stationary reading has arrived for this line. Unknown is preserved.'), 'WEATHER-CONDITIONED HEALTHY BASELINE', true)}${panel('What changed the estimate?', probabilityPanel(ex) + details('Frozen reading, observation identity and timing', ex.reading) + details('Baseline means, scales and reference ranges', ex.baseline), 'SAME-WINDOW COMPARISON')}${panel('Inspection provenance', `${ex.visual?.evidence ? `<div class="inspection-result"><strong>${esc(String(ex.visual.evidence?.modality || 'inspection').toUpperCase())} result: ${esc(ex.visual.evidence?.result)}</strong>${ex.visual.evidence?.result === 'clear' ? 'No corresponding visible cue was found. Thermal-only defects are not excluded.' : 'Interpret this inspection within its recorded modality, quality and coverage.'}</div>` : empty('No eligible inspection factor is used at this step.')}<p class="panel-copy">${ex.visual?.evidence && !ex.visual?.used ? 'Image received and recorded separately. No target telemetry is available, so this image does not enter a sensor posterior. ' : ''}Inspection freshness, modality, visibility and quality control whether the evidence can enter the model.</p>${details('Eligibility and raw inspection evidence', ex.visual, true)}${details('Historical frozen inspection comparisons', ex.inspection_history)}`, 'CURRENT ELIGIBILITY / ORIGINAL SNAPSHOTS')}${panel('How the baseline is used', '<ul class="detail-list"><li><strong>Weather changes normal behavior</strong>Ambient temperature, wind, solar exposure and uncertain load condition healthy expectations.</li><li><strong>Reference ranges describe healthy variation</strong>They are not confidence intervals on the probability of a fault.</li><li><strong>Vibration and tilt are modeled together</strong>Their correlation is retained instead of counting the same mechanical evidence twice.</li><li><strong>Flight samples are excluded</strong>Only fresh, stationary, quality-eligible measurements can diagnose this asset.</li></ul>' + details('Conditioning context', ex.context) + details('Assessment, missing inputs and alternative explanations', ex.assessment) + details('Freshness rules', ex.freshness), `${data.metadata.baseline_training_count || 3600} HEALTHY SYNTHETIC FIT RECORDS`)}${panel('Across observation windows', historyChart(ex.history) + '<p class="tiny-note">Each window is recomputed. Adjacent posteriors are not multiplied, because correlated windows would create excessive confidence.</p>' + details('All available assessment windows', ex.history), 'HISTORICAL WINDOWS / NOT A RECURSIVE DBN')}</div>`;
    }
    if (evidenceTab === 'network') {
      const calc = ex.calculation || {}, rows = calc.states || [];
      html = `<div class="evidence-grid">${panel('What the available evidence can establish', probabilityPanel(ex), `${esc(asset)} / SAME WINDOW`, true)}${panel('A declared dependency model', '<p class="panel-copy">Select a variable to inspect its parents and children. The arrows declare conditional dependencies; they do not prove physical causality.</p><svg id="network-svg" viewBox="0 0 1050 510" role="img" aria-label="Bayesian dependency network with selectable variables"></svg><div id="network-node-info" class="network-tooltip"></div>', 'CONDITIONS → STATES → OBSERVATIONS', true)}${panel(`Exact joint-state enumeration · ${rows.length || 'no'} states`, rows.length ? table(['M', 'T', 'Sensor issue', 'Energized', 'Prior', 'Sensor log L', 'Inspection L', 'After sensors', 'Posterior'], rows.map(r => [r.mechanical ? '1' : '0', r.thermal ? '1' : '0', r.sensor_fault ? '1' : '0', r.energized ? '1' : '0', pct(r.prior_probability), fmt(r.log_sensor_likelihood,2), fmt(r.visual_likelihood,3), pct(r.posterior_without_visual), pct(r.posterior_probability)])) + '<p class="tiny-note">M and T can coexist with a sensor issue. Known energized state is fixed; an unknown energized state is explicitly enumerated. Tiny probabilities are rounded here; the export preserves precision.</p>' : empty('No current calculation is available without a usable observation.'), 'NORMALIZED JOINT PROBABILITIES', true)}${panel('Inference and parameter assumptions', '<p class="panel-copy">Posterior ∝ prior × sensor likelihood × eligible inspection likelihood. Mechanical observation channels enter as one correlated likelihood group. The inspection factor uses state-specific modality coverage.</p>' + details('Priors and evidence availability', {priors:calc.priors, evidence_state:calc.evidence_state}, true) + details('Likelihood groups', calc.likelihood_groups) + details('Inspection likelihood assumptions', calc.visual) + details('All calculation assumptions', calc.assumptions), 'EXACT ENUMERATION', true)}</div>`;
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
    $('chapter-nav').style.setProperty('--chapter-count',chapters.length);
    $('chapter-nav').innerHTML=chapters.map((c,i)=>`<button data-chapter="${i}" data-asset="${esc(c.asset_id || data.metadata.asset_id)}" aria-label="Chapter ${i+1}: ${esc(c.title)} · ${esc(c.asset_id || data.metadata.asset_id)}"><span class="chapter-index">${String(i+1).padStart(2,'0')}</span><span>${esc(c.short_title || c.title)}</span></button>`).join('');
    document.querySelectorAll('[data-chapter]').forEach(b=>b.addEventListener('click',()=>goChapter(Number(b.dataset.chapter))));
    $('play-toggle').addEventListener('click',()=>playing?pause():play());
    $('previous').addEventListener('click',()=>goChapter(chapterIndex()-1));
    $('next').addEventListener('click',()=>goChapter(chapterIndex()+1));
    $('replay').addEventListener('click',()=>{cursor=0;reduced?pause():play();renderShowcase(true);});
    $('scrubber').max=duration;$('scrubber').addEventListener('input',()=>{cursor=Number($('scrubber').value);pause();renderShowcase(true);});
    $('evidence-link').addEventListener('click',()=>{evidenceFrame=currentFrame();evidenceTab=evidenceFrame.explanation?.reading || evidenceFrame.explanation?.visual?.evidence ? 'baseline' : 'operations';setPage('dashboard');});
    $('return-showcase').addEventListener('click',()=>{pause();setPage('showcase');});
    $('snapshot-select').innerHTML=frames.map(f=>`<option value="${esc(f.snapshot_id)}">${esc(assetFor(f))} · T+${f.minute} · ${esc(f.snapshot_id)}</option>`).join('');
    $('snapshot-select').addEventListener('change',()=>{evidenceFrame=frames.find(f=>f.snapshot_id===$('snapshot-select').value);renderEvidence();});
    document.querySelectorAll('[data-evidence]').forEach(b=>b.addEventListener('click',()=>{evidenceTab=b.dataset.evidence;renderEvidence();}));
    $('download-snapshot').addEventListener('click',exportSnapshot);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
    window.addEventListener('resize',()=>{if(page==='showcase')renderShowcase(true);});
    window.addEventListener('message',event=>{
      if(event.source!==$('schedule-frame').contentWindow)return;
      if(event.data?.type==='gridscout:route-height' && Number.isFinite(event.data.height)) {
        $('schedule-frame').style.height=`${Math.max(600,Math.min(12000,event.data.height))}px`;
      }
    });
    window.addEventListener('hashchange',()=>{const target=location.hash.slice(1);if(['showcase','schedule','dashboard','validation'].includes(target))setPage(target);});
  }
  async function init() {
    try {
      const embedded=$('showcase-data').textContent.trim();
      data=embedded&&embedded!=='__SHOWCASE_DATA__'?JSON.parse(embedded):await fetch('../artifacts/showcase_data.json').then(r=>{if(!r.ok)throw Error('Mission data request failed');return r.json();});
      if(!data.frames?.length||!data.chapters?.length||!data.geometry?.length)throw Error('Incomplete mission record');
      if(data.chapters.some(c=>!Number.isFinite(c.duration_seconds)||c.duration_seconds<=0))throw Error('Invalid chapter duration');
      frames=data.frames;chapters=data.chapters;duration=chapters.reduce((n,c)=>n+c.duration_seconds,0);boundaries=[];let sum=0;for(const c of chapters){boundaries.push(sum);sum+=c.duration_seconds;}
      for(const chapter of chapters) for(const minute of chapter.frame_minutes || [chapter.minute]) {
        const asset=chapter.asset_id || data.metadata.asset_id;
        if(!frames.some(f=>assetFor(f)===asset&&f.minute===minute))throw Error(`Missing frozen snapshot for ${asset} at T+${minute}`);
      }
      $('replay-duration').textContent=`Synthetic replay · ${duration} sec`;
      const vm=data.validation?.metadata;bindingOK=Boolean(vm&&vm.model_version===data.metadata.model_version&&vm.code_hash===data.metadata.code_hash);
      $('replay-stage').hidden=false;
      if(bindingOK)$('load-notice').hidden=true;else{$('load-notice').classList.add('error');$('load-notice').textContent='Release check failed: the validation report and replay do not share a model/source fingerprint. Autoplay is paused and performance claims are withheld. Chapters remain available for inspection.';}
      $('version-footer').textContent=`${data.metadata.model_version} · source ${data.metadata.code_hash.slice(0,8)}`;
      $('source-link').href=data.metadata.repository_url||'https://github.com/Yuting-He/yuting-he-portfolio/tree/main/watt-hackathon';
      bind();evidenceFrame=frames[0];renderShowcase(true);
      const initial=location.hash.slice(1);if(['schedule','dashboard','validation'].includes(initial))setPage(initial);else if(!reduced&&bindingOK)play();
      window.GridScout={getState:()=>({page,playing,cursor,chapter:chapterIndex(),chapter_id:chapters[chapterIndex()].id,asset_id:assetFor(currentFrame()),minute:currentFrame().minute,snapshot_id:currentFrame().snapshot_id,evidence_snapshot_id:evidenceFrame?.snapshot_id,evidence_asset_id:evidenceFrame?assetFor(evidenceFrame):null,evidenceTab,bindingOK,duration}),pause,play,goChapter,setPage};
      requestAnimationFrame(tick);
    }catch(error){$('load-notice').classList.add('error');$('load-notice').innerHTML=`The frozen mission record could not be loaded. ${esc(error.message)}<br>Please reload the page or inspect the project source. No performance claim is displayed.`;console.error('GridScout load:',error);}
  }
  function tick(now){if(playing&&page==='showcase'){cursor=Math.min(duration,cursor+Math.min(.25,(now-(lastTick||now))/1000));if(cursor>=duration)playing=false;renderShowcase();}lastTick=now;requestAnimationFrame(tick);}
  init();
})();



