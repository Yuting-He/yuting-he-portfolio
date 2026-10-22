import { warningAppliesToDate } from "./heatwave-state.js";

// HeatLens refreshes every six hours. This is a display policy, not a DWD
// guarantee: an older feed must never be presented as live warning information.
export const WARNING_MAXIMUM_AGE_HOURS = 8;
const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60_000;

export function warningFeedFreshness(feed, now = Date.now()) {
  const issuedTime = Date.parse(feed?.issuedAt);
  const ageHours = (now - issuedTime) / 3_600_000;
  const available = feed?.status === "available";
  const validTime = Number.isFinite(issuedTime) && Number.isFinite(now) && issuedTime <= now + CLOCK_SKEW_ALLOWANCE_MS;
  const current = available && validTime && ageHours <= WARNING_MAXIMUM_AGE_HOURS;
  return {
    status: !available ? "unavailable" : !validTime ? "invalid-time" : current ? "fresh" : "stale",
    available,
    current,
    issuedAt: Number.isFinite(issuedTime) ? new Date(issuedTime).toISOString() : null,
    ageHours: Number.isFinite(ageHours) ? ageHours : null,
    maximumAgeHours: WARNING_MAXIMUM_AGE_HOURS
  };
}

function berlinDate(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function warningContextForState(feed, { stateId, unitLevel, selectedDate, now = Date.now() }) {
  const freshness = warningFeedFreshness(feed, now);
  const today = berlinDate(now);
  const sourceWarnings = freshness.available && Array.isArray(feed?.states?.[stateId]?.warnings)
    ? feed.states[stateId].warnings : [];
  const warnings = sourceWarnings.filter((warning) =>
    Date.parse(warning?.end) > Date.parse(warning?.start) && warningAppliesToDate(warning, selectedDate));
  const heatWarnings = warnings.filter((warning) => warning.isHeat);
  const rainWarnings = warnings.filter((warning) => warning.isRain);
  // State grouping proves only that a warning affects some part of the state.
  // District/basin guidance must not inherit warnings from unrelated places.
  // The existing action wording says "active", so future/expired intervals and
  // non-today views must not trigger it either.
  const mayInformActions = freshness.current && unitLevel === "state" && selectedDate === today;
  const activeCount = (entries) => mayInformActions
    ? entries.filter((warning) => Date.parse(warning.start) <= now && now < Date.parse(warning.end)).length : 0;
  return {
    freshness,
    stateId,
    unitLevel,
    selectedDate,
    dateKind: selectedDate < today ? "past" : selectedDate > today ? "future" : "today",
    geographicScope: "state",
    locallyMatched: false,
    heatWarnings,
    rainWarnings,
    actionOptions: { heatWarningCount: activeCount(heatWarnings), rainWarningCount: activeCount(rainWarnings) }
  };
}

function timestamp(value, language) {
  if (!Number.isFinite(Date.parse(value))) return language === "de" ? "unbekannt" : "unknown";
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short"
  }).format(new Date(value));
}

function warningGroups(entries, language) {
  const groups = new Map();
  for (const warning of entries) {
    const event = warning.event || (language === "de" ? "DWD-Warnung" : "DWD warning");
    const key = JSON.stringify([event, warning.start, warning.end, warning.level]);
    if (!groups.has(key)) groups.set(key, { event, start: warning.start, end: warning.end, regions: new Set() });
    const identifier = warning.warnCellId ?? warning.regionId;
    const region = warning.regionName || (identifier
      ? `${language === "de" ? "Warngebiet" : "Warning area"} ${identifier}`
      : language === "de" ? "Gebiet nicht angegeben" : "Area not specified");
    groups.get(key).regions.add(region);
  }
  return [...groups.values()].map((group) => language === "de"
    ? `${group.event}: ${[...group.regions].join(", ")}. Gültig ${timestamp(group.start, language)} bis ${timestamp(group.end, language)}.`
    : `${group.event}: ${[...group.regions].join(", ")}. Valid ${timestamp(group.start, language)} to ${timestamp(group.end, language)}.`).join(" ");
}

export function warningPresentation(context, { language = "en", stateName = context.stateId } = {}) {
  const de = language === "de";
  const { freshness } = context;
  const scope = de
    ? `Bundeslandkontext: ${stateName}. Warngebiete gelten nicht automatisch für ${context.unitLevel === "state" ? "das gesamte Bundesland" : "den ausgewählten Kreis oder das Teileinzugsgebiet"}.`
    : `State context: ${stateName}. Listed areas may not cover ${context.unitLevel === "state" ? "the whole state" : "the selected district or sub-basin"}.`;
  const issued = freshness.available || freshness.issuedAt
    ? de ? `Ausgegeben: ${timestamp(freshness.issuedAt, language)}.` : `Issued: ${timestamp(freshness.issuedAt, language)}.`
    : "";
  const status = freshness.status === "stale"
    ? de ? `Über ${WARNING_MAXIMUM_AGE_HOURS} Stunden alt: gespeicherte Angaben, keine aktuelle Warnlage.`
      : `Over ${WARNING_MAXIMUM_AGE_HOURS} hours old: saved entries, not live warning conditions.`
    : freshness.status === "invalid-time"
      ? de ? "Zeitstempel fehlt oder ist ungültig; Aktualität nicht bestätigt."
        : "Timestamp missing or invalid; freshness unverified."
      : !freshness.available
        ? de ? "DWD-Warnfeed nicht verfügbar." : "DWD warning feed unavailable."
        : context.dateKind === "past"
          ? de ? "Kein vollständiges Warnarchiv für das vergangene Datum."
            : "Not a complete warning archive for the selected past date."
          : de ? "Der Feed kann sich ändern; spätere Prognosetage sind möglicherweise nicht abgedeckt."
            : "The feed may change; later forecast dates may not be covered.";
  const next = de ? "Für die aktuelle örtliche Warnlage den DWD direkt prüfen. Fehlende Einträge sind keine Entwarnung."
    : "Check DWD directly for current local warnings. Missing entries are not an all-clear.";
  const heading = !freshness.available
    ? de ? "Amtlicher Warnfeed nicht verfügbar" : "Official warning feed unavailable"
    : !freshness.current
      ? de ? "Gespeicherter DWD-Warnkontext" : "Saved DWD warning context"
      : context.dateKind === "past"
        ? de ? "DWD-Warnfeed — rückblickende Ansicht" : "DWD warning feed — retrospective view"
        : de ? "DWD-Warnfeed — Bundeslandkontext" : "DWD warning feed — state context";
  const describe = (entries) => {
    const title = !freshness.available
      ? de ? "Nicht verfügbar" : "Unavailable"
      : entries.length
        ? de ? `${entries.length} ${entries.length === 1 ? "Eintrag" : "Einträge"} für das Datum`
          : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} for this date`
        : de ? "Keine passenden Einträge für das Datum" : "No matching entries for this date";
    const detail = freshness.available ? warningGroups(entries, language) : "";
    return { title, detail };
  };
  return {
    heading,
    shared: [issued, status, scope, next].filter(Boolean),
    heat: describe(context.heatWarnings),
    rain: describe(context.rainWarnings)
  };
}
