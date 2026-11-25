// Excel fill patterns: bitmaps, tile sizing, swatches.
import { describe, expect, it } from 'vitest';
import { EXCEL_PATTERNS, hatchTileSize, spanSwatchCss } from '../src/spans';
import type { ExcelPattern, SeriesDef } from '../src/types';

const coverage = (rows: readonly number[]) => {
  let on = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (rows[r % rows.length]! & (0x80 >> c)) on++;
  return on / 64;
};

describe('EXCEL_PATTERNS', () => {
  it('covers all eighteen Excel patterns, with rows that repeat to eight', () => {
    expect(Object.keys(EXCEL_PATTERNS)).toHaveLength(18);
    for (const p of Object.values(EXCEL_PATTERNS)) expect(8 % p.rows.length).toBe(0);
  });

  it('gives each grey the coverage its name says', () => {
    const greys: Array<[ExcelPattern, number]> = [
      ['solid', 1],
      ['darkGray', 0.75],
      ['mediumGray', 0.5],
      ['lightGray', 0.25],
      ['gray125', 0.125],
      ['gray0625', 0.0625],
    ];
    for (const [name, share] of greys) expect(coverage(EXCEL_PATTERNS[name].rows)).toBe(share);
  });

  it('draws stripes and crosshatches at their usual weights', () => {
    expect(coverage(EXCEL_PATTERNS.darkHorizontal.rows)).toBe(0.5);
    expect(coverage(EXCEL_PATTERNS.lightHorizontal.rows)).toBe(0.25);
    expect(coverage(EXCEL_PATTERNS.lightDown.rows)).toBe(0.25);
    expect(coverage(EXCEL_PATTERNS.darkTrellis.rows)).toBe(0.75);
    expect(coverage(EXCEL_PATTERNS.lightGrid.rows)).toBe(7 / 16);
  });

  it('runs reverse-diagonal stripes down to the right and diagonal stripes up', () => {
    const first = (row: number) => Math.clz32(row) - 24; // leftmost set column
    expect(first(EXCEL_PATTERNS.lightDown.rows[1]!)).toBe(first(EXCEL_PATTERNS.lightDown.rows[0]!) + 1);
    expect(first(EXCEL_PATTERNS.lightUp.rows[1]!)).toBe(first(EXCEL_PATTERNS.lightUp.rows[0]!) - 1);
  });
});

describe('Excel pattern tiles and swatches', () => {
  it('sizes tiles in whole multiples of eight device px', () => {
    expect(hatchTileSize({ pattern: 'gray0625' }, 1)).toBe(8);
    expect(hatchTileSize({ pattern: 'gray0625' }, 2)).toBe(16);
    expect(hatchTileSize({ pattern: 'gray0625', spacingPx: 12 }, 1.5)).toBe(16);
  });

  it('renders the bitmap as an SVG swatch', () => {
    const def = { key: 'w', renderer: 'vrect', color: '#000' } as unknown as SeriesDef;
    const css = spanSwatchCss(def, { name: 'Pre', hatch: { pattern: 'gray0625', color: 'rgb(240,255,240)' } });
    expect(css).toContain('data:image/svg+xml,');
    const svg = decodeURIComponent(css.slice(css.indexOf(',') + 1, css.indexOf('")')));
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(4); // 6.25% of 64
    expect(svg).toContain('fill="rgb(240,255,240)"');
  });
});
