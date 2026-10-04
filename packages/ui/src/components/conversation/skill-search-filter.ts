/** Pure skill-search helpers. Kept in a non-component module so the predicate
 *  can be shared between the menu and the composer's open/close gate without
 *  tripping react-refresh's "only export components" rule on the .tsx file. */

export interface SkillSearchItem {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  icon?: string;
}

/** Case-insensitive substring match over name + description. The single source
 *  of truth for "does any skill match this query?" — the menu renders with it
 *  and the composer gates the popup's visibility (and Enter capture) with it,
 *  so the two can never drift. An empty query matches every skill (the bare
 *  ``/`` discovery case); a ``/command`` that names no skill matches nothing,
 *  which the composer treats as a pass-through command. */
export const filterSkillItems = (
  skills: SkillSearchItem[],
  query: string,
): SkillSearchItem[] => {
  const q = query.toLowerCase();
  return skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description ? s.description.toLowerCase().includes(q) : false),
  );
};
