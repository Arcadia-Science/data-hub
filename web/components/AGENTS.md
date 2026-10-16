# Components

## Accessibility

- Dialogs return focus to the control that opened them.
- Accessible names contain the visible label text.
- A control that is disabled for a reason stays focusable with `aria-disabled` and says why.
- Enter and exit animations use the `animate-in` and `animate-out` classes, so the reduced-motion rule in `web/app/globals.css` turns them off.

## Component APIs

- Add a named `variant` with `cva`, or a separate component, instead of a new boolean prop.
- Build from the shadcn primitives in `web/components/ui/` before you write new ones, and add a new primitive with `npx shadcn add <name>` in `web/`.

## Skills

- `vercel-composition-patterns` (vercel-labs/agent-skills): component APIs, compound components, and variants.
- `web-design-guidelines` (vercel-labs/agent-skills): reviewing UI for accessibility and interface quality.
- `shadcn` (shadcn/ui): adding and composing shadcn components.
- `tanstack-form`, pinned at https://github.com/tanstack-skills/tanstack-skills/tree/6666c1b363325fdd079dd30fa07f6ea7ae4608b5/plugins/tanstack-form/skills/tanstack-form: forms built with `@tanstack/react-form`.
