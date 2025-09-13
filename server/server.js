import express from "express";
import morgan from "morgan";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8787;
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// ------------ Helpers de respuesta estilo MCP ------------
const ok = (text) => ({ content: [{ type: "text", text }], isError: false });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });

// ------------ Tools disponibles ------------
const tools = [
  { name: "ping", description: "Health check (pong)." },

  // Búsqueda
  { name: "search_web", description: "Búsqueda rápida con DuckDuckGo IA. Args: { q:string }" },
  { name: "wiki_summary", description: "Resumen de un término en Wikipedia. Args: { title:string, lang?:string }" },

  // Clima (Open-Meteo)
  { name: "weather_now", description: "Clima actual por ciudad. Args: { location:string, lang?:string }" },
  { name: "weather_forecast", description: "Pronóstico diario (3-7 días). Args: { location:string, days?:number, lang?:string }" },
  { name: "weather_hourly", description: "Pronóstico por hora (24-48 h). Args: { location:string, hours?:number, lang?:string }" }
];

// ------------ Utilidades ------------
async function geocode(place) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", place);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "es");
  url.searchParams.set("format", "json");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`geocode HTTP ${r.status}`);
  const j = await r.json();
  const hit = j?.results?.[0];
  if (!hit) throw new Error(`No se encontró la ubicación: ${place}`);
  return {
    name: hit.name,
    country: hit.country,
    lat: hit.latitude,
    lon: hit.longitude,
    admin1: hit.admin1 || ""
  };
}

function prettyPlace(g) {
  const parts = [g.name, g.admin1, g.country].filter(Boolean);
  return parts.join(", ");
}

// ------------ Endpoints ------------
app.get("/", (_req, res) => {
  res.json({ ok: true, endpoints: { tools: "POST /tools", call: "POST /call" } });
});

app.post("/tools", (_req, res) => {
  res.json({ tools });
});

app.post("/call", async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json(err("missing tool name"));

    // ---- ping ----
    if (name === "ping") return res.json(ok("pong"));

    // ---- search_web (DuckDuckGo Instant Answer) ----
    if (name === "search_web") {
      const q = String(args.q || "").trim();
      if (!q) return res.status(400).json(err("q required"));
      const url = new URL("https://api.duckduckgo.com/");
      url.searchParams.set("q", q);
      url.searchParams.set("format", "json");
      url.searchParams.set("no_redirect", "1");
      url.searchParams.set("no_html", "1");

      const r = await fetch(url);
      if (!r.ok) return res.status(502).json(err(`duckduckgo HTTP ${r.status}`));
      const j = await r.json();

      // Armar texto legible corto
      const lines = [];
      if (j.AbstractText) lines.push(j.AbstractText);
      if (Array.isArray(j.RelatedTopics)) {
        const top = j.RelatedTopics.slice(0, 5)
          .map(rt => (rt.Text || (rt.Topics?.[0]?.Text) || ""))
          .filter(Boolean);
        if (top.length) {
          lines.push("Resultados relacionados:");
          top.forEach(t => lines.push(`- ${t}`));
        }
      }
      const out = lines.join("\n").trim() || "(sin resultados útiles)";
      return res.json(ok(out));
    }

    // ---- wiki_summary (Wikipedia REST) ----
    if (name === "wiki_summary") {
      const title = String(args.title || "").trim();
      const lang = (args.lang || "es").toLowerCase();
      if (!title) return res.status(400).json(err("title required"));
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const r = await fetch(url);
      if (r.status === 404) return res.status(404).json(err(`No hay resumen para “${title}”`));
      if (!r.ok) return res.status(502).json(err(`wikipedia HTTP ${r.status}`));
      const j = await r.json();
      const out = `${j.title}\n\n${j.extract || "(sin extracto)"}`;
      return res.json(ok(out));
    }

    // ---- weather_now ----
    if (name === "weather_now") {
      const location = String(args.location || "").trim();
      const lang = (args.lang || "es").toLowerCase();
      if (!location) return res.status(400).json(err("location required"));
      const g = await geocode(location);

      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", g.lat);
      url.searchParams.set("longitude", g.lon);
      url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m");
      url.searchParams.set("timezone", "auto");
      const r = await fetch(url);
      if (!r.ok) return res.status(502).json(err(`forecast HTTP ${r.status}`));
      const j = await r.json();
      const c = j.current || j.current_weather || {};
      const txt = [
        `Clima actual en ${prettyPlace(g)}:`,
        `• Temp: ${c.temperature_2m ?? c.temperature} °C`,
        `• Sensación: ${c.apparent_temperature ?? "-"} °C`,
        `• Humedad: ${c.relative_humidity_2m ?? "-"} %`,
        `• Viento: ${c.wind_speed_10m ?? c.windspeed} km/h`
      ].join("\n");
      return res.json(ok(txt));
    }

    // ---- weather_forecast (diario) ----
    if (name === "weather_forecast") {
      const location = String(args.location || "").trim();
      const days = Math.min(Math.max(parseInt(args.days || 5, 10), 1), 7);
      const lang = (args.lang || "es").toLowerCase();
      if (!location) return res.status(400).json(err("location required"));
      const g = await geocode(location);

      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", g.lat);
      url.searchParams.set("longitude", g.lon);
      url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max");
      url.searchParams.set("timezone", "auto");
      const r = await fetch(url);
      if (!r.ok) return res.status(502).json(err(`forecast HTTP ${r.status}`));
      const j = await r.json();

      const d = j.daily || {};
      const N = Math.min(days, (d.time || []).length);
      const lines = [`Pronóstico ${N} día(s) en ${prettyPlace(g)}:`];
      for (let i = 0; i < N; i++) {
        lines.push(
          `• ${d.time[i]}  max ${d.temperature_2m_max[i]}°C  min ${d.temperature_2m_min[i]}°C  ` +
          `lluvia ${d.precipitation_sum?.[i] ?? 0} mm  viento máx ${d.wind_speed_10m_max?.[i] ?? "-"} km/h`
        );
      }
      return res.json(ok(lines.join("\n")));
    }

    // ---- weather_hourly ----
    if (name === "weather_hourly") {
      const location = String(args.location || "").trim();
      const hours = Math.min(Math.max(parseInt(args.hours || 24, 10), 1), 48);
      const lang = (args.lang || "es").toLowerCase();
      if (!location) return res.status(400).json(err("location required"));
      const g = await geocode(location);

      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", g.lat);
      url.searchParams.set("longitude", g.lon);
      url.searchParams.set("hourly", "temperature_2m,precipitation,wind_speed_10m");
      url.searchParams.set("timezone", "auto");
      const r = await fetch(url);
      if (!r.ok) return res.status(502).json(err(`forecast HTTP ${r.status}`));
      const j = await r.json();

      const h = j.hourly || {};
      const lines = [`Pronóstico por hora (${hours}h) en ${prettyPlace(g)}:`];
      for (let i = 0; i < Math.min(hours, (h.time || []).length); i++) {
        lines.push(
          `• ${h.time[i]}  ${h.temperature_2m[i]}°C  lluvia ${h.precipitation?.[i] ?? 0} mm  viento ${h.wind_speed_10m?.[i] ?? "-"} km/h`
        );
      }
      return res.json(ok(lines.join("\n")));
    }

    // ---- desconocida ----
    return res.status(404).json(err(`Unknown tool: ${name}`));
  } catch (e) {
    return res.status(500).json(err(`server error: ${String(e.message || e)}`));
  }
});

app.listen(PORT, () => {
  console.log(`Remote Search+Weather listening on http://0.0.0.0:${PORT}`);
});