const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/;

export function isGeohash(s: string): boolean {
  return GEOHASH_RE.test(s.trim().toLowerCase());
}

export interface GeohashBox {
  lat: number;
  lng: number;
  south: number;
  north: number;
  west: number;
  east: number;
}

export function decodeGeohash(input: string): GeohashBox | null {
  const hash = input.trim().toLowerCase();
  if (!GEOHASH_RE.test(hash)) return null;
  let evenBit = true;
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2;
        if (bit) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return {
    lat: (latMin + latMax) / 2,
    lng: (lngMin + lngMax) / 2,
    south: latMin,
    north: latMax,
    west: lngMin,
    east: lngMax,
  };
}
