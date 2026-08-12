import { BuilderCondition, BuilderGroup, BuilderNode, BuilderState, Conjunction } from '../types';

/**
 * The WHERE predicate as a tree, whatever shape the panel was saved in.
 *
 * `where` is canonical. `filters` is the flat AND-only list the builder used before
 * nested groups existed (sc-74551); panels saved then are migrated on read rather than
 * kept alive as a second code path, so there is exactly one thing to generate SQL from
 * and one thing for the UI to edit.
 */
export function whereTree(state: BuilderState): BuilderGroup {
  if (state.where) {
    return state.where;
  }
  return {
    conjunction: 'AND',
    children: (state.filters ?? []).map((condition) => ({ kind: 'condition', condition }) as BuilderNode),
  };
}

export function conditionNode(condition: BuilderCondition): BuilderNode {
  return { kind: 'condition', condition };
}

export function groupNode(group: BuilderGroup): BuilderNode {
  return { kind: 'group', group };
}

export function newGroup(conjunction: Conjunction = 'AND', children: BuilderNode[] = []): BuilderGroup {
  return { conjunction, children };
}

/** A condition is only worth generating or sending once it names a column and a value. */
export function isFilled(condition: BuilderCondition): boolean {
  return (condition.key ?? '').trim() !== '' && (condition.value ?? '').trim() !== '';
}

/** How many children would actually produce SQL. Drives whether a group needs brackets. */
export function effectiveChildCount(group: BuilderGroup): number {
  let n = 0;
  for (const child of group.children) {
    if (child.kind === 'condition') {
      if (isFilled(child.condition)) {
        n++;
      }
    } else if (effectiveChildCount(child.group) > 0) {
      n++;
    }
  }
  return n;
}

/** Every filled condition anywhere in the tree, regardless of conjunction. */
export function allConditions(group: BuilderGroup): BuilderCondition[] {
  const out: BuilderCondition[] = [];
  for (const child of group.children) {
    if (child.kind === 'condition') {
      if (isFilled(child.condition)) {
        out.push(child.condition);
      }
    } else {
      out.push(...allConditions(child.group));
    }
  }
  return out;
}

/** Every column named anywhere in the tree, filled in or not, so "+" can land on a
 *  partition column nobody has used yet. */
export function conditionKeys(group: BuilderGroup): string[] {
  const out: string[] = [];
  for (const child of group.children) {
    if (child.kind === 'condition') {
      out.push((child.condition.key ?? '').trim());
    } else {
      out.push(...conditionKeys(child.group));
    }
  }
  return out;
}

/**
 * Conditions from this subtree that hold for EVERY row the subtree matches.
 *
 * Under `AND` that is all of them. Under `OR` it is none: `a OR b` guarantees only that
 * one of the two held, so neither may be used to narrow anything. A single-child group
 * is a degenerate case — with nothing to disjoin, `OR` and `AND` mean the same thing —
 * so it is treated as definite rather than throwing information away.
 */
function definiteConditions(group: BuilderGroup): BuilderCondition[] {
  if (group.conjunction === 'OR' && effectiveChildCount(group) > 1) {
    return [];
  }
  const out: BuilderCondition[] = [];
  for (const child of group.children) {
    if (child.kind === 'condition') {
      if (isFilled(child.condition)) {
        out.push(child.condition);
      }
    } else {
      out.push(...definiteConditions(child.group));
    }
  }
  return out;
}

/**
 * The conditions guaranteed to hold alongside child `index` of `group`.
 *
 * This is what a value dropdown may narrow by. Passing anything else would offer values
 * that cannot co-exist with the rest of the predicate — the failure sc-74547 fixed, and
 * the reason `OR` could not simply be bolted onto the old flat list.
 *
 * `inherited` carries the guarantees established by ancestor groups, so the rule
 * composes down the tree without needing to know the path.
 */
export function guaranteedFor(group: BuilderGroup, inherited: BuilderCondition[], index: number): BuilderCondition[] {
  // Nothing in an OR group is guaranteed alongside its siblings.
  if (group.conjunction === 'OR' && effectiveChildCount(group) > 1) {
    return inherited;
  }
  const out = [...inherited];
  group.children.forEach((child, i) => {
    if (i === index) {
      return;
    }
    if (child.kind === 'condition') {
      if (isFilled(child.condition)) {
        out.push(child.condition);
      }
    } else {
      out.push(...definiteConditions(child.group));
    }
  });
  return out;
}

/** Replace one child, returning a new group. */
export function withChild(group: BuilderGroup, index: number, child: BuilderNode): BuilderGroup {
  const children = [...group.children];
  children[index] = child;
  return { ...group, children };
}

/** Remove one child, returning a new group. */
export function withoutChild(group: BuilderGroup, index: number): BuilderGroup {
  return { ...group, children: group.children.filter((_, i) => i !== index) };
}

export function withAppended(group: BuilderGroup, child: BuilderNode): BuilderGroup {
  return { ...group, children: [...group.children, child] };
}

/**
 * Drop bracketed groups that have nothing left in them.
 *
 * Removing a group's last condition otherwise leaves `{conjunction, children: []}` in the
 * tree, which renders as an orphaned `AND (`: no rows, no closing bracket, and nothing
 * that can delete it, because the remove-group control lives on the group's last row —
 * the one just removed. The + underneath belongs to the OUTER group, so it adds a sibling
 * instead of filling the bracket, and the group is stuck there for good.
 *
 * Applied at the root after every edit, so a removal anywhere in the tree is cleaned up in
 * one place. Recursive: a group holding only empty groups is itself empty.
 *
 * The root is exempt — an empty root is the normal "no filters yet" state and has its own
 * WHERE row to add the first condition.
 */
export function prune(group: BuilderGroup): BuilderGroup {
  const children: BuilderNode[] = [];
  for (const child of group.children) {
    if (child.kind === 'condition') {
      children.push(child);
      continue;
    }
    const inner = prune(child.group);
    // An unfilled condition still counts: the user is mid-edit, and deleting the row they
    // just added would be worse than a bracket that is briefly incomplete.
    if (inner.children.length > 0) {
      children.push(groupNode(inner));
    }
  }
  return { ...group, children };
}
