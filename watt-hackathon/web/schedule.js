(async () => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const number = (value, digits = 2) => Number(value).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const palette = { checked: "#68e0c4", unchecked: "#e6a16f", unspecified: "#aebbd0", route: "#7aa9dc", amber: "#efbd75" };
  let data;
  let resizeObserver;
  const postHeight = () => {
    if (window.self !== window.top) window.parent.postMessage({ type: "gridscout:route-height", height: Math.ceil(document.querySelector(".route-shell").getBoundingClientRect().height) + 2 }, "*");
  };
  if (window.self !== window.top) document.body.classList.add("embedded");

  try {
    const inlineData = $("schedule-data").textContent.trim();
    if (inlineData === "__SCHEDULE_DATA__") {
      const response = await fetch("../artifacts/schedule_replay.json");
      if (!response.ok) throw new Error("Route data is unavailable.");
      data = await response.json();
    } else data = JSON.parse(inlineData);
    if (!Array.isArray(data.legs) || !data.legs.length || !Array.isArray(data.geometry) || !data.geometry.length) throw new Error("No route geometry is available.");
  } catch (error) {
    $("route-error").textContent = "This route could not be loaded. Rebuild the showcase with the imported schedule, then reload the page.";
    $("route-error").hidden = false;
    postHeight();
    return;
  }

  const legs = data.legs;
  const legCount = legs.length;
  const distance = Number(data.summary.distance_km);
  const nodeById = new Map(data.nodes.map(node => [node.node_id, node]));
  const geometryById = new Map(data.geometry.map(line => [line.line_id, line]));
  const checkedById = new Map(data.checked.map(line => [line.line_id, line]));
  const routeLineIds = new Set(legs.map(leg => leg.line_id));
  const completedDistances = [0];
  for (const leg of legs) completedDistances.push(completedDistances.at(-1) + leg.distance_km);
  const durations = legs.map(leg => Math.max(0.75, 90 * leg.distance_km / distance));
  const cumulativeDurations = [0];
  for (const duration of durations) cumulativeDurations.push(cumulativeDurations.at(-1) + duration);
  const totalDuration = cumulativeDurations.at(-1);
  const state = { position: 0, playing: false, speed: 1, view: "route", framing: "network", coverage: "checked", selectedLine: null };
  let lastTimestamp = null;
  let frameRequest = null;
  let projection;
  let projectedLegs;
  let lastRenderedLeg = -1;
  let lastCompleted = -1;
  const svg = $("route-map");

  const svgElement = (name, attributes = {}) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  };
  const validPoints = coordinates => Array.isArray(coordinates) ? coordinates.filter(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])) : [];
  const pathD = coordinates => coordinates.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(" ");

  function makeProjection() {
    let coordinates = (state.framing === "route" ? legs : data.geometry).flatMap(line => validPoints(line.coordinates));
    if (state.framing === "route") {
      const nodeIds = new Set(legs.flatMap(leg => [leg.from_node_id, leg.to_node_id]));
      coordinates = coordinates.concat(data.nodes.filter(node => nodeIds.has(node.node_id)).flatMap(node => validPoints([node.coordinates])));
    }
    const xs = coordinates.map(point => point[0]);
    const ys = coordinates.map(point => point[1]);
    const west = Math.min(...xs), east = Math.max(...xs), south = Math.min(...ys), north = Math.max(...ys);
    const centreLatitude = (north + south) / 2;
    const aspect = Math.cos(centreLatitude * Math.PI / 180);
    const scale = Math.min(718 / Math.max((east - west) * aspect, 0.00001), 430 / Math.max(north - south, 0.00001));
    const xOffset = (860 - (east - west) * aspect * scale) / 2;
    const yOffset = (530 - (north - south) * scale) / 2;
    return point => [xOffset + (point[0] - west) * aspect * scale, 530 - yOffset - (point[1] - south) * scale];
  }

  function buildMap() {
    projection = makeProjection();
    projectedLegs = legs.map(leg => {
      const points = validPoints(leg.coordinates).map(projection);
      const lengths = [0];
      for (let index = 1; index < points.length; index++) lengths.push(lengths.at(-1) + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
      return { points, lengths, length: lengths.at(-1), path: pathD(points) };
    });
    svg.innerHTML = '<title id="route-map-title">Inspection route on the official network</title><desc id="route-map-description">Use the playback controls to follow the route, or switch to reported coverage to explore the inspection results.</desc><defs><pattern id="route-grid" width="43" height="43" patternUnits="userSpaceOnUse"><path d="M 43 0 L 0 0 0 43" fill="none" stroke="#46606d" stroke-width=".5" opacity=".13"/></pattern><filter id="position-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4"/></filter></defs><rect width="860" height="530" fill="url(#route-grid)"/>';
    const network = svgElement("g", { id: "network-lines" });
    for (const line of data.geometry) {
      const path = svgElement("path", { d: pathD(validPoints(line.coordinates).map(projection)), fill: "none", stroke: "#48606c", "stroke-width": 1.7, "stroke-linecap": "round", "stroke-linejoin": "round", "data-line-id": line.line_id });
      const title = svgElement("title");
      title.textContent = `${line.line_id} · ${line.coverage === "unspecified" ? "unreported" : line.coverage}`;
      path.append(title);
      network.append(path);
    }
    svg.append(network);
    svg.append(svgElement("path", { id: "planned-route", d: [...routeLineIds].map(id => geometryById.get(id)).filter(Boolean).map(line => pathD(validPoints(line.coordinates).map(projection))).join(" "), fill: "none", stroke: palette.route, "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: .55 }));
    svg.append(svgElement("path", { id: "travelled-route", fill: "none", stroke: palette.checked, "stroke-width": 3.5, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    svg.append(svgElement("path", { id: "active-leg-base", fill: "none", stroke: palette.amber, "stroke-width": 4, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: .48 }));
    svg.append(svgElement("path", { id: "active-leg-progress", fill: "none", stroke: palette.amber, "stroke-width": 4, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    svg.append(svgElement("path", { id: "selected-line-halo", fill: "none", stroke: "#eaf3f5", "stroke-width": 9, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: .12 }));
    svg.append(svgElement("path", { id: "selected-line-path", fill: "none", stroke: "#f4e8cb", "stroke-width": 3.3, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-dasharray": "6 4" }));
    svg.append(svgElement("g", { id: "endpoint-labels" }));
    const marker = svgElement("g", { id: "route-position" });
    marker.innerHTML = '<circle r="13" fill="#efbd75" opacity=".18" filter="url(#position-glow)"/><circle r="8" fill="#0c1b23" stroke="#efbd75" stroke-width="1.5"/><circle r="3" fill="#efbd75"/><g id="position-label"><rect x="15" y="-12" width="103" height="23" rx="4" fill="#10232c" stroke="#5d6659" stroke-width=".7"/><text x="23" y="3" fill="#ecd7b8" font-size="10">Route position</text></g>';
    svg.append(marker);
    lastRenderedLeg = -1;
    lastCompleted = -1;
    renderView();
    render();
  }

  function positionOnLeg(index, fraction) {
    const leg = projectedLegs[index];
    if (!leg.points.length) return { point: [430, 265], path: "" };
    if (fraction <= 0 || !leg.length) return { point: leg.points[0], path: pathD([leg.points[0]]) };
    if (fraction >= 1) return { point: leg.points.at(-1), path: leg.path };
    const length = leg.length * fraction;
    let pointIndex = 1;
    while (pointIndex < leg.lengths.length - 1 && leg.lengths[pointIndex] < length) pointIndex++;
    const previous = leg.points[pointIndex - 1];
    const next = leg.points[pointIndex];
    const portion = (length - leg.lengths[pointIndex - 1]) / Math.max(leg.lengths[pointIndex] - leg.lengths[pointIndex - 1], .000001);
    const point = [previous[0] + (next[0] - previous[0]) * portion, previous[1] + (next[1] - previous[1]) * portion];
    return { point, path: pathD([...leg.points.slice(0, pointIndex), point]) };
  }

  function drawEndpointLabels(leg, index) {
    const group = $("endpoint-labels");
    group.innerHTML = "";
    const endpoints = [
      { id: leg.from_node_id, point: projectedLegs[index].points[0], color: palette.checked, label: "FROM" },
      { id: leg.to_node_id, point: projectedLegs[index].points.at(-1), color: palette.amber, label: "TO" }
    ];
    endpoints.forEach((endpoint, order) => {
      if (!endpoint.point) return;
      const node = nodeById.get(endpoint.id);
      const physicalPoint = node ? projection(node.coordinates) : endpoint.point;
      const gap = Math.hypot(physicalPoint[0] - endpoint.point[0], physicalPoint[1] - endpoint.point[1]);
      if (gap > 3) group.append(svgElement("path", { d: pathD([physicalPoint, endpoint.point]), fill: "none", stroke: endpoint.color, "stroke-width": 1, "stroke-dasharray": "3 4", opacity: .4 }));
      const nodeMarker = svgElement("circle", { cx: physicalPoint[0], cy: physicalPoint[1], r: node?.node_type?.includes("substation") ? 4 : 3, fill: "#10232a", stroke: endpoint.color, "stroke-width": 1.5 });
      const title = svgElement("title");
      title.textContent = `${endpoint.label}: ${endpoint.id}`;
      nodeMarker.append(title);
      group.append(nodeMarker);
      const labelWidth = endpoint.id.length * 6.6 + 18;
      const x = clamp(physicalPoint[0] - labelWidth / 2, 6, 854 - labelWidth);
      const y = clamp(physicalPoint[1] + (order ? 15 : -34), 5, 505);
      const label = svgElement("g", { transform: `translate(${x},${y})` });
      label.innerHTML = `<rect width="${labelWidth}" height="22" rx="3" fill="#10232b" opacity=".96" stroke="#3d5660" stroke-width=".6"/><text x="9" y="14.5" fill="${endpoint.color}" font-size="10">${esc(endpoint.id)}</text>`;
      group.append(label);
    });
  }

  function renderView() {
    const coverage = state.view === "coverage";
    $("view-route").classList.toggle("active", !coverage);
    $("view-route").setAttribute("aria-pressed", String(!coverage));
    $("view-coverage").classList.toggle("active", coverage);
    $("view-coverage").setAttribute("aria-pressed", String(coverage));
    $("route-legend").hidden = coverage;
    $("coverage-legend").hidden = !coverage;
    $("map-caption").textContent = coverage ? "OFFICIAL NETWORK · REPORTED COVERAGE" : `OFFICIAL NETWORK · ${routeLineIds.size} ROUTE LINES`;
    for (const path of $("network-lines").children) {
      const line = geometryById.get(path.dataset.lineId);
      path.setAttribute("stroke", coverage ? (palette[line.coverage] || palette.unspecified) : "#48606c");
      path.setAttribute("stroke-width", coverage ? 2.6 : 1.7);
      path.setAttribute("opacity", coverage ? .85 : .57);
      if (coverage && line.coverage === "unspecified") path.setAttribute("stroke-dasharray", "5 4");
      else path.removeAttribute("stroke-dasharray");
    }
    ["planned-route", "travelled-route", "active-leg-base", "active-leg-progress", "endpoint-labels", "route-position"].forEach(id => {
      $(id).style.display = coverage ? "none" : "";
    });
    const line = state.selectedLine ? geometryById.get(state.selectedLine) : null;
    const selectedPath = line ? pathD(validPoints(line.coordinates).map(projection)) : "";
    $("selected-line-halo").setAttribute("d", selectedPath);
    $("selected-line-path").setAttribute("d", selectedPath);
    $("zoom-route").classList.toggle("active", state.framing === "route");
    $("zoom-network").classList.toggle("active", state.framing === "network");
  }

  function render() {
    const completed = Math.min(Math.floor(state.position), legCount);
    const index = Math.min(completed, legCount - 1);
    const fraction = state.position >= legCount ? 1 : state.position - index;
    const leg = legs[index];
    const travelled = state.position >= legCount ? distance : completedDistances[index] + leg.distance_km * fraction;
    const progress = travelled / distance;
    const done = state.position >= legCount;

    if (lastRenderedLeg !== index) {
      $("leg-title").innerHTML = `Leg ${String(index + 1).padStart(2, "0")}<span> / ${legCount}</span>`;
      $("leg-line").textContent = leg.line_id;
      $("leg-from").textContent = leg.from_node_id;
      $("leg-to").textContent = leg.to_node_id;
      $("leg-distance").innerHTML = `${number(leg.distance_km)} <small>km</small>`;
      $("active-leg-base").setAttribute("d", projectedLegs[index].path);
      drawEndpointLabels(leg, index);
      document.querySelectorAll(".leg-row").forEach((row, rowIndex) => row.classList.toggle("active", rowIndex === index));
      $("replay-announcement").textContent = `Leg ${index + 1} of ${legCount}, ${leg.line_id}, from ${leg.from_node_id} to ${leg.to_node_id}.`;
      lastRenderedLeg = index;
    }
    if (lastCompleted !== completed) {
      $("travelled-route").setAttribute("d", projectedLegs.slice(0, Math.min(completed, legCount - 1)).map(item => item.path).join(" "));
      document.querySelectorAll(".leg-row").forEach((row, rowIndex) => row.classList.toggle("completed", rowIndex < completed));
      lastCompleted = completed;
    }
    const position = positionOnLeg(index, fraction);
    $("active-leg-progress").setAttribute("d", position.path);
    $("route-position").setAttribute("transform", `translate(${position.point[0]},${position.point[1]})`);
    $("position-label").setAttribute("transform", position.point[0] > 710 ? "translate(-132,0)" : "translate(0,0)");
    $("distance-travelled").innerHTML = `${number(travelled)} <small>km</small>`;
    $("route-percent").textContent = `${Math.round(progress * 100)}%`;
    $("route-progress-fill").style.width = `${progress * 100}%`;
    $("completed-legs").textContent = `${completed} of ${legCount} legs complete`;
    $("distance-remaining").textContent = done ? "Journey complete" : `${number(Math.max(0, distance - travelled))} km to go`;
    $("leg-kicker").textContent = done ? "JOURNEY COMPLETE" : state.position === 0 ? "READY TO EXPLORE" : "ON THE ROUTE";
    $("timeline-position").textContent = done ? "Route complete" : state.position === 0 ? "Start" : `Leg ${index + 1} / ${legCount}`;
    $("map-position-label").textContent = state.view === "coverage" ? `${data.geometry.length} network lines` : done ? "Journey complete" : state.position === 0 ? "At the start" : `Leg ${index + 1} / ${legCount}`;
    const nextLeg = legs[index + 1];
    $("next-leg").innerHTML = done ? `Finish at <strong>${esc(data.end_node_id)}</strong>` : nextLeg ? `${esc(nextLeg.line_id)} <span>${esc(nextLeg.from_node_id)} → ${esc(nextLeg.to_node_id)}</span>` : `Final stop <span>${esc(data.end_node_id)}</span>`;
    $("route-scrubber").value = state.position;
    $("route-scrubber").setAttribute("aria-valuetext", done ? `Route complete, ${number(distance)} kilometres travelled` : `Leg ${index + 1} of ${legCount}, ${number(travelled)} kilometres travelled`);
    $("route-previous").disabled = state.position <= 0;
    $("route-next").disabled = done;
    $("route-status").textContent = done ? "Complete" : state.playing ? "Playing" : "Paused";
    $("route-status").className = `status-chip${done ? " complete" : state.playing ? " playing" : ""}`;
    $("route-play").innerHTML = state.playing ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4h3v12H5zm7 0h3v12h-3z"/></svg><span>Pause</span>' : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5 16 10 6 16.5Z"/></svg><span>Play</span>';
    $("route-play").setAttribute("aria-label", state.playing ? "Pause route" : done ? "Replay route" : "Play route");
  }

  function seek(position, pausePlayback = true) {
    const parsed = Number(position);
    if (!Number.isFinite(parsed)) return;
    if (pausePlayback) pause();
    if (state.view !== "route") setView("route");
    state.position = clamp(parsed, 0, legCount);
    lastTimestamp = null;
    render();
  }

  function play() {
    if (state.playing) return;
    if (state.view !== "route") setView("route");
    if (state.position >= legCount) state.position = 0;
    state.playing = true;
    lastTimestamp = null;
    render();
    frameRequest = requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    lastTimestamp = null;
    if (frameRequest !== null) cancelAnimationFrame(frameRequest);
    frameRequest = null;
    render();
  }

  function tick(timestamp) {
    if (!state.playing) return;
    if (lastTimestamp !== null) {
      const elapsed = Math.min((timestamp - lastTimestamp) / 1000, .15) * state.speed;
      const index = Math.min(Math.floor(state.position), legCount - 1);
      let replayTime = cumulativeDurations[index] + durations[index] * (state.position - index) + elapsed;
      if (replayTime >= totalDuration) {
        state.position = legCount;
        pause();
        $("replay-announcement").textContent = `Journey complete. ${legCount} legs and ${number(distance)} kilometres.`;
        return;
      }
      let nextIndex = index;
      while (nextIndex < legCount - 1 && replayTime >= cumulativeDurations[nextIndex + 1]) nextIndex++;
      state.position = nextIndex + (replayTime - cumulativeDurations[nextIndex]) / durations[nextIndex];
    }
    lastTimestamp = timestamp;
    render();
    frameRequest = requestAnimationFrame(tick);
  }

  function setView(view) {
    state.view = view;
    if (view === "coverage") pause();
    else {
      state.selectedLine = null;
      $("coverage-selection").textContent = "Select a line to locate it on the map.";
      renderCoverage();
    }
    if (view === "coverage" && state.framing !== "network") {
      state.framing = "network";
      buildMap();
    } else {
      renderView();
      render();
    }
  }

  function renderCoverage() {
    const lines = data.geometry.filter(line => line.coverage === state.coverage).sort((a, b) => a.line_id.localeCompare(b.line_id));
    $("coverage-lines").innerHTML = lines.map(line => `<button class="coverage-line ${esc(state.coverage)}${state.selectedLine === line.line_id ? " selected" : ""}" data-line-id="${esc(line.line_id)}" aria-pressed="${state.selectedLine === line.line_id}">${esc(line.line_id)}</button>`).join("");
    document.querySelectorAll("[data-coverage]").forEach(button => {
      button.classList.toggle("active", button.dataset.coverage === state.coverage);
      button.setAttribute("aria-pressed", String(button.dataset.coverage === state.coverage));
    });
    postHeight();
  }

  function selectLine(id) {
    state.selectedLine = id;
    if (state.framing !== "network") {
      state.framing = "network";
      buildMap();
    }
    setView("coverage");
    const line = geometryById.get(id);
    const check = checkedById.get(id);
    const status = line.coverage === "checked" ? "Checked" : line.coverage === "unchecked" ? "Unchecked" : "Unreported";
    $("coverage-selection").innerHTML = `<strong>${esc(id)}</strong> · ${status}${check ? ` at ${esc(check.checked_at_node)}` : ""}`;
    renderCoverage();
  }

  $("journey-start").textContent = data.start_node_id;
  $("journey-end").textContent = data.end_node_id;
  $("stat-distance").textContent = number(distance);
  $("stat-legs").textContent = legCount;
  $("stat-checked").textContent = data.summary.checked_count;
  $("stat-unchecked").textContent = data.summary.unchecked_count;
  $("stat-unspecified").textContent = data.summary.unspecified_count;
  $("itinerary-count").textContent = legCount;
  $("timeline-end").textContent = `${legCount} legs · ${number(distance)} km`;
  $("route-scrubber").max = legCount;
  $("coverage-total").textContent = `${data.summary.checked_count} / ${data.geometry.length} lines checked`;
  ["checked", "unchecked", "unspecified"].forEach(coverage => {
    $("filter-" + coverage + "-count").textContent = data.summary[coverage + "_count"];
    const span = document.createElement("span");
    span.className = coverage;
    span.style.width = `${100 * data.summary[coverage + "_count"] / data.geometry.length}%`;
    $("coverage-bar").append(span);
  });
  $("leg-table-body").innerHTML = legs.map((leg, index) => `<tr class="leg-row" data-leg="${index}"><td><button class="leg-jump" data-leg="${index}" aria-label="Jump to leg ${index + 1}: ${esc(leg.line_id)}"><span class="leg-index">${String(index + 1).padStart(2, "0")}</span>${esc(leg.line_id)}</button></td><td>${esc(leg.from_node_id)}<span class="leg-arrow">→</span>${esc(leg.to_node_id)}</td><td class="numeric">${number(leg.distance_km)}</td></tr>`).join("");

  $("route-play").addEventListener("click", () => state.playing ? pause() : play());
  $("route-previous").addEventListener("click", () => seek(Math.ceil(state.position) - 1));
  $("route-next").addEventListener("click", () => seek(Math.floor(state.position) + 1));
  $("route-restart").addEventListener("click", () => seek(0));
  $("route-scrubber").addEventListener("input", event => seek(event.target.value));
  $("route-speed").addEventListener("change", event => { state.speed = Number(event.target.value); });
  $("view-route").addEventListener("click", () => setView("route"));
  $("view-coverage").addEventListener("click", () => setView("coverage"));
  $("zoom-route").addEventListener("click", () => { state.framing = "route"; buildMap(); });
  $("zoom-network").addEventListener("click", () => { state.framing = "network"; buildMap(); });
  $("leg-table-body").addEventListener("click", event => {
    const button = event.target.closest("button[data-leg]");
    if (!button) return;
    state.selectedLine = null;
    setView("route");
    seek(Number(button.dataset.leg));
    renderView();
  });
  document.querySelectorAll("[data-coverage]").forEach(button => button.addEventListener("click", () => {
    state.coverage = button.dataset.coverage;
    state.selectedLine = null;
    $("coverage-selection").textContent = "Select a line to locate it on the map.";
    setView("coverage");
    renderCoverage();
  }));
  $("coverage-lines").addEventListener("click", event => {
    const button = event.target.closest("button[data-line-id]");
    if (button) selectLine(button.dataset.lineId);
  });
  $("leg-details").addEventListener("toggle", postHeight);
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  window.addEventListener("message", event => {
    if (event.source === window.parent && event.data?.type === "gridscout:pause-route") pause();
  });
  window.addEventListener("resize", postHeight);
  window.GridScoutSchedule = Object.freeze({
    seek,
    play,
    pause,
    getState: () => {
      const index = Math.min(Math.floor(state.position), legCount - 1);
      const fraction = state.position >= legCount ? 1 : state.position - index;
      return { ...state, legIndex: index, fraction, completedLegs: Math.floor(state.position), distanceKm: state.position >= legCount ? distance : completedDistances[index] + legs[index].distance_km * fraction, legCount, totalDistanceKm: distance };
    }
  });
  $("route-content").hidden = false;
  buildMap();
  renderCoverage();
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(postHeight);
    resizeObserver.observe(document.body);
  }
  requestAnimationFrame(postHeight);
})();
