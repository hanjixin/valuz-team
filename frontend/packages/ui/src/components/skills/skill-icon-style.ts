export const SKILL_ICON_COLORS: Record<string, string> = {
  A: "bg-brand-light text-brand dark:bg-brand-light dark:text-brand-700",
  B: "bg-accent-blue/10 text-accent-blue dark:bg-accent-blue/15 dark:text-accent-blue",
  C: "bg-accent-sky/10 text-accent-sky dark:bg-accent-sky/15 dark:text-accent-sky",
  D: "bg-success-light text-success-text",
  E: "bg-accent-lime/10 text-accent-lime dark:bg-accent-lime/15 dark:text-accent-lime",
  F: "bg-warning-light text-warning-text",
  G: "bg-accent-orange/10 text-accent-orange dark:bg-accent-orange/15 dark:text-accent-orange",
  H: "bg-accent-pink/10 text-accent-pink dark:bg-accent-pink/15 dark:text-accent-pink",
  I: "bg-brand-light text-brand dark:bg-brand-light dark:text-brand-700",
  J: "bg-brand-light text-brand dark:bg-brand-light dark:text-brand-700",
  K: "bg-accent-blue/10 text-accent-blue dark:bg-accent-blue/15 dark:text-accent-blue",
  L: "bg-accent-teal/10 text-accent-teal dark:bg-accent-teal/15 dark:text-accent-teal",
  M: "bg-success-light text-success-text",
  N: "bg-accent-amber/10 text-accent-amber dark:bg-accent-amber/15 dark:text-accent-amber",
  O: "bg-warning-light text-warning-text",
  P: "bg-accent-orange/10 text-accent-orange dark:bg-accent-orange/15 dark:text-accent-orange",
  Q: "bg-accent-fuchsia/10 text-accent-fuchsia dark:bg-accent-fuchsia/15 dark:text-accent-fuchsia",
  R: "bg-brand-light text-brand dark:bg-brand-light dark:text-brand-700",
  S: "bg-accent-blue/10 text-accent-blue dark:bg-accent-blue/15 dark:text-accent-blue",
  T: "bg-accent-teal/10 text-accent-teal dark:bg-accent-teal/15 dark:text-accent-teal",
  U: "bg-success-light text-success-text",
  V: "bg-accent-lime/10 text-accent-lime dark:bg-accent-lime/15 dark:text-accent-lime",
  W: "bg-warning-light text-warning-text",
  X: "bg-error-light text-error-text",
  Y: "bg-accent-fuchsia/10 text-accent-fuchsia dark:bg-accent-fuchsia/15 dark:text-accent-fuchsia",
  Z: "bg-brand-light text-brand dark:bg-brand-light dark:text-brand-700",
};

export const getSkillIconLetter = (name: string): string => {
  const firstLetter = name.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(firstLetter) ? firstLetter : "A";
};

export const getSkillIconStyle = (
  name: string,
): { letter: string; className: string } => {
  const letter = getSkillIconLetter(name);
  const className = SKILL_ICON_COLORS[letter];
  return { letter, className };
};
