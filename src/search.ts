import axios from 'axios';

export interface Medicine {
  id: string;
  name: string;
  price: number;
  stock: number;
  currency?: string;
  description?: string;
  wholesalerName?: string;
  wholesalerPhone?: string;
  wholesalerCity?: string;
}

export interface SearchResult {
  query: string;
  medicines: Medicine[];
  found: boolean;
}

export interface MultiSearchResult {
  results: SearchResult[];
  totalFound: number;
  notFound: string[];
}

function apiBase(): string {
  return process.env.API_BASE_URL || 'https://api.mupharmacy.com';
}

function mapProduct(p: any, wholesaler: any): Medicine {
  return {
    id: p.id,
    name: p.brand ? `${p.drugName} (${p.brand})` : p.drugName,
    price: p.salePrice,
    stock: p.remainingStock,
    currency: p.currency || 'MWK',
    description: p.description,
    wholesalerName: wholesaler?.name,
    wholesalerPhone: wholesaler?.phone,
    wholesalerCity: wholesaler?.city,
  };
}

function flattenResponse(data: any): Medicine[] {
  if (!data?.success) return [];
  const wholesalers = data.data || [];
  return wholesalers.flatMap((w: any) =>
    (w.products || []).map((p: any) => mapProduct(p, w)),
  );
}

/**
 * Parses a multi-line or comma-separated query into individual search terms.
 * Handles formats like:
 *   - "Tamsulosin\nFlucloxacillin caps\nTriamcinolone inj"
 *   - "Tamsulosin, Flucloxacillin, Allopurinol 100mg"
 *   - Lines starting with bullets, numbers, dashes
 *   - Trailing context like "(Wholesaler)" is stripped
 */
export function parseQueryList(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map(line =>
      line
        .replace(/^[\s\-\*\•\d\.\)]+/, '') // strip bullets/numbers
        .replace(/\(.*?\)/g, '')            // strip parenthetical notes like (Wholesaler)
        .trim(),
    )
    .filter(line => line.length > 2);       // ignore very short/empty lines
}

/**
 * Detects if a query contains multiple items.
 */
export function isMultiItemQuery(input: string): boolean {
  const lines = input.split('\n').filter(l => l.trim().length > 2);
  const commas = (input.match(/,/g) || []).length;
  return lines.length > 1 || commas >= 2;
}

export async function searchMedicine(query: string): Promise<Medicine[]> {
  try {
    const { data } = await axios.get(`${apiBase()}/api/public/search`, {
      params: { q: query.trim() },
      timeout: 5000,
    });
    return flattenResponse(data);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return [];
    console.error('searchMedicine error:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Searches multiple items in parallel and returns aggregated results.
 */
export async function searchMedicineMulti(queries: string[]): Promise<MultiSearchResult> {
  const unique = [...new Set(queries.map(q => q.trim()).filter(Boolean))];

  const settled = await Promise.allSettled(
    unique.map(async (q): Promise<SearchResult> => {
      const medicines = await searchMedicine(q);
      return { query: q, medicines, found: medicines.length > 0 };
    }),
  );

  const results: SearchResult[] = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { query: unique[i], medicines: [], found: false },
  );

  return {
    results,
    totalFound: results.filter(r => r.found).length,
    notFound: results.filter(r => !r.found).map(r => r.query),
  };
}

/**
 * Smart search — automatically handles single or multi-item queries.
 */
export async function smartSearch(input: string): Promise<MultiSearchResult> {
  const queries = isMultiItemQuery(input) ? parseQueryList(input) : [input.trim()];
  recordSearchTrend(input);
  return searchMedicineMulti(queries);
}

export function recordSearchTrend(term: string): void {
  axios.post(`${apiBase()}/api/public/search/record`, { term }).catch(() => {});
}