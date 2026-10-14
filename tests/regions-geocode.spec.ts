import { describe, expect, it } from "vitest";
import { lookupCountry, lookupState, normalizeName, unwrapRing } from "../src/lib/geo/regions";
import { geocodeCity, loadCityIndex, loadZipIndex, normalizeZip } from "../src/lib/geo/geocode";

describe("country lookup", () => {
  it("matches names, codes, aliases and accents", () => {
    expect(lookupCountry("United States")?.a2).toBe("US");
    expect(lookupCountry("USA")?.a2).toBe("US");
    expect(lookupCountry("us")?.a2).toBe("US");
    expect(lookupCountry("United States of America")?.a2).toBe("US");
    expect(lookupCountry("GBR")?.a2).toBe("GB");
    expect(lookupCountry("UK")?.a2).toBe("GB");
    expect(lookupCountry("Côte d'Ivoire")?.a2).toBe("CI");
    expect(lookupCountry("cote d ivoire")?.a2).toBe("CI");
    expect(lookupCountry("South Korea")?.a2).toBe("KR");
    expect(lookupCountry("Czechia")?.a2).toBe("CZ");
    expect(lookupCountry(840)?.a2).toBe("US");
    expect(lookupCountry("076")?.a2).toBe("BR");
    expect(lookupCountry("Narnia")).toBeNull();
  });

  it("has centroids on land for countries with overseas territory", () => {
    const fr = lookupCountry("France")!;
    expect(fr.lat).toBeGreaterThan(42);
    expect(fr.lng).toBeGreaterThan(-5);
    const ru = lookupCountry("Russia")!;
    expect(ru.lng).toBeGreaterThan(30);
    expect(ru.lng).toBeLessThan(180);
  });
});

describe("US state lookup", () => {
  it("matches names, abbreviations and FIPS codes", () => {
    expect(lookupState("TX")?.name).toBe("Texas");
    expect(lookupState("texas")?.abbr).toBe("TX");
    expect(lookupState("New York")?.abbr).toBe("NY");
    expect(lookupState(6)?.abbr).toBe("CA");
    expect(lookupState("Washington DC")?.abbr).toBe("DC");
    expect(lookupState("Puerto Rico")?.abbr).toBe("PR");
    expect(lookupState("Ontario")).toBeNull();
  });
});

describe("normalizeName", () => {
  it("strips accents, punctuation and leading 'the'", () => {
    expect(normalizeName("  São Paulo ")).toBe("sao paulo");
    expect(normalizeName("The Netherlands")).toBe("netherlands");
    expect(normalizeName("Trinidad & Tobago")).toBe("trinidad and tobago");
  });
});

describe("unwrapRing", () => {
  it("makes antimeridian-crossing rings continuous", () => {
    const ring = [[179, 60], [-179, 60], [-179, 61], [179, 61], [179, 60]];
    const out = unwrapRing(ring);
    expect(out.map((p) => p[0])).toEqual([179, 181, 181, 179, 179]);
  });
});

describe("city geocoding", () => {
  it("prefers the most populous match and honours qualifiers", async () => {
    const idx = await loadCityIndex();
    const paris = geocodeCity("Paris", idx)!;
    expect(paris.cc).toBe("FR");
    const parisTx = geocodeCity("Paris, TX", idx)!;
    expect(parisTx.cc).toBe("US");
    expect(parisTx.admin1).toBe("TX");
    expect(geocodeCity("London, Ontario", idx)?.cc).toBe("CA");
    expect(geocodeCity("London", idx)?.cc).toBe("GB");
    expect(geocodeCity("Springfield, Illinois", idx)?.admin1).toBe("IL");
    expect(geocodeCity("Springfield", idx, { region: "MA" })?.admin1).toBe("MA");
    expect(geocodeCity("Portland", idx, { region: "Maine" })?.admin1).toBe("ME");
    expect(geocodeCity("São Paulo", idx)?.cc).toBe("BR");
    expect(geocodeCity("Sao Paulo, Brazil", idx)?.cc).toBe("BR");
    expect(geocodeCity("New York", idx)?.cc).toBe("US");
    expect(geocodeCity("St. Louis", idx)?.admin1).toBe("MO");
    expect(geocodeCity("Cambridge", idx, { defaultCountry: "US" })?.cc).toBe("US");
    expect(geocodeCity("Xyzzyville", idx)).toBeNull();
  });
});

describe("ZIP codes", () => {
  it("normalises and resolves ZIPs", async () => {
    expect(normalizeZip("02134")).toBe("02134");
    expect(normalizeZip("02134-1234")).toBe("02134");
    expect(normalizeZip(2134)).toBe("02134");
    expect(normalizeZip("abc")).toBeNull();
    const idx = await loadZipIndex();
    const [lat, lng] = idx.get("10001")!;
    expect(lat).toBeCloseTo(40.75, 1);
    expect(lng).toBeCloseTo(-74.0, 1);
    // 30301 is an Atlanta PO-box ZIP with no ZCTA, but its 303xx area has one
    expect(idx.get("30301")).toBeUndefined();
    const [alat, alng] = idx.area("30301")!;
    expect(alat).toBeCloseTo(33.8, 0);
    expect(alng).toBeCloseTo(-84.4, 0);
    expect(idx.area("99999")).toBeUndefined();
  });
});
