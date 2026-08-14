import { BuilderFilter } from '../types';
import { partitionValuesParams } from './filters';

// can_signals partition spec order.
const SPEC = ['platform', 'device', 'route', 'channel', 'sender_node', 'frame_name', 'signal'];

const f = (key: string, value: string, operator: BuilderFilter['operator'] = '='): BuilderFilter => ({
  key,
  operator,
  value,
});

describe('partitionValuesParams', () => {
  it('always sends the table and column', () => {
    expect(partitionValuesParams('can_signals', 'signal', [], SPEC)).toEqual({
      table: 'can_signals',
      column: 'signal',
    });
  });

  // The bug: a second filter offered every value of its column, so picking one that
  // cannot co-exist with the first returned no rows and no explanation.
  it('narrows by an ancestor filter that is already set', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('frame_name', 'ACCDATA')], SPEC);
    expect(params).toEqual({ table: 'can_signals', column: 'signal', frame_name: 'ACCDATA' });
  });

  it('sends every ancestor, not just the nearest', () => {
    const params = partitionValuesParams(
      'can_signals',
      'signal',
      [f('platform', 'FORD'), f('frame_name', 'ACCDATA')],
      SPEC
    );
    expect(params.platform).toBe('FORD');
    expect(params.frame_name).toBe('ACCDATA');
  });

  // The bug behind "where sequence doesn't work": narrowing used to be dropped unless
  // the filter's column sat EARLIER in the partition spec, so whether a filter took
  // effect depended on an ordering the user cannot see. Measured against the live
  // catalog, a deeper column narrows perfectly well -- sender_node is 44 values
  // unfiltered and 1 narrowed by frame_name, which sits below it in the spec.
  it('narrows by a descendant filter', () => {
    const params = partitionValuesParams('can_signals', 'sender_node', [f('frame_name', 'ACCDATA')], SPEC);
    expect(params.frame_name).toBe('ACCDATA');
  });

  it('narrows by the deepest column of all', () => {
    const params = partitionValuesParams('can_signals', 'platform', [f('signal', 'AccBrkTot_A_Rq')], SPEC);
    expect(params.signal).toBe('AccBrkTot_A_Rq');
  });

  // Position-independence is the actual requirement. Looking up a column in the MIDDLE
  // of the spec used to honour only the filters above it and drop the ones below, so the
  // same two choices narrowed or did nothing depending on which row you opened.
  it('sends every set filter regardless of its position in the spec', () => {
    const params = partitionValuesParams(
      'can_signals',
      'sender_node',
      [f('platform', 'CHEVROLET_BOLT_EUV'), f('frame_name', 'ACCDATA'), f('signal', 'AccBrkTot_A_Rq')],
      SPEC
    );
    expect(params).toEqual({
      table: 'can_signals',
      column: 'sender_node',
      platform: 'CHEVROLET_BOLT_EUV',
      frame_name: 'ACCDATA',
      signal: 'AccBrkTot_A_Rq',
    });
  });

  it('does not depend on the order the filter rows were added in', () => {
    const filters = [f('platform', 'CHEVROLET_BOLT_EUV'), f('frame_name', 'ACCDATA')];
    const forward = partitionValuesParams('can_signals', 'sender_node', filters, SPEC);
    const reversed = partitionValuesParams('can_signals', 'sender_node', [...filters].reverse(), SPEC);
    expect(forward).toEqual(reversed);
    expect(forward.frame_name).toBe('ACCDATA');
  });

  // can_signals reports ["platform",...,"signal","channel_name"] -- channel_name after
  // signal, because the list accumulates across schema changes rather than describing a
  // hierarchy. Depth-based rules silently mis-handle a list like that.
  it('narrows even when the spec is not in hierarchy order', () => {
    const outOfOrder = [...SPEC, 'channel_name'];
    const params = partitionValuesParams('can_signals', 'signal', [f('channel_name', 'CAN1')], outOfOrder);
    expect(params.channel_name).toBe('CAN1');
  });

  it('ignores a filter on the same column', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('signal', 'other')], SPEC);
    expect(params.signal).toBeUndefined();
  });

  // A partition is a directory; a range does not identify one.
  it.each([['!='], ['>'], ['<'], ['>='], ['<=']])('ignores the %s operator', (op) => {
    const params = partitionValuesParams(
      'can_signals',
      'signal',
      [f('frame_name', 'ACCDATA', op as BuilderFilter['operator'])],
      SPEC
    );
    expect(params.frame_name).toBeUndefined();
  });

  it('ignores a column that is not part of the partition spec', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('value', '42')], SPEC);
    expect(params.value).toBeUndefined();
  });

  it('ignores filters with no value yet', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('frame_name', '')], SPEC);
    expect(params.frame_name).toBeUndefined();
  });

  // Nothing may shadow the two reserved parameters, or the lookup silently asks about
  // a different table or column than the row displays.
  it.each([['table'], ['column']])('never lets a filter overwrite %s', (reserved) => {
    const params = partitionValuesParams('can_signals', 'signal', [f(reserved, 'hijacked')], [...SPEC, reserved]);
    expect(params.table).toBe('can_signals');
    expect(params.column).toBe('signal');
  });

  // With no spec loaded yet there are no known ancestors, so nothing is narrowed and
  // the caller falls back to the full list rather than sending a wrong constraint.
  it('narrows nothing when the partition spec is unknown', () => {
    const params = partitionValuesParams('can_signals', 'signal', [f('frame_name', 'ACCDATA')], []);
    expect(params).toEqual({ table: 'can_signals', column: 'signal' });
  });
});
