import { render, screen } from '@testing-library/react';
import React from 'react';

import { DEFAULT_BUILDER, BuilderState } from '../types';
import { QueryBuilder } from './QueryBuilder';

/**
 * Component tests for the WHERE row affordances.
 *
 * These exist because the ability to add a second filter was removed twice by edits
 * that were only meant to change styling, and nothing caught it: the SQL generator
 * tests pass regardless, since a filter you cannot add is a filter that never reaches
 * the generator.
 */
const datasource = {
  getResource: async () => ({ columns: [], values: [], tables: [] }),
} as never;

function renderBuilder(builder: BuilderState) {
  return render(
    <QueryBuilder
      builder={builder}
      format="time_series"
      datasource={datasource}
      generatedSQL=""
      onChange={() => {}}
      onRunQuery={() => {}}
    />
  );
}

const withFilters = (n: number): BuilderState => ({
  ...DEFAULT_BUILDER,
  table: 'can_signals',
  timeColumn: 'ts_ms',
  select: [{ column: 'value', aggregate: 'avg' }],
  filters: Array.from({ length: n }, (_, i) => ({
    key: `col_${i}`,
    operator: '=' as const,
    value: `v_${i}`,
  })),
});

describe('WHERE row affordances', () => {
  it('offers an add-filter control when there are no filters yet', () => {
    renderBuilder(withFilters(0));
    expect(screen.getAllByLabelText('add filter').length).toBeGreaterThan(0);
  });

  // The regression: with one filter present there was no + anywhere, so a second
  // filter could not be added at all.
  it('still offers add-filter once a filter exists', () => {
    renderBuilder(withFilters(1));
    expect(screen.getAllByLabelText('add filter').length).toBeGreaterThan(0);
  });

  it('offers exactly one add-filter control with several filters', () => {
    renderBuilder(withFilters(3));
    expect(screen.getAllByLabelText('add filter')).toHaveLength(1);
  });

  it('lets every filter be removed individually', () => {
    renderBuilder(withFilters(3));
    expect(screen.getAllByLabelText('remove filter')).toHaveLength(3);
  });
});
