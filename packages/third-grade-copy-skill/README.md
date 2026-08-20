# @ventora/third-grade-copy-skill

Packaged copy of the `third-grade-copy` Codex/Agents/Claude skill.

## Install from this repo

```powershell
pnpm --filter @ventora/third-grade-copy-skill exec third-grade-copy-skill install --target all
```

## Install in another repo

Add this package as a dependency from your package registry or git source, then run:

```powershell
pnpm exec third-grade-copy-skill install --target all
```

Use `--target codex`, `--target agents`, or `--target claude` to install into one skill root. Use `--root <skills-dir>` for a custom skill directory.

## Use programmatically

```js
import { getSkillPath, installSkill } from "@ventora/third-grade-copy-skill";

console.log(getSkillPath());
installSkill("C:\\Users\\<you>\\.codex\\skills");
```

## Verify

```powershell
pnpm --filter @ventora/third-grade-copy-skill run verify
```
