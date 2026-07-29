import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidDwdSoilRawValue,
  nearestValidGridValue,
  temporalCoordinateToIso
} from "../scripts/grid-sources.mjs";
import {
  isCurrentStationObservation,
  parsePoiIndex,
  parsePoiObservation,
  parseStationList,
  selectStationNetwork
} from "../scripts/dwd-stations.mjs";

test("HDF temporal coordinates and nearest valid cells preserve source meaning", () => {
  assert.equal(temporalCoordinateToIso(2, "days since 2026-07-27 00:00:00"), "2026-07-29T00:00:00.000Z");
  assert.equal(temporalCoordinateToIso(24, "hours since 2026-07-28"), "2026-07-29T00:00:00.000Z");
  const sample = nearestValidGridValue({
    data: new Int16Array([-9999, -9999, -9999, 42]),
    width: 2,
    height: 2,
    xIndex: 0,
    yIndex: 0,
    maxRadius: 1,
    isValid: (value) => value !== -9999
  });
  assert.deepEqual(sample, { value: 42, distanceCells: Math.SQRT2 });
  assert.equal(isValidDwdSoilRawValue(-50, -9999), true);
  assert.equal(isValidDwdSoilRawValue(2500, -9999), true);
  assert.equal(isValidDwdSoilRawValue(-9999, -9999), false);
});

test("DWD station discovery and POI observation parsing handle source encodings", () => {
  const available = parsePoiIndex('<a href="10865-BEOB.csv">10865-BEOB.csv</a>');
  const stations = parseStationList(
    "#ID;Kennung;Stationsname;Geog_Breite;Geog_Laenge\n1;10865;Muenchen-Stadt;48.16;11.54",
    available
  );
  assert.equal(stations.length, 1);
  assert.equal(selectStationNetwork(stations, 1)[0].id, "10865");

  const observation = parsePoiObservation([
    "surface observations;Parameter description;dry_bulb_temperature_at_2_meter_above_ground;maximum_of_temperature_for_previous_day",
    "10865;Unit;Grad C;Grad C",
    "Datum;Uhrzeit (UTC);Temperatur;Maximumtemperatur",
    "29.07.26;20:00;29,1;---",
    "29.07.26;06:00;19,8;29,7"
  ].join("\n"));
  assert.equal(observation.latestTemperatureC, 29.1);
  assert.deepEqual(observation.previousDay, { date: "2026-07-28", maximumC: 29.7 });
  assert.equal(observation.currentDay.maximumSoFarC, 29.1);

  const rollover = parsePoiObservation([
    "surface observations;Parameter description;dry_bulb_temperature_at_2_meter_above_ground;maximum_of_temperature_for_previous_day",
    "10865;Unit;Grad C;Grad C",
    "Datum;Uhrzeit (UTC);Temperatur;Maximumtemperatur",
    "29.07.26;23:00;22,0;---",
    "29.07.26;21:00;24,0;29,7"
  ].join("\n"));
  assert.equal(rollover.currentDay.date, "2026-07-30");
  assert.equal(rollover.currentDay.maximumSoFarC, 22);
  assert.deepEqual(rollover.previousDay, { date: "2026-07-28", maximumC: 29.7 });
  assert.equal(isCurrentStationObservation("2026-07-29T20:00:00Z", Date.parse("2026-07-30T02:00:00Z")), true);
  assert.equal(isCurrentStationObservation("2026-07-29T16:00:00Z", Date.parse("2026-07-30T02:00:01Z")), false);
});
