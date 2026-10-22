import test from "node:test";
import assert from "node:assert/strict";
import {
  WARNING_MAXIMUM_AGE_HOURS,
  warningContextForState,
  warningFeedFreshness,
  warningPresentation
} from "../heatwave-warnings.js";

const now = Date.parse("2026-08-14T12:00:00Z");
const heat = {
  regionId: "109661000", regionName: "Stadt Aschaffenburg", event: "HEAT",
  level: 2, isHeat: true, isRain: false,
  start: "2026-08-14T08:00:00Z", end: "2026-08-14T17:00:00Z"
};
const rain = {
  regionId: "109162000", regionName: "Stadt München", event: "RAIN",
  level: 3, isHeat: false, isRain: true,
  start: "2026-08-14T10:00:00Z", end: "2026-08-14T19:00:00Z"
};
const feed = {
  status: "available", issuedAt: "2026-08-14T11:00:00Z",
  states: { DE2: { warnings: [heat, rain] } }
};
const options = { stateId: "DE2", unitLevel: "state", selectedDate: "2026-08-14", now };

test("warning freshness is independent of feed availability and expires after eight hours", () => {
  assert.equal(WARNING_MAXIMUM_AGE_HOURS, 8);
  assert.equal(warningFeedFreshness(feed, now).status, "fresh");
  const stale = warningFeedFreshness({ ...feed, issuedAt: "2026-08-14T03:59:59Z" }, now);
  assert.equal(stale.available, true);
  assert.equal(stale.current, false);
  assert.equal(stale.status, "stale");
  for (const issuedAt of [null, "invalid", "2026-08-14T13:00:00Z"]) {
    assert.equal(warningFeedFreshness({ ...feed, issuedAt }, now).status, "invalid-time");
  }
  assert.equal(warningFeedFreshness({ ...feed, status: "unavailable" }, now).current, false);
});

test("old snapshots retain dated warning evidence without triggering active warning advice", () => {
  const context = warningContextForState(feed, { ...options, now: Date.parse("2026-10-22T12:00:00Z") });
  assert.equal(context.heatWarnings.length, 1);
  assert.equal(context.dateKind, "past");
  assert.deepEqual(context.actionOptions, { heatWarningCount: 0, rainWarningCount: 0 });
  for (const language of ["en", "de"]) {
    const view = warningPresentation(context, { language, stateName: "Bayern" });
    assert.match(view.heading, language === "en" ? /Saved DWD warning context/ : /Gespeicherter DWD-Warnkontext/);
    assert.match(view.heat.detail, /2026/);
    assert.match(view.heat.detail, /Aschaffenburg/);
    assert.doesNotMatch(`${view.heading} ${view.heat.title}`, /current|active|aktuell|aktiv/i);
    assert.match(view.shared.join(" "), language === "en" ? /not live warning conditions/ : /keine aktuelle Warnlage/);
  }
});

test("districts and basins do not inherit unrelated warnings from their state", () => {
  for (const unitLevel of ["district", "basin"]) {
    const context = warningContextForState(feed, { ...options, unitLevel });
    assert.equal(context.geographicScope, "state");
    assert.equal(context.locallyMatched, false);
    assert.deepEqual(context.actionOptions, { heatWarningCount: 0, rainWarningCount: 0 });
    const view = warningPresentation(context, { stateName: "Bayern" });
    assert.match(view.shared.join(" "), /State context: Bayern/);
    assert.match(view.shared.join(" "), /may not cover the selected district or sub-basin/);
    assert.match(view.heat.detail, /Stadt Aschaffenburg/);
  }
});

test("state guidance only counts warnings active now for today's Berlin date", () => {
  assert.deepEqual(warningContextForState(feed, options).actionOptions, { heatWarningCount: 1, rainWarningCount: 1 });
  const futureFeed = { ...feed, states: { DE2: { warnings: [{ ...heat, start: "2026-08-14T13:00:00Z" }, { ...rain, end: "2026-08-14T11:00:00Z" }] } } };
  assert.deepEqual(warningContextForState(futureFeed, options).actionOptions, { heatWarningCount: 0, rainWarningCount: 0 });
  assert.deepEqual(warningContextForState(feed, { ...options, selectedDate: "2026-08-15" }).actionOptions, { heatWarningCount: 0, rainWarningCount: 0 });
  const tomorrowFeed = { ...feed, states: { DE2: { warnings: [{ ...heat, end: "2026-08-16T17:00:00Z" }] } } };
  const future = warningContextForState(tomorrowFeed, { ...options, selectedDate: "2026-08-15" });
  assert.equal(future.heatWarnings.length, 1);
  assert.equal(future.actionOptions.heatWarningCount, 0);
});

test("all affected areas and validity intervals remain visible, rather than only the first warning", () => {
  const context = warningContextForState({ ...feed, states: { DE2: { warnings: [heat, { ...heat, regionName: "Landkreis München" }, { ...heat, regionName: "Passau", end: "2026-08-14T20:00:00Z" }] } } }, options);
  const view = warningPresentation(context, { stateName: "Bayern" });
  assert.match(view.heat.title, /3 entries/);
  for (const region of ["Stadt Aschaffenburg", "Landkreis München", "Passau"]) assert.ok(view.heat.detail.includes(region));
  assert.match(view.heat.detail, /Valid .*2026.* to .*2026/);
  assert.equal((view.heat.detail.match(/HEAT:/g) || []).length, 2);
});

test("a fresh feed is not treated as a warning archive or an all-clear for unmatched dates", () => {
  const context = warningContextForState(feed, { ...options, selectedDate: "2026-08-13" });
  const view = warningPresentation(context, { stateName: "Bayern" });
  assert.match(view.heading, /retrospective/);
  assert.match(view.shared.join(" "), /Not a complete warning archive/);
  assert.match(view.heat.title, /No matching entries for this date/);
  assert.match(view.shared.join(" "), /not an all-clear/);
  assert.equal(view.heat.detail, "");
});

test("unavailable or malformed feeds fail closed and give an official-service fallback", () => {
  for (const source of [undefined, { status: "unavailable" }, { ...feed, issuedAt: null }]) {
    const context = warningContextForState(source, options);
    assert.deepEqual(context.actionOptions, { heatWarningCount: 0, rainWarningCount: 0 });
    const view = warningPresentation(context, { stateName: "Bayern" });
    assert.match(view.shared.join(" "), /Check DWD directly/);
  }
  const malformed = { ...feed, states: { DE2: { warnings: [{ ...heat, end: "2026-08-14T07:00:00Z" }, { ...heat, start: null }] } } };
  assert.equal(warningContextForState(malformed, options).heatWarnings.length, 0);
});

test("shared warning caveats appear once and hazard rows contain only their own evidence", () => {
  const context = warningContextForState(feed, options);
  for (const language of ["en", "de"]) {
    const view = warningPresentation(context, { language, stateName: "Bayern" });
    const shared = view.shared.join(" ");
    assert.match(shared, /2026/);
    assert.equal((shared.match(/Bayern/g) || []).length, 1);
    assert.match(shared, language === "en" ? /not an all-clear/ : /keine Entwarnung/);
    for (const row of [view.heat, view.rain]) {
      assert.doesNotMatch(row.title, /Heat:|Rain:|Hitze:|Regen:/);
      assert.doesNotMatch(row.detail, /Issued:|Ausgegeben:|State context|Bundeslandkontext|all-clear|Entwarnung/);
      assert.match(row.detail, language === "en" ? /Valid/ : /Gültig/);
    }
    assert.match(view.heat.detail, /Aschaffenburg/);
    assert.doesNotMatch(view.heat.detail, /München/);
    assert.match(view.rain.detail, /München/);
  }
});

test("today and warning validity use Berlin's date across midnight", () => {
  const night = Date.parse("2026-08-14T22:30:00Z");
  const nightFeed = { ...feed, issuedAt: "2026-08-14T22:00:00Z", states: { DE2: { warnings: [{ ...heat, start: "2026-08-14T22:00:00Z", end: "2026-08-15T01:00:00Z" }] } } };
  const context = warningContextForState(nightFeed, { ...options, selectedDate: "2026-08-15", now: night });
  assert.equal(context.dateKind, "today");
  assert.equal(context.actionOptions.heatWarningCount, 1);
});
