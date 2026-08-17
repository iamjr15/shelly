import type { MetadataRoute } from "next";

const routes = ["", "/install", "/architecture", "/protocol", "/privacy"];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: `https://shelly.sh${route}/`,
    lastModified: new Date("2026-08-17"),
    changeFrequency: route === "" ? "weekly" : "monthly",
    priority: route === "" ? 1 : route === "/privacy" ? 0.6 : 0.8,
  }));
}
