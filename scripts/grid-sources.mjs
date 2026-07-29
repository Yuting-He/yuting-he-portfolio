import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import proj4 from "proj4";

export const GRID_SOURCE_URLS = Object.freeze({
  radolan: "https://opendata.dwd.de/weather/radar/radolan/sf/raa01-sf_10000-latest-dwd---bin.hdf5",
  ufzTopsoil: "https://files.ufz.de/~drought/SM_L02_daily_n14.nc",
  ufzTotal: "https://files.ufz.de/~drought/SM_Lall_daily_n14.nc",
  ufzPlantAvailable: "https://files.ufz.de/~drought/nFK_0_25_daily_n14.nc",
  dwdSoilDescribe: "https://cdc.dwd.de/geoserver/CDC/wcs?service=WCS&version=2.0.1&request=DescribeCoverage&coverageId=CDC__GRD_DEU_P1D_BF-KOM",
  dwdSoilWcs: "https://cdc.dwd.de/geoserver/CDC/wcs"
});

export const DWD_SOIL_COVERAGES = Object.freeze({
  dominant: "GRD_DEU_P1D_BF-KOM",
  grass: "GRD_DEU_P1D_BF-GRB",
  maize: "GRD_DEU_P1D_BF-MRB",
  winterWheat: "GRD_DEU_P1D_BF-WRB"
});

const round = (value, digits = 1) => Number(value.toFixed(digits));
const finite = (value) => Number.isFinite(value);

export function isValidDwdSoilRawValue(value, fillValue) {
  return finite(value) && value !== fillValue;
}

proj4.defs(
  "EPSG:31467",
  "+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel " +
  "+towgs84=612.4,77,440.2,-0.054,0.057,-2.797,2.55 +units=m +no_defs"
);
proj4.defs(
  "EPSG:31468",
  "+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel " +
  "+towgs84=582,105,414,1.04,0.35,-3.08,8.3 +units=m +no_defs"
);

function attribute(object, key) {
  return object?.attrs?.[key]?.value;
}

function scalar(value) {
  if (ArrayBuffer.isView(value)) return value[0];
  return value;
}

function nearestIndex(values, target) {
  if (!values.length) return -1;
  const step = values.length > 1 ? values[1] - values[0] : 1;
  return Math.max(0, Math.min(values.length - 1, Math.round((target - values[0]) / step)));
}

export function nearestValidGridValue({
  data,
  width,
  height,
  xIndex,
  yIndex,
  isValid,
  maxRadius = 0,
  reverseY = false
}) {
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    let best = null;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (radius && Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = xIndex + dx;
        const y = yIndex + dy;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const row = reverseY ? height - 1 - y : y;
        const value = data[row * width + x];
        if (!isValid(value)) continue;
        const distanceCells = Math.hypot(dx, dy);
        if (!best || distanceCells < best.distanceCells) best = { value, distanceCells };
      }
    }
    if (best) return best;
  }
  return null;
}

export function temporalCoordinateToIso(value, units) {
  const match = /^(seconds|hours|days) since (.+)$/i.exec(String(units || "").trim());
  if (!match || !finite(Number(value))) throw new Error(`Unsupported temporal coordinate: ${units}`);
  const unitMs = { seconds: 1000, hours: 3_600_000, days: 86_400_000 }[match[1].toLowerCase()];
  const origin = Date.parse(`${match[2].replace(" ", "T").replace(/T$/, "")}${/[zZ]|[+-]\d\d:?\d\d$/.test(match[2]) ? "" : "Z"}`);
  if (!finite(origin)) throw new Error(`Invalid temporal origin: ${units}`);
  return new Date(origin + Number(value) * unitMs).toISOString();
}

function readUfzFile(path, variableName, locations, { maxRadius = 6 } = {}) {
  const file = new h5wasm.File(path, "r");
  try {
    const xValues = file.get("easting").value;
    const yValues = file.get("northing").value;
    const timeDataset = file.get("time");
    const times = timeDataset.value;
    const dataset = file.get(variableName);
    const values = dataset.value;
    const fillValue = Number(scalar(attribute(dataset, "_FillValue")));
    const timeIndex = times.length - 1;
    const sliceOffset = timeIndex * xValues.length * yValues.length;
    const latest = values.subarray(sliceOffset, sliceOffset + xValues.length * yValues.length);
    const validAt = temporalCoordinateToIso(times[timeIndex], attribute(timeDataset, "units"));
    const cellSizeM = Math.abs(xValues[1] - xValues[0]);
    const result = new Map();

    for (const location of locations) {
      const [x, y] = proj4("EPSG:4326", "EPSG:31468", [location.longitude, location.latitude]);
      const sample = nearestValidGridValue({
        data: latest,
        width: xValues.length,
        height: yValues.length,
        xIndex: nearestIndex(xValues, x),
        yIndex: nearestIndex(yValues, y),
        maxRadius,
        isValid: (value) => finite(value) && value !== fillValue && value > -9000
      });
      result.set(location.id, sample ? {
        value: sample.value,
        distanceKm: sample.distanceCells * cellSizeM / 1000
      } : null);
    }
    return { validAt, result, resolutionKm: cellSizeM / 1000 };
  } finally {
    file.close();
  }
}

export function readUfzContextFromFiles(paths, locations) {
  const topsoil = readUfzFile(paths.topsoil, "SMI", locations);
  const total = readUfzFile(paths.total, "SMI", locations);
  const plantAvailable = readUfzFile(paths.plantAvailable, "nFK", locations);
  const basins = new Map();

  for (const location of locations) {
    const top = topsoil.result.get(location.id);
    const all = total.result.get(location.id);
    const nfk = plantAvailable.result.get(location.id);
    basins.set(location.id, {
      ufzTopsoilSmi: top ? round(top.value, 3) : null,
      ufzTotalSmi: all ? round(all.value, 3) : null,
      ufzPlantAvailableWaterPct: nfk ? round(nfk.value, 1) : null,
      ufzCellDistanceKm: round(Math.max(top?.distanceKm || 0, all?.distanceKm || 0, nfk?.distanceKm || 0), 1)
    });
  }

  return {
    status: "available",
    validAt: [topsoil.validAt, total.validAt, plantAvailable.validAt].sort()[0],
    resolutionKm: topsoil.resolutionKm,
    basins
  };
}

function readDwdSoilFile(path, coverageName, locations, { maxRadius = 30 } = {}) {
  const file = new h5wasm.File(path, "r");
  try {
    const xValues = file.get("x").value;
    const yValues = file.get("y").value;
    const dataset = file.get(coverageName);
    const values = dataset.value;
    const depths = Array.from(file.get("elevation").value);
    const fillValue = Number(scalar(attribute(dataset, "_FillValue")));
    const cellSizeM = Math.abs(xValues[1] - xValues[0]);
    const planeSize = xValues.length * yValues.length;
    const result = new Map();

    for (const location of locations) {
      const [x, y] = proj4("EPSG:4326", "EPSG:31467", [location.longitude, location.latitude]);
      const xIndex = nearestIndex(xValues, x);
      const yIndex = nearestIndex(yValues, y);
      let sample = null;
      for (let radius = 0; radius <= maxRadius && !sample; radius += 1) {
        for (let dy = -radius; dy <= radius && !sample; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (radius && Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            if (Math.hypot(dx, dy) > maxRadius) continue;
            const column = xIndex + dx;
            const yCell = yIndex + dy;
            if (column < 0 || column >= xValues.length || yCell < 0 || yCell >= yValues.length) continue;
            const row = yValues.length - 1 - yCell;
            const profile = depths.map((depth, depthIndex) => ({
              depth,
              value: values[depthIndex * planeSize + row * xValues.length + column]
            }));
            if (profile.some((item) => !isValidDwdSoilRawValue(item.value, fillValue))) {
              continue;
            }
            const meanToDepth = (maximumDepth) => {
              const selected = profile.filter((item) => item.depth <= maximumDepth);
              return selected.reduce((sum, item) => sum + item.value, 0) / selected.length / 10;
            };
            sample = {
              values: {
                30: meanToDepth(30),
                60: meanToDepth(60),
                90: meanToDepth(90)
              },
              distanceKm: Math.hypot(dx, dy) * cellSizeM / 1000
            };
            break;
          }
        }
      }
      result.set(location.id, sample);
    }
    return { result, resolutionKm: cellSizeM / 1000 };
  } finally {
    file.close();
  }
}

export function readDwdSoilContextFromFiles(paths, locations, validAt) {
  const grids = Object.fromEntries(Object.entries(DWD_SOIL_COVERAGES).map(([key, coverage]) => [
    key,
    readDwdSoilFile(paths[key], coverage, locations)
  ]));
  const basins = new Map();
  for (const location of locations) {
    const samples = Object.fromEntries(Object.entries(grids).map(([key, grid]) => [key, grid.result.get(location.id)]));
    const fields = {};
    for (const [key, sample] of Object.entries(samples)) {
      const title = key === "winterWheat" ? "WinterWheat" : `${key[0].toUpperCase()}${key.slice(1)}`;
      for (const depth of [30, 60, 90]) {
        fields[`dwdNfk${title}${depth}Pct`] = sample ? round(sample.values[depth], 1) : null;
      }
      fields[`dwdNfk${title}Pct`] = sample ? round(sample.values[60], 1) : null;
    }
    basins.set(location.id, {
      ...fields,
      dwdSoilCellDistanceKm: round(Math.max(...Object.values(samples).map((sample) => sample?.distanceKm || 0)), 1)
    });
  }
  return {
    status: "available",
    validAt,
    rootZoneDepthsCm: [30, 60, 90],
    resolutionKm: grids.dominant.resolutionKm,
    basins
  };
}

function radolanTimestamp(date, time) {
  const value = `${date}${time}`;
  if (!/^\d{14}$/.test(value)) throw new Error(`Invalid RADOLAN timestamp: ${value}`);
  return new Date(Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12)),
    Number(value.slice(12, 14))
  )).toISOString();
}

export function readRadolanContextFromFile(path, locations) {
  const file = new h5wasm.File(path, "r");
  try {
    const conventions = String(scalar(attribute(file, "Conventions")));
    const data = file.get("dataset1/data1/data");
    const values = data.value;
    const dataWhat = file.get("dataset1/data1/what");
    const productWhat = file.get("dataset1/what");
    const where = file.get("where");
    const gain = Number(attribute(dataWhat, "gain"));
    const offset = Number(attribute(dataWhat, "offset"));
    const nodata = Number(attribute(dataWhat, "nodata"));
    const projection = String(attribute(where, "projdef"));
    const xscale = Number(attribute(where, "xscale"));
    const yscale = Number(attribute(where, "yscale"));
    const upperLeft = [
      Number(attribute(where, "UL_lon")),
      Number(attribute(where, "UL_lat"))
    ];
    const [upperLeftX, upperLeftY] = proj4("EPSG:4326", projection, upperLeft);
    const [height, width] = data.shape;
    if (!conventions.includes("ODIM_H5") ||
        String(attribute(productWhat, "prodname")) !== "SF" ||
        String(attribute(dataWhat, "quantity")) !== "ACRR" ||
        width !== Number(attribute(where, "xsize")) ||
        height !== Number(attribute(where, "ysize"))) {
      throw new Error("Unexpected RADOLAN SF HDF5 structure");
    }
    const basins = new Map();

    for (const location of locations) {
      const [x, y] = proj4("EPSG:4326", projection, [location.longitude, location.latitude]);
      const col = Math.floor((x - upperLeftX) / xscale);
      const row = Math.floor((upperLeftY - y) / yscale);
      const inBounds = col >= 0 && col < width && row >= 0 && row < height;
      const raw = inBounds ? values[row * width + col] : nodata;
      basins.set(location.id, {
        radolanPrecipitation24hMm: raw === nodata ? null : round(raw * gain + offset, 1)
      });
    }

    return {
      status: "available",
      periodStart: radolanTimestamp(attribute(productWhat, "startdate"), attribute(productWhat, "starttime")),
      periodEnd: radolanTimestamp(attribute(productWhat, "enddate"), attribute(productWhat, "endtime")),
      resolutionKm: xscale / 1000,
      basins
    };
  } finally {
    file.close();
  }
}

async function downloadTo(responsePromise, path) {
  const response = await responsePromise;
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

function dwdCoverageUrl(coverageName, validAt) {
  const url = new URL(GRID_SOURCE_URLS.dwdSoilWcs);
  url.searchParams.set("service", "WCS");
  url.searchParams.set("version", "2.0.1");
  url.searchParams.set("request", "GetCoverage");
  url.searchParams.set("coverageId", `CDC__${coverageName}`);
  url.searchParams.set("format", "application/x-netcdf4");
  url.searchParams.append("subset", `time("${validAt}")`);
  url.searchParams.append("subset", "elevation(10,90)");
  return url;
}

export async function fetchGridContexts(locations, fetchWithRetry) {
  await h5wasm.ready;
  const directory = await mkdtemp(join(tmpdir(), "heatlens-grids-"));
  try {
    const ufzPaths = {
      topsoil: join(directory, "ufz-topsoil.nc"),
      total: join(directory, "ufz-total.nc"),
      plantAvailable: join(directory, "ufz-nfk.nc")
    };
    const radolanPath = join(directory, "radolan.hdf5");
    const descriptionResponse = await fetchWithRetry(GRID_SOURCE_URLS.dwdSoilDescribe);
    const description = await descriptionResponse.text();
    const endPosition = [...description.matchAll(/<gml:endPosition>([^<]+)<\/gml:endPosition>/g)].at(-1)?.[1];
    if (!endPosition) throw new Error("DWD soil coverage has no current end position");
    const dwdValidAt = new Date(endPosition).toISOString();
    const dwdPaths = Object.fromEntries(Object.keys(DWD_SOIL_COVERAGES).map((key) => [key, join(directory, `dwd-${key}.nc`)]));

    await Promise.all([
      downloadTo(fetchWithRetry(GRID_SOURCE_URLS.ufzTopsoil), ufzPaths.topsoil),
      downloadTo(fetchWithRetry(GRID_SOURCE_URLS.ufzTotal), ufzPaths.total),
      downloadTo(fetchWithRetry(GRID_SOURCE_URLS.ufzPlantAvailable), ufzPaths.plantAvailable),
      downloadTo(fetchWithRetry(GRID_SOURCE_URLS.radolan), radolanPath),
      ...Object.entries(DWD_SOIL_COVERAGES).map(([key, coverage]) =>
        downloadTo(fetchWithRetry(dwdCoverageUrl(coverage, dwdValidAt)), dwdPaths[key])
      )
    ]);

    return {
      ufz: readUfzContextFromFiles(ufzPaths, locations),
      dwdSoil: readDwdSoilContextFromFiles(dwdPaths, locations, dwdValidAt),
      radolan: readRadolanContextFromFile(radolanPath, locations)
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
