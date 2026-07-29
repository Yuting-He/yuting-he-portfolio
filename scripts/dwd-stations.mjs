export const DWD_STATION_URLS = Object.freeze({
  stationList: "https://opendata.dwd.de/weather/weather_reports/stationlist_synoptic_germany.csv",
  poiIndex: "https://opendata.dwd.de/weather/weather_reports/poi/"
});

const POI_BASE_URL = "https://opendata.dwd.de/weather/weather_reports/poi";
const NETWORK_SIZE = 160;
export const DWD_STATION_MAX_AGE_HOURS = 8;
const finite = (value) => Number.isFinite(value);
const round = (value, digits = 1) => Number(value.toFixed(digits));

function decimal(value) {
  const number = Number(String(value).replace(",", "."));
  return finite(number) ? number : null;
}

function parseDateTime(date, time) {
  const match = /^(\d{2})\.(\d{2})\.(\d{2});?$/u.exec(date);
  if (!match || !/^\d{2}:\d{2}$/.test(time)) return null;
  return new Date(Date.UTC(2000 + Number(match[3]), Number(match[2]) - 1, Number(match[1]), ...time.split(":").map(Number))).toISOString();
}

function berlinIsoDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function previousIsoDate(date) {
  return new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export function isCurrentStationObservation(timestamp, now = Date.now()) {
  const ageHours = (now - Date.parse(timestamp)) / 3_600_000;
  return finite(ageHours) && ageHours >= -2 && ageHours <= DWD_STATION_MAX_AGE_HOURS;
}

export function parseStationList(text, availableIds) {
  const rows = text.trim().split(/\r?\n/).map((row) => row.split(";"));
  const header = rows.shift();
  const column = (name) => header.indexOf(name);
  return rows.flatMap((row) => {
    const id = row[column("Kennung")];
    const latitude = decimal(row[column("Geog_Breite")]);
    const longitude = decimal(row[column("Geog_Laenge")]);
    const name = row[column("Stationsname")];
    if (!availableIds.has(id) || !finite(latitude) || !finite(longitude)) return [];
    if (latitude < 47 || latitude > 55.2 || longitude < 5.4 || longitude > 15.8) return [];
    if (/^UFS\b|Feuerschiff|Schiff/i.test(name)) return [];
    return [{ id, name, latitude, longitude }];
  });
}

export function parsePoiIndex(text) {
  return new Set([...text.matchAll(/(\d{5})-BEOB\.csv/g)].map((match) => match[1]));
}

export function haversineKm(left, right) {
  const radians = Math.PI / 180;
  const latitude1 = left.latitude * radians;
  const latitude2 = right.latitude * radians;
  const deltaLatitude = (right.latitude - left.latitude) * radians;
  const deltaLongitude = (right.longitude - left.longitude) * radians;
  const value = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function selectStationNetwork(stations, size = NETWORK_SIZE) {
  if (stations.length <= size) return stations;
  const center = { latitude: 51.2, longitude: 10.5 };
  const selected = [stations.reduce((best, station) =>
    haversineKm(station, center) < haversineKm(best, center) ? station : best
  )];
  const selectedIds = new Set(selected.map((station) => station.id));
  while (selected.length < size) {
    const candidate = stations
      .filter((station) => !selectedIds.has(station.id))
      .map((station) => ({
        station,
        distance: Math.min(...selected.map((item) => haversineKm(station, item)))
      }))
      .sort((left, right) => right.distance - left.distance)[0]?.station;
    if (!candidate) break;
    selected.push(candidate);
    selectedIds.add(candidate.id);
  }
  return selected;
}

export function parsePoiObservation(text) {
  const rows = text.trim().split(/\r?\n/).map((row) => row.split(";"));
  if (rows.length < 4) throw new Error("DWD POI response has no observations");
  const header = rows[0];
  const temperatureIndex = header.indexOf("dry_bulb_temperature_at_2_meter_above_ground");
  const previousMaxIndex = header.indexOf("maximum_of_temperature_for_previous_day");
  if (temperatureIndex < 0 || previousMaxIndex < 0) throw new Error("DWD POI temperature columns unavailable");
  const observations = rows.slice(3).flatMap((row) => {
    const timestamp = parseDateTime(row[0], row[1]);
    if (!timestamp) return [];
    return [{
      timestamp,
      temperatureC: decimal(row[temperatureIndex]),
      previousDayMaxC: decimal(row[previousMaxIndex])
    }];
  }).sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  const latest = observations.find((item) => finite(item.temperatureC));
  const previousMaximum = observations.find((item) => finite(item.previousDayMaxC));
  if (!latest) throw new Error("DWD POI response has no current temperature");
  const latestDate = berlinIsoDate(latest.timestamp);
  const currentValues = observations
    .filter((item) => berlinIsoDate(item.timestamp) === latestDate && finite(item.temperatureC))
    .map((item) => item.temperatureC);
  return {
    observedAt: latest.timestamp,
    latestTemperatureC: round(latest.temperatureC, 1),
    currentDay: {
      date: latestDate,
      maximumSoFarC: round(Math.max(...currentValues), 1)
    },
    previousDay: previousMaximum ? {
      date: previousIsoDate(berlinIsoDate(previousMaximum.timestamp)),
      maximumC: round(previousMaximum.previousDayMaxC, 1)
    } : null
  };
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

export async function fetchDwdTemperatureContext(locations, fetchWithRetry) {
  const [stationResponse, indexResponse] = await Promise.all([
    fetchWithRetry(DWD_STATION_URLS.stationList),
    fetchWithRetry(DWD_STATION_URLS.poiIndex)
  ]);
  const [stationBytes, indexText] = await Promise.all([stationResponse.arrayBuffer(), indexResponse.text()]);
  const stationText = new TextDecoder("utf-8").decode(stationBytes);
  const stations = selectStationNetwork(parseStationList(stationText, parsePoiIndex(indexText)));
  const observations = await mapLimit(stations, 8, async (station) => {
    try {
      const response = await fetchWithRetry(`${POI_BASE_URL}/${station.id}-BEOB.csv`, 3);
      const bytes = await response.arrayBuffer();
      return { ...station, ...parsePoiObservation(new TextDecoder("iso-8859-1").decode(bytes)) };
    } catch {
      return null;
    }
  });
  const observationTime = Date.now();
  const available = observations
    .filter(Boolean)
    .filter((station) => isCurrentStationObservation(station.observedAt, observationTime));
  if (available.length < Math.min(80, stations.length)) {
    throw new Error(`Only ${available.length} DWD stations returned current observations`);
  }
  const basins = new Map();
  for (const location of locations) {
    const station = available.reduce((nearest, candidate) =>
      haversineKm(location, candidate) < haversineKm(location, nearest) ? candidate : nearest
    );
    basins.set(location.id, {
      dwdStationId: station.id,
      dwdStationName: station.name,
      dwdStationDistanceKm: round(haversineKm(location, station), 1),
      dwdObservedAt: station.observedAt,
      dwdLatestTemperatureC: station.latestTemperatureC,
      dwdCurrentDayDate: station.currentDay.date,
      dwdCurrentDayMaxSoFarC: station.currentDay.maximumSoFarC,
      dwdPreviousDayDate: station.previousDay?.date || null,
      dwdPreviousDayMaxC: station.previousDay?.maximumC ?? null
    });
  }
  return {
    status: "available",
    observedAt: available.map((station) => station.observedAt).sort().at(-1),
    stationCount: available.length,
    requestedStationCount: stations.length,
    basins
  };
}
