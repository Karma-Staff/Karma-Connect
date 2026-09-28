# ADR-004 — Map geometry is projected and simplified offline

**Status** Accepted · **Date** 2026-09 · **Owner** repo owner

## Context

Storm watch needs a map of the US and Canada. Karma Leads has no build step, a
strict Content-Security-Policy, and is served from one Render instance.

## Options

1. A map library from a CDN (Leaflet/d3) plus a tile server.
2. Inline SVG from geometry projected at runtime.
3. Geometry projected and simplified **offline**, shipped as a plain script.

## Decision

Option 3. `leads/scripts/build-na-geo.mjs` turns Natural Earth 1:50m admin-1
(public domain) into `leads/public/na-geo.js`, which sets `window.NA_GEO`.
2.3 MB of source becomes 52 KB via Albers equal-area projection,
Douglas-Peucker simplification and dropping sub-threshold rings.

## Reason

No map library, no tile server, nothing new for the CSP to allow, and no
runtime cost. The file is generated — re-run the script rather than editing it.

## Tradeoffs

- Regenerating needs the source GeoJSON, which is not vendored. The script
  prints its own usage.
- Equal-area, not Mercator: on a Mercator, Nunavut would out-size the entire
  lower 48 and a reader would take that as meaning something.
- The frame is cropped to the US with headroom, because fitting all of Canada
  puts 3,000 km of empty Arctic on screen and squeezes the states where every
  lead is into a strip.
- DC is kept below the speck threshold on purpose: it is a jurisdiction the
  rest of the app filters by, and a map missing a place lies by omission.
