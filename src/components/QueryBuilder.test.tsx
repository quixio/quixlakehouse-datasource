import { fireEvent, render, screen } from '@testing-library/react';
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

/**
 * AND/OR with brackets (sc-74551).
 *
 * The controls are asserted here rather than only in the generator tests because a
 * predicate you cannot build in the UI is a predicate that never reaches the generator —
 * which is how the add-filter regression got through twice.
 */
describe('WHERE group affordances', () => {
  const nested: BuilderState = {
    ...DEFAULT_BUILDER,
    table: 'can_signals',
    timeColumn: 'ts_ms',
    select: [{ column: 'value', aggregate: 'avg' }],
    where: {
      conjunction: 'AND',
      children: [
        { kind: 'condition', condition: { key: 'platform', operator: '=', value: 'A' } },
        {
          kind: 'group',
          group: {
            conjunction: 'OR',
            children: [
              { kind: 'condition', condition: { key: 'signal', operator: '=', value: 'x' } },
              { kind: 'condition', condition: { key: 'signal', operator: '=', value: 'y' } },
            ],
          },
        },
      ],
    },
  };

  it('offers a way to bracket every row, including the first', () => {
    renderBuilder(withFilters(3));
    expect(screen.getAllByLabelText('wrap in brackets')).toHaveLength(3);
  });

  /**
   * The regression: brackets could only be APPENDED, so the first condition could never
   * be put inside them — `(a OR b) AND c` was unreachable from the builder even though
   * the generator could emit it.
   */
  it('brackets the first row in place, without disturbing the others', () => {
    const onChange = jest.fn();
    render(
      <QueryBuilder
        builder={withFilters(2)}
        format="time_series"
        datasource={datasource}
        generatedSQL=""
        onChange={onChange}
        onRunQuery={() => {}}
      />
    );

    fireEvent.click(screen.getAllByLabelText('wrap in brackets')[0]);

    const next = onChange.mock.calls[0][0] as BuilderState;
    expect(next.where?.children).toHaveLength(2);
    const [first, second] = next.where!.children;
    expect(first.kind).toBe('group');
    expect(first.kind === 'group' && first.group.children).toHaveLength(1);
    expect(second.kind).toBe('condition');
  });

  // Nesting AND inside AND changes nothing, so a bracket that opens with the same
  // operator as its parent looks broken.
  it('opens a bracket with the opposite conjunction to its parent', () => {
    const onChange = jest.fn();
    render(
      <QueryBuilder
        builder={withFilters(2)}
        format="time_series"
        datasource={datasource}
        generatedSQL=""
        onChange={onChange}
        onRunQuery={() => {}}
      />
    );

    fireEvent.click(screen.getAllByLabelText('wrap in brackets')[0]);

    const next = onChange.mock.calls[0][0] as BuilderState;
    const first = next.where!.children[0];
    expect(first.kind === 'group' && first.group.conjunction).toBe('OR');
  });

  it('renders the rows of a nested group', () => {
    renderBuilder(nested);
    // One row for the outer condition plus two inside the group.
    expect(screen.getAllByLabelText('remove filter')).toHaveLength(3);
  });

  it('offers a conjunction selector for every row after the first in a group', () => {
    renderBuilder(nested);
    // The outer group's second child (the bracket row) and the inner group's second row.
    expect(screen.getAllByLabelText('conjunction')).toHaveLength(2);
  });

  it('lets a nested group be removed as a whole', () => {
    renderBuilder(nested);
    expect(screen.getAllByLabelText('remove group')).toHaveLength(1);
  });

  it('shows no group-removal control when the predicate is flat', () => {
    renderBuilder(withFilters(2));
    expect(screen.queryAllByLabelText('remove group')).toHaveLength(0);
  });

  it('shows no conjunction selector on a single-row predicate', () => {
    renderBuilder(withFilters(1));
    expect(screen.queryAllByLabelText('conjunction')).toHaveLength(0);
  });

  /**
   * The regression: this left an orphaned `AND (` on screen with no rows, no closing
   * bracket and no control able to remove it, because the remove-group button lives on
   * the group's last row.
   */
  it('removes the whole group when its last condition is removed', () => {
    const onChange = jest.fn();
    render(
      <QueryBuilder
        builder={{
          ...DEFAULT_BUILDER,
          table: 'can_signals',
          timeColumn: 'ts_ms',
          select: [{ column: 'value', aggregate: 'avg' }],
          where: {
            conjunction: 'AND',
            children: [
              { kind: 'condition', condition: { key: 'platform', operator: '=', value: 'A' } },
              {
                kind: 'group',
                group: {
                  conjunction: 'OR',
                  children: [{ kind: 'condition', condition: { key: 'signal', operator: '=', value: 'x' } }],
                },
              },
            ],
          },
        }}
        format="time_series"
        datasource={datasource}
        generatedSQL=""
        onChange={onChange}
        onRunQuery={() => {}}
      />
    );

    // The nested group's row is the second one.
    fireEvent.click(screen.getAllByLabelText('remove filter')[1]);

    const next = onChange.mock.calls[0][0] as BuilderState;
    expect(next.where?.children).toHaveLength(1);
    expect(next.where?.children[0].kind).toBe('condition');
  });
});
