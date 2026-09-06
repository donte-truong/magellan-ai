import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Source, Usage } from '../research/schema';
import type { ImageMediaType } from '../research/providers';

export const BOM_PROMPT_VERSION = 'bom-estimate-v2';
export const bomCategories = ['component', 'subassembly', 'material', 'packaging', 'consumable', 'software', 'other'] as const;
export type BomCategory = typeof bomCategories[number];
export const imageMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const satisfies readonly ImageMediaType[];
export const MAX_IMAGE_BYTES = 5_000_000;

const cap = (d: number, max: number, min = 1) => z.number().int().min(min).max(max).default(d);
export const bomLimitsSchema = z.object({
  max_searches: cap(5, 20, 0), max_documents: cap(6, 20, 0), max_items: cap(60, 200),
  max_seconds: cap(180, 600), max_model_calls: cap(16, 60), max_cost_minor: cap(300, 10_000, 0),
  max_input_tokens: cap(400_000, 2_000_000, 1000), max_output_tokens: cap(60_000, 200_000, 500),
}).strict();
export type BomLimits = z.infer<typeof bomLimitsSchema>;
export const bomRequestSchema = z.object({
  description: z.string().trim().min(1).max(4000).optional(),
  url: z.url().max(2000).optional(),
  image: z.object({ data: z.string().min(1).max(7_000_000), media_type: z.enum(imageMediaTypes) }).strict().optional(),
  image_url: z.url().max(2000).optional(),
  company: z.string().trim().min(1).max(200).optional(),
  limits: bomLimitsSchema.prefault({}),
}).strict().refine(r => r.description || r.url || r.image || r.image_url, { message: 'Provide at least one of description, url, image, or image_url' });
export type BomRequest = z.infer<typeof bomRequestSchema>;

export interface DecodedImage { media_type: ImageMediaType; data: string; bytes: number; sha256: string }
export function sniffImage(b: Uint8Array): ImageMediaType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
export const imageExtension = (media: ImageMediaType) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[media];
export function decodeImage(image: { data: string; media_type: string }): DecodedImage {
  const data = image.data.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('image.data must be plain base64 without a data: prefix');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
  const sniffed = sniffImage(buffer);
  if (!sniffed) throw new Error('Image bytes are not a recognised JPEG, PNG, WebP, or GIF');
  if (sniffed !== image.media_type) throw new Error(`Declared media type ${image.media_type} does not match the image bytes (${sniffed})`);
  return { media_type: sniffed, data: buffer.toString('base64'), bytes: buffer.byteLength, sha256: createHash('sha256').update(buffer).digest('hex') };
}

// Model-facing schemas. All fields are required and optional concepts are nullable for strict structured outputs.
const category = z.enum(bomCategories);
const optionalText = (max: number) => z.string().max(max).nullable();
export const confidenceLabels = ['high', 'medium', 'low'] as const;
export const visionSchema = z.object({
  product_guess: optionalText(200), brand_guess: optionalText(100), category: z.string().max(100),
  visible_text: z.array(z.string().max(200)).max(20),
  visible_items: z.array(z.object({ name: z.string().min(1).max(200), category, material: optionalText(100), notes: optionalText(300) }).strict()).max(30),
  notes: z.string().max(1000),
}).strict();
export const identifySchema = z.object({
  product_name: z.string().min(1).max(200), brand: optionalText(100), category: z.string().max(100),
  identifiers: z.array(z.string().max(100)).max(10), summary: z.string().max(800),
  search_queries: z.array(z.string().min(1).max(200)).max(5), ambiguity: optionalText(500),
}).strict();
export const extractSchema = z.object({
  relevant: z.boolean(),
  items: z.array(z.object({
    name: z.string().min(1).max(200), category, quantity: z.number().nullable(), unit: optionalText(40),
    material: optionalText(100), manufacturer: optionalText(100), part_number: optionalText(100), notes: optionalText(300),
    quote: z.string().min(10).max(400),
  }).strict()).max(30),
}).strict();
export const composeSchema = z.object({
  items: z.array(z.object({
    name: z.string().min(1).max(200), category, quantity: z.number().nullable(), unit: optionalText(40),
    material: optionalText(100), manufacturer: optionalText(100), part_number: optionalText(100),
    parent_name: optionalText(200), notes: optionalText(300),
    evidence_ids: z.array(z.string().max(40)).max(8), general_knowledge: z.boolean(), confidence: z.enum(confidenceLabels),
  }).strict()).max(200),
  open_questions: z.array(z.string().max(300)).max(15),
}).strict();
export type VisionResult = z.infer<typeof visionSchema>;
export type IdentifyResult = z.infer<typeof identifySchema>;
export type ExtractResult = z.infer<typeof extractSchema>;
export type ComposeResult = z.infer<typeof composeSchema>;

// Output. `sources` on an item records where the agent got the item from, never where the part was manufactured.
export type BomSourceRef =
  | { type: 'web_page'; source_id: string; url: string; title: string | null; quote: string; locator: string }
  | { type: 'web_page_unverified'; source_id: string; url: string; title: string | null; claimed_quote: string; note: string }
  | { type: 'search_snippet'; url: string; title: string; snippet: string; query: string }
  | { type: 'image_analysis'; source_id: string; note: string }
  | { type: 'user_input'; field: 'description' | 'url' | 'image_url' | 'company'; note: string }
  | { type: 'model_knowledge'; note: string };
export type Basis = 'evidenced' | 'inferred' | 'guessed';
export type Confidence = typeof confidenceLabels[number];
export interface BomItem {
  id: string; name: string; category: BomCategory; quantity: number | null; unit: string | null;
  material: string | null; manufacturer: string | null; part_number: string | null; parent_item_id: string | null; notes: string | null;
  basis: Basis; confidence: Confidence; sources: BomSourceRef[];
}
export interface BomEvidence {
  id: string; origin: BomSourceRef['type'] | 'user_description'; name: string | null; category: BomCategory | null;
  quantity: number | null; unit: string | null; material: string | null; manufacturer: string | null; part_number: string | null; notes: string | null;
  url: string | null; title: string | null; quote: string | null; ref: BomSourceRef;
}
export interface BomProduct { name: string | null; brand: string | null; category: string | null; identifiers: string[]; summary: string | null; identified_from: string[]; ambiguity: string | null }
export type BomStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export interface Bom {
  id: string; status: BomStatus; mode: 'live'; stop_reason: string | null; product: BomProduct;
  inputs: { description: string | null; url: string | null; image: { media_type: ImageMediaType; bytes: number; sha256: string } | null; image_url: string | null; company: string | null };
  items: BomItem[]; evidence: BomEvidence[]; sources: Source[]; open_questions: string[];
  usage: Usage; limits: BomLimits; disclaimer: string; created_at: string; completed_at: string | null;
}
