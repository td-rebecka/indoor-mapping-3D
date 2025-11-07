import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Map } from "react-map-gl/maplibre";
import DeckGL from "@deck.gl/react";
import { GeoJsonLayer, ScatterplotLayer, IconLayer } from "@deck.gl/layers";
import { Matrix4 } from "@math.gl/core";

// --- FIX för WebGL ResizeObserver-bugg ---
const _ResizeObserver = window.ResizeObserver;
window.ResizeObserver = class extends _ResizeObserver {
  constructor(callback) {
    super((entries, observer) => {
      try {
        callback(entries, observer);
      } catch {}
    });
  }
};

const UNITS_URL =
  "https://services-eu1.arcgis.com/3UOELksVE9tSHPLL/arcgis/rest/services/Units/FeatureServer/2/query?where=1%3D1&outFields=*&f=geojson";
const DETAILS_URL =
  "https://services-eu1.arcgis.com/3UOELksVE9tSHPLL/arcgis/rest/services/Details/FeatureServer/1/query?where=1%3D1&outFields=*&f=geojson";

const FLOOR_HEIGHT = 2.7;
const INITIAL_VIEW_STATE = {
  longitude: 17.9128075,
  latitude: 59.2890342,
  zoom: 19,
  pitch: 0,
  bearing: 0,
  maxZoom: 33,
};

const isBV = (f) =>
  ["BV", "ENTRÉ", "VÅN 1"].includes(
    String(f.properties?.LEVEL_ID || "").toUpperCase()
  );
const isOV = (f) =>
  ["ÖV", "OV", "VÅN 2", "2V"].includes(
    String(f.properties?.LEVEL_ID || "").toUpperCase()
  );

const color = (f) => {
  const l = String(f.properties?.LEVEL_ID || "").toUpperCase();
  if (l === "BV") return [255, 120, 120, 180];
  if (l === "ÖV" || l === "OV") return [255, 230, 100, 180];
  return [180, 255, 150, 160];
};

export default function App({
  mapStyle = "https://basemaps.cartocdn.com/gl/voyager-nolabels-gl-style/style.json",
}) {
  const [fontReady, setFontReady] = useState(false);
  const [data, setData] = useState({});
  const [gpsPos, setGpsPos] = useState(null);
  const [is3D, setIs3D] = useState(false);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [selected, setSelected] = useState(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [homeView, setHomeView] = useState(INITIAL_VIEW_STATE);
  const [baseAltitude, setBaseAltitude] = useState(null);
  const [avgAltitude, setAvgAltitude] = useState(null);
  const [currentLevel, setCurrentLevel] = useState("BV");

  const [visibleLayers, setVisibleLayers] = useState({
    bottenvaning: { active: true, unitsBV: true, detailsBV: true },
    overvaning: { active: true, unitsOV: true, detailsOV: true },
  });

  useEffect(() => {
    const disableRightClick = (e) => e.preventDefault();
    window.addEventListener("contextmenu", disableRightClick);
    return () => window.removeEventListener("contextmenu", disableRightClick);
  }, []);

  // --- Ladda GeoJSON ---
  useEffect(() => {
    (async () => {
      const [r1, r2] = await Promise.all([
        fetch(UNITS_URL),
        fetch(DETAILS_URL),
      ]);
      const u = await r1.json();
      const d = await r2.json();

      setData({
        unitsBV: {
          type: "FeatureCollection",
          features: u.features.filter(isBV),
        },
        unitsOV: {
          type: "FeatureCollection",
          features: u.features.filter(isOV),
        },
        detailsBV: {
          type: "FeatureCollection",
          features: d.features.filter(isBV),
        },
        detailsOV: {
          type: "FeatureCollection",
          features: d.features.filter(isOV),
        },
      });

      if (u.features.length) {
        const coords = u.features.flatMap((f) =>
          f.geometry?.type === "Polygon"
            ? f.geometry.coordinates[0]
            : f.geometry.coordinates.flat()
        );
        const lons = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const centerLon = (minLon + maxLon) / 2;
        const centerLat = (minLat + maxLat) / 2;

        const [x1, y1] = coords[0];
        const [x2, y2] = coords[Math.floor(coords.length / 2)];
        const dx = x2 - x1;
        const dy = y2 - y1;

        const R = 6371000; // jordradie i meter
        const lat0 = (minLat + maxLat) / 2;
        const lon0 = (minLon + maxLon) / 2;
        const coordsMeters = coords.map(([lon, lat]) => [
          (lon - lon0) * (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180),
          (lat - lat0) * (Math.PI / 180) * R,
        ]);

        const coordsFlat = coordsMeters;
        let sumXX = 0,
          sumYY = 0,
          sumXY = 0;
        for (const [x, y] of coordsFlat) {
          sumXX += x * x;
          sumYY += y * y;
          sumXY += x * y;
        }
        const angleRad = 0.5 * Math.atan2(2 * sumXY, sumXX - sumYY);
        const bearing = (-angleRad * 180) / Math.PI - 83;

        setViewState((v) => ({
          ...v,
          longitude: centerLon,
          latitude: centerLat,
          zoom: 20.2,
          pitch: 0,
          bearing,
        }));

        const newHomeView = {
          ...INITIAL_VIEW_STATE,
          longitude: centerLon,
          latitude: centerLat,
          zoom: 20.2,
          pitch: 0,
          bearing,
        };
        setHomeView(newHomeView);
        setViewState(newHomeView);
      }
    })();
  }, []);

  // --- Hjälpfunktion: kontrollera om GPS-punkt ligger i polygon ---
  const pointInPolygon = (point, vs) => {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      const xi = vs[i][0],
        yi = vs[i][1];
      const xj = vs[j][0],
        yj = vs[j][1];
      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };

  // --- Avgör vilket rum GPS är i ---
  const checkCurrentRoom = (lon, lat) => {
    const all = [
      ...(data.unitsBV?.features || []),
      ...(data.unitsOV?.features || []),
    ];
    for (const f of all) {
      const geom =
        f.geometry.type === "Polygon"
          ? f.geometry.coordinates[0]
          : f.geometry.coordinates[0][0];
      if (pointInPolygon([lon, lat], geom)) {
        setSelected(f);
        const level = String(f.properties.LEVEL_ID || "").toUpperCase();
        const elevation = level.includes("Ö") || level.includes("2") ? 2.7 : 0;
        setGpsPos([{ longitude: lon, latitude: lat, elevation }]);
        return;
      }
    }
    setSelected(null);
  };

  // --- GPS aktiveras automatiskt ---
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { longitude, latitude, altitude } = pos.coords;

        if (altitude && baseAltitude === null) setBaseAltitude(altitude);

        const localElevation =
          altitude && baseAltitude !== null ? altitude - baseAltitude : 0;

        // enkel glättning (lågpassfilter)
        setAvgAltitude((prev) =>
          prev === null ? localElevation : prev * 0.8 + localElevation * 0.2
        );

        const smoothed = avgAltitude ?? localElevation;

        // våningsbyte endast om tydlig skillnad
        if (smoothed > 1.5 && currentLevel !== "OV") setCurrentLevel("OV");
        else if (smoothed < 1.0 && currentLevel !== "BV") setCurrentLevel("BV");

        // välj rätt z-höjd för kartan
        const elevationForMap = currentLevel === "OV" ? 2.7 : 0.1;

        setGpsPos([{ longitude, latitude, elevation: elevationForMap }]);
        checkCurrentRoom(longitude, latitude);
      },
      (err) => console.warn("GPS-fel:", err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [data]);

  const toggleGroup = (groupKey) => {
    setVisibleLayers((prev) => {
      const newState = structuredClone(prev);
      const g = newState[groupKey];
      const newVal = !g.active;
      Object.keys(g).forEach((key) => {
        if (key !== "active") g[key] = newVal;
      });
      g.active = newVal;
      return newState;
    });
  };

  const toggleLayer = (groupKey, layerKey) => {
    setVisibleLayers((prev) => {
      const newState = structuredClone(prev);
      newState[groupKey][layerKey] = !newState[groupKey][layerKey];
      const g = newState[groupKey];
      g.active = Object.keys(g)
        .filter((k) => k !== "active")
        .some((k) => g[k]);
      return newState;
    });
  };

  const mmBV = new Matrix4().identity().translate([0, 0, 0]);
  const mmOV = new Matrix4().identity().translate([0, 0, FLOOR_HEIGHT]);

  // --- Lager ---
  const layers = [
    visibleLayers.bottenvaning.unitsBV &&
      new GeoJsonLayer({
        id: "units-bv",
        data: data.unitsBV,
        extruded: true,
        filled: true,
        pickable: true,
        getFillColor: color,
        getLineColor: [0, 0, 80, 100],
        getElevation: () => FLOOR_HEIGHT,
        modelMatrix: mmBV,
      }),
    visibleLayers.overvaning.unitsOV &&
      new GeoJsonLayer({
        id: "units-ov",
        data: data.unitsOV,
        extruded: true,
        filled: true,
        pickable: true,
        getFillColor: color,
        getLineColor: [0, 0, 80, 100],
        getElevation: () => FLOOR_HEIGHT,
        modelMatrix: mmOV,
      }),

    visibleLayers.bottenvaning.detailsBV &&
      new GeoJsonLayer({
        id: "details-bv",
        data:
          data.detailsBV?.features?.filter(
            (f) => f.geometry && f.geometry.coordinates
          ) || [],
        stroked: true,
        filled: true,
        pickable: true,
        getFillColor: [0, 0, 0, 0], // ✅ helt transparent fyllning
        getLineColor: (f) => color(f),
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1.8,
        parameters: { depthTest: false },
        modelMatrix: mmBV,
      }),

    visibleLayers.overvaning.detailsOV &&
      new GeoJsonLayer({
        id: "details-ov",
        data:
          data.detailsOV?.features?.filter(
            (f) => f.geometry && f.geometry.coordinates
          ) || [],
        stroked: true,
        filled: true,
        pickable: true,
        getFillColor: [0, 0, 0, 0],
        getLineColor: (f) => color(f),
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1.8,
        parameters: { depthTest: false },
        modelMatrix: mmOV,
      }),

    selected &&
      new GeoJsonLayer({
        id: "highlight-room",
        data: selected,
        filled: false,
        stroked: true,
        getLineColor: [0, 255, 255, 100], // aqua
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 2.5, // tunnare linje
        parameters: { depthTest: false },
        pickable: false,
        modelMatrix:
          selected?.properties?.LEVEL_ID?.toUpperCase().includes("ÖV") ||
          selected?.properties?.LEVEL_ID?.toUpperCase().includes("OV")
            ? mmOV
            : mmBV,
      }),

    gpsPos &&
      new ScatterplotLayer({
        id: "gps-dot",
        data: gpsPos,
        getPosition: (d) => [d.longitude, d.latitude, d.elevation],
        getRadius: 0.3,
        radiusUnits: "meters",
        getFillColor: [0, 120, 255, 255],
        parameters: { depthTest: false },
      }),
  ]
    .flat()
    .filter(Boolean);
  return (
    <div className="app-container">
      <DeckGL
        layers={layers}
        controller={{ dragRotate: true, touchRotate: true }}
        viewState={{ ...viewState, pitch: is3D ? 70 : 0 }}
        onViewStateChange={({ viewState }) => setViewState(viewState)}
      >
        <Map reuseMaps mapStyle={mapStyle} />
      </DeckGL>

      {/* Lagerpanel */}
      <div className={`layer-controls ${layersOpen ? "open" : "collapsed"}`}>
        <div className="layer-header" onClick={() => setLayersOpen((o) => !o)}>
          <span>🧩 Lager</span>
          <span>{layersOpen ? "▲" : "▼"}</span>
        </div>
        {layersOpen && (
          <div className="layer-body" onClick={(e) => e.stopPropagation()}>
            {["bottenvaning", "overvaning"].map((groupKey) => (
              <div key={groupKey} className="layer-group">
                <label className="group-label">
                  <input
                    type="checkbox"
                    checked={visibleLayers[groupKey].active}
                    onChange={() => toggleGroup(groupKey)}
                  />
                  {groupKey === "bottenvaning" ? "Bottenvåning" : "Övervåning"}
                </label>

                <div className="group-layers">
                  {Object.entries(visibleLayers[groupKey])
                    .filter(([k]) => k !== "active")
                    .map(([layerKey, val]) => (
                      <label key={layerKey}>
                        <input
                          type="checkbox"
                          checked={val}
                          onChange={() => toggleLayer(groupKey, layerKey)}
                        />
                        {{
                          unitsOV: "Rum (ÖV)",
                          detailsOV: "Detaljer (ÖV)",
                          unitsBV: "Rum (BV)",
                          detailsBV: "Detaljer (BV)",
                        }[layerKey] || layerKey}
                      </label>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Infofält */}
      <div className="infobar">
        <div className="gps-info">
          {gpsPos ? (
            <>
              <div>📡 GPS</div>
              <div>
                Lat: {gpsPos[0].latitude.toFixed(6)} Lon:{" "}
                {gpsPos[0].longitude.toFixed(6)}
              </div>
              <div>
                Våning: {selected?.properties?.LEVEL_ID || "-"}
                (höjd {gpsPos[0].elevation.toFixed(1)} m)
              </div>
            </>
          ) : (
            <div>📡 Ingen GPS</div>
          )}
        </div>

        <div className="room-info">
          {selected ? (
            <>
              <div>🏠 Du är här: {selected.properties?.NAME || "-"}</div>
              <div>
                <strong>Typ:</strong> {selected.properties?.USE_TYPE || "-"}
              </div>
            </>
          ) : (
            <div>🏠 Hittar inget rum</div>
          )}
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <button className="view-toggle" onClick={() => setIs3D((v) => !v)}>
            {is3D ? "🔍 Växla till 2D-vy" : "🔍 Växla till 3D-vy"}
          </button>

          <button
            className="view-toggle"
            onClick={() => {
              setIs3D(false);
              setViewState(homeView);
            }}
          >
            🏠 Hem
          </button>
        </div>
      </div>
    </div>
  );
}

export function renderToDOM(container) {
  createRoot(container).render(<App />);
}
