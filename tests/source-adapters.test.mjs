import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import {
  isValidDwdSoilRawValue,
  nearestValidGridValue,
  temporalCoordinateToIso,
  readUfzContextFromFiles,
  readUfzFile
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

test("UFZ v2 reads geographic grids with descending latitude, latest time and PAW above 100 percent", async () => {
  await h5wasm.ready;
  const directory = await mkdtemp(join(tmpdir(), "heatlens-ufz-test-"));
  const paths = Object.fromEntries(["topsoil", "total", "plantAvailable"].map(key => [key, join(directory, `${key}.nc`)]));
  try {
    for (const [key, path] of Object.entries(paths)) {
      const file = new h5wasm.File(path, "w");
      try {
        file.create_attribute("gdm_version", "2.6.0");
        file.create_dataset({ name: "lon", data: [11, 11.015625] });
        file.create_dataset({ name: "lat", data: [48.015625, 48] });
        file.create_dataset({ name: "time", data: [2, 1] });
        file.get("time").create_attribute("units", "days since 2026-10-19 00:00:00");
        const variable = key === "plantAvailable" ? "PAW_0_25cm" : "SMI";
        const data = key === "plantAvailable" ? [118.5, 80, 50, -9999, 10, 10, 10, 10]
          : [0.6, 0.4, 0.2, -9999, 0.9, 0.9, 0.9, 0.9];
        file.create_dataset({ name: variable, data, shape: [2, 2, 2], dtype: "<d" });
        file.get(variable).create_attribute("_FillValue", -9999);
      } finally { file.close(); }
    }
    const context = readUfzContextFromFiles(paths, [
      { id: "north", longitude: 11, latitude: 48.015625 },
      { id: "south", longitude: 11, latitude: 48 }
    ]);
    assert.equal(context.validAt, "2026-10-21T00:00:00.000Z");
    assert.equal(context.grid, "EPSG:4326");
    assert.equal(context.basins.get("north").ufzTopsoilSmi, 0.6);
    assert.equal(context.basins.get("south").ufzTopsoilSmi, 0.2);
    assert.equal(context.basins.get("north").ufzPlantAvailableWaterPct, 118.5);
    assert.equal(context.basins.get("north").ufzCellDistanceKm, 0);
    const missing = readUfzFile(paths.topsoil, "SMI", [
      { id: "missing", longitude: 11.015625, latitude: 48 }
    ], { maxRadius: 0 });
    assert.equal(missing.result.get("missing"), null);
    const bounded = readUfzFile(paths.topsoil, "SMI", [
      { id: "outside", longitude: 11.015625, latitude: 48 }
    ], { maximumDistanceKm: 0.1 });
    assert.equal(bounded.result.get("outside"), null);
    const nearby = readUfzFile(paths.topsoil, "SMI", [
      { id: "nearby", longitude: 11.015625, latitude: 48 }
    ], { maximumDistanceKm: 2 });
    assert.equal(nearby.result.get("nearby").value, 0.2);
    assert.ok(nearby.result.get("nearby").distanceKm > 1 && nearby.result.get("nearby").distanceKm < 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
