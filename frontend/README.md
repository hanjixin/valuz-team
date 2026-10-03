# frontend/packages

`@valuz/ui`, `@valuz/shared`, and `@valuz/a2ui` are copied from valuz-agent
(`frontend/packages/{ui,shared,a2ui}`, tests and demos left out) so `apps/web`
builds on the same design system instead of re-implementing it. Package names
and the directory layout are kept identical — `shared` reaches the locale files
at `../../i18n/locales` by relative path — so files can be re-synced from
upstream without edits. Licensed under `frontend/LICENSE`.
