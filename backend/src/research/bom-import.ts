import { z } from 'zod';

const text = (max: number) => z.string().max(max);
const nullable = (max: number) => text(max).nullable();
// Import contract for a persisted /v1/bom response. Additional snapshot fields
// (evidence, usage, inputs, timestamps) are preserved without treating them as facts.
const ref = z.discriminatedUnion('type', [
  z.object({ type: z.literal('web_page'), source_id: text(200), url: z.url().max(2000), title: nullable(2000), quote: text(4000), locator: text(2000) }),
  z.object({ type: z.literal('web_page_unverified'), source_id: text(200), url: z.url().max(2000), title: nullable(2000), claimed_quote: text(4000), note: text(4000) }),
  z.object({ type: z.literal('search_snippet'), url: z.url().max(2000), title: text(2000), snippet: text(16000), query: text(2000) }),
  z.object({ type: z.literal('image_analysis'), source_id: text(200), note: text(4000) }),
  z.object({ type: z.literal('user_input'), field: z.enum(['description', 'url', 'image_url', 'company']), note: text(4000) }),
  z.object({ type: z.literal('model_knowledge'), note: text(4000) }),
]);
export const importedBomItemSchema = z.object({
  id: text(200).min(1), name: text(200).min(1),
  category: z.enum(['component', 'subassembly', 'material', 'packaging', 'consumable', 'software', 'other']),
  quantity: z.number().finite().nullable(), unit: nullable(40), material: nullable(100),
  manufacturer: nullable(100), part_number: nullable(100), parent_item_id: nullable(200), notes: nullable(300),
  basis: z.enum(['evidenced', 'inferred', 'guessed']), confidence: z.enum(['high', 'medium', 'low']),
  sources: z.array(ref).max(100),
}).passthrough();
export const bomEstimateSchema = z.object({
  id: text(200).min(1), status: z.enum(['completed', 'partial']),
  product: z.object({ name: text(200).min(1), brand: nullable(100) }).passthrough(),
  items: z.array(importedBomItemSchema).max(200),
  sources: z.array(z.object({ id: text(200).min(1), url: z.url().max(2000) }).passthrough()).max(100),
}).passthrough().superRefine((bom, ctx) => {
  const items = new Map(bom.items.map(item => [item.id, item]));
  const sources = new Set(bom.sources.map(source => source.id));
  if (items.size !== bom.items.length) ctx.addIssue({ code: 'custom', message: 'Duplicate BOM item IDs' });
  if (sources.size !== bom.sources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate BOM source IDs' });
  for (const [index, item] of bom.items.entries()) {
    const seen = new Set([item.id]); let parent = item.parent_item_id;
    while (parent) {
      if (!items.has(parent) || seen.has(parent)) { ctx.addIssue({ code: 'custom', path: ['items', index, 'parent_item_id'], message: 'BOM parent must reference another item without cycles' }); break; }
      seen.add(parent); parent = items.get(parent)!.parent_item_id;
    }
    for (const source of item.sources) {
      if ('source_id' in source && !sources.has(source.source_id)) ctx.addIssue({ code: 'custom', path: ['items', index, 'sources'], message: 'BOM citation references a missing source' });
    }
  }
});
