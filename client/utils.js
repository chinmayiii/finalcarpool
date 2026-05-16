/**
 * utils.js — shared client-side utilities
 */

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const OSRM_BASE      = "https://router.project-osrm.org/route/v1/driving";

const OFFICE_LOCATION = { lat: 12.9716, lng: 77.5946 };

// ── Auth helpers ───────────────────────────────────────────────────────────

function getToken() {
  return localStorage.getItem("carpoolToken") || null;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${getToken()}`
  };
}

function requireAuth() {
  if (!getToken()) {
    window.location.href = "login.html";
  }
}

function requireRole(role) {
  if (!getToken()) {
    window.location.href = "login.html?role=" + encodeURIComponent(role);
    return;
  }
  const stored = localStorage.getItem("carpoolRole");
  if (stored !== role) {
    window.location.href = "login.html?role=" + encodeURIComponent(role);
  }
}

// ── Geocoding ──────────────────────────────────────────────────────────────

async function fetchGeocodeCandidates(query) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "5",
    countrycodes: "in"
  });
  // FIX: Nominatim requires a User-Agent and forbids rapid automated use
  // Add a 1-second gap between calls (enforced by callers via geocodePlace)
  const res = await fetch(`${NOMINATIM_BASE}?${params.toString()}`, {
    headers: { "Accept-Language": "en" }
  });
  if (!res.ok) throw new Error(`Geocoding service error (${res.status}). Please try again.`);
  return res.json();
}

// Throttle: track last geocode time to respect Nominatim's 1 req/sec policy
let _lastGeocodeAt = 0;
async function geocodePlace(query, cityHint = "Bengaluru, Karnataka, India") {
  if (!query || !query.trim()) throw new Error("Location name cannot be empty");

  // Enforce ≥1 second between Nominatim requests
  const now = Date.now();
  const wait = 1000 - (now - _lastGeocodeAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastGeocodeAt = Date.now();

  let results;
  try {
    results = await fetchGeocodeCandidates(`${query}, ${cityHint}`);
  } catch (e) {
    throw new Error("Could not reach the location service. Check your internet connection.");
  }

  if (!Array.isArray(results) || !results.length) {
    // FIX: fallback to plain query without city hint
    _lastGeocodeAt = Date.now();
    try {
      results = await fetchGeocodeCandidates(query);
    } catch (e) {
      throw new Error("Could not reach the location service. Check your internet connection.");
    }
  }

  if (!Array.isArray(results) || !results.length) {
    throw new Error(`Location not found: "${query}". Try a more specific address.`);
  }

  return { lat: Number(results[0].lat), lng: Number(results[0].lon) };
}

// ── Routing ────────────────────────────────────────────────────────────────

/**
 * Fetches a driving route between two { lat, lng } points via OSRM.
 * FIX: Added timeout and user-friendly error messages.
 * NOTE: router.project-osrm.org is a public demo — replace with a
 * self-hosted instance or commercial provider (ORS, Mapbox) in production.
 */
async function fetchRoute(origin, destination) {
  const url =
    `${OSRM_BASE}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}` +
    `?overview=full&geometries=geojson`;

  // FIX: abort after 10 seconds so UI doesn't hang silently
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  let data;
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Routing service error (${res.status})`);
    data = await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error("Route calculation timed out. The routing service may be busy — please try again.");
    }
    throw new Error("Could not calculate route. Check your internet connection.");
  }

  const route = data?.routes?.[0];
  if (!route) {
    throw new Error("No route found between these locations. Try different source/destination.");
  }

  return {
    distance:    route.distance,
    duration:    route.duration,
    coordinates: (route.geometry?.coordinates || []).map(([lng, lat]) => [lat, lng])
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatDistance(meters) {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${Math.round(meters)} m`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} min`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

// Attach everything to window so all pages can use them
window.getToken        = getToken;
window.authHeaders     = authHeaders;
window.requireAuth     = requireAuth;
window.requireRole     = requireRole;
window.geocodePlace    = geocodePlace;
window.fetchRoute      = fetchRoute;
window.formatDistance  = formatDistance;
window.formatDuration  = formatDuration;
window.OFFICE_LOCATION = OFFICE_LOCATION;
