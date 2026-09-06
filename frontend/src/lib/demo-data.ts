/** Curated demo: product facts are sourced; headquarters arcs are illustrative. */
export const PRODUCT_SOURCE = "https://www.apple.com/iphone-17-pro/specs/";
export const TEARDOWN_SOURCE = "https://www.ifixit.com/Guide/iPhone+17+Pro+Chip+ID/196117";
export const ENVIRONMENT_SOURCE =
  "https://www.apple.com/environment/pdf/products/iphone/iPhone_17_Pro_and_iPhone_17_Pro_Max_PER_Sept2025.pdf";

export type PartId = "display" | "silicon" | "camera" | "battery" | "enclosure" | "connectivity";
export interface DemoPart {
  id: PartId;
  name: string;
  subtitle: string;
  material: string;
  detail: string;
  spec: string;
  source: string;
  publisher: string;
  color: string;
}

export const parts: DemoPart[] = [
  {
    id: "display",
    name: "Super Retina XDR display",
    subtitle: "The window into everything.",
    material: "OLED · Ceramic Shield 2",
    detail:
      "A 6.3-inch OLED display with ProMotion and a Ceramic Shield 2 front. The display supplier for this demo unit is unresolved.",
    spec: "6.3″",
    source: PRODUCT_SOURCE,
    publisher: "Apple · Technical specifications",
    color: "#80ccff",
  },
  {
    id: "silicon",
    name: "A19 Pro & logic board",
    subtitle: "Extraordinary, from the inside.",
    material: "Silicon · Copper · Gold",
    detail:
      "Apple’s A19 Pro sits on the logic board alongside memory, storage, and power circuitry. iFixit identifies Samsung memory and Kioxia storage in its teardown unit.",
    spec: "A19 Pro",
    source: TEARDOWN_SOURCE,
    publisher: "iFixit · Component identification",
    color: "#9da7ff",
  },
  {
    id: "camera",
    name: "Pro Fusion camera system",
    subtitle: "A different perspective on detail.",
    material: "Optical glass · Silicon",
    detail:
      "Three 48MP rear cameras: Main, Ultra Wide, and Telephoto. Manufacturer and factory attribution remain unresolved here.",
    spec: "48MP",
    source: PRODUCT_SOURCE,
    publisher: "Apple · Technical specifications",
    color: "#6fe3d3",
  },
  {
    id: "battery",
    name: "Lithium-ion battery",
    subtitle: "Energy, thoughtfully engineered.",
    material: "Lithium · Cobalt · Graphite",
    detail:
      "Apple reports 100% recycled cobalt and 95% recycled lithium in the battery. Raw-material origin and the cell supplier are not established in this demo.",
    spec: "Li-ion",
    source: ENVIRONMENT_SOURCE,
    publisher: "Apple · Environmental report",
    color: "#dcc198",
  },
  {
    id: "enclosure",
    name: "Aluminum unibody",
    subtitle: "A foundation. A thermal system.",
    material: "Aluminum · Ceramic Shield",
    detail:
      "The aluminum enclosure works with a vapor chamber to distribute heat. Apple reports 50% recycled aluminum in the enclosure.",
    spec: "Al",
    source: ENVIRONMENT_SOURCE,
    publisher: "Apple · Environmental report",
    color: "#a7b9d5",
  },
  {
    id: "connectivity",
    name: "Connectivity & sensors",
    subtitle: "Connected to the world around it.",
    material: "Semiconductors · Copper",
    detail:
      "The teardown identifies NXP connectivity hardware and Bosch motion sensors. These component relationships anchor the supplier view.",
    spec: "NFC + IMU",
    source: TEARDOWN_SOURCE,
    publisher: "iFixit · Component identification",
    color: "#79c9bd",
  },
];

export interface Supplier {
  id: string;
  name: string;
  component: string;
  category: string;
  country: string;
  code: string;
  city: string;
  lat: number;
  lon: number;
  color: string;
  source: string;
  locationSource: string;
  detail: string;
}

export const suppliers: Supplier[] = [
  {
    id: "apple",
    name: "Apple",
    component: "A19 Pro",
    category: "Silicon",
    country: "United States",
    code: "US",
    city: "Cupertino",
    lat: 37.3349,
    lon: -122.009,
    color: "#a7b8ff",
    source: PRODUCT_SOURCE,
    locationSource: "https://www.apple.com/contact/",
    detail: "Product and chip design. This pin marks Apple’s corporate headquarters.",
  },
  {
    id: "samsung",
    name: "Samsung",
    component: "12 GB LPDDR5X",
    category: "Memory",
    country: "South Korea",
    code: "KR",
    city: "Suwon",
    lat: 37.2636,
    lon: 127.0286,
    color: "#80ccff",
    source: TEARDOWN_SOURCE,
    locationSource: "https://www.samsung.com/global/ir/ir-resources/faq/",
    detail:
      "Memory identified in iFixit’s teardown unit. Headquarters location; manufacturing site unverified.",
  },
  {
    id: "kioxia",
    name: "Kioxia",
    component: "256 GB NAND",
    category: "Storage",
    country: "Japan",
    code: "JP",
    city: "Tokyo",
    lat: 35.6762,
    lon: 139.6503,
    color: "#6fe3d3",
    source: TEARDOWN_SOURCE,
    locationSource: "https://www.kioxia.com/en-jp/about/about-us.html",
    detail:
      "Flash storage identified in the teardown unit; the exact part marking is tentative. Headquarters location.",
  },
  {
    id: "st",
    name: "STMicroelectronics",
    component: "Power management",
    category: "Power",
    country: "Switzerland",
    code: "CH",
    city: "Geneva",
    lat: 46.2044,
    lon: 6.1432,
    color: "#dcc198",
    source: TEARDOWN_SOURCE,
    locationSource:
      "https://sustainabilityreports.st.com/sr24/_assets/downloads/cpy-living-our-values-st-sr24.pdf",
    detail:
      "STPMIA3A power management identified on the logic board. Pin marks the company’s headquarters.",
  },
  {
    id: "nxp",
    name: "NXP",
    component: "NFC & secure element",
    category: "Connectivity",
    country: "Netherlands",
    code: "NL",
    city: "Eindhoven",
    lat: 51.4416,
    lon: 5.4697,
    color: "#bc9eff",
    source: TEARDOWN_SOURCE,
    locationSource:
      "https://www.nxp.com/company/about-nxp/worldwide-locations/netherlands:NETHERLANDS",
    detail:
      "An SN300 NFC controller is identified in the teardown. Headquarters location; factory unknown.",
  },
  {
    id: "bosch",
    name: "Bosch Sensortec",
    component: "Motion sensors",
    category: "Sensors",
    country: "Germany",
    code: "DE",
    city: "Reutlingen",
    lat: 48.4914,
    lon: 9.2043,
    color: "#e69db6",
    source: TEARDOWN_SOURCE,
    locationSource:
      "https://www.bosch-sensortec.com/media/boschsensortec/downloads/promotion_material/bosch-sensortec-company-brochure.pdf",
    detail:
      "Accelerometer and gyroscope identified by iFixit. This pin marks the supplier’s headquarters.",
  },
];

export const demoExport = {
  product: "iPhone 17 Pro",
  mode: "curated_demo",
  parts,
  suppliers,
  map_method:
    "Approximate headquarters coordinates. Arcs illustrate component relationships to Apple; they are not shipping routes or manufacturing provenance.",
  limitations: [
    "Selected assemblies, not a complete manufacturing BOM.",
    "Teardown findings describe one device and may vary between units.",
    "Quantities, factory locations, and upstream material origins are unresolved.",
  ],
};
