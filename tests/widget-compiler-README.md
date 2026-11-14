# Complete STX author qualification

The standalone artifact consumer and the authored program are separate gates. The original generic checker treated native client methods as free functions and template `this` as module `this`, producing false context errors. The owning stx fix derives the native instance from metadata and actual method types, preserves mapped columns, and checks native loop aliases lexically. It also exposes genuine author errors rather than weakening their types.

The four data-bearing HQ widgets now declare precise `ComponentState` shapes, typed response contracts, DOM event-target guards and narrowed caught errors. These declarations initialize no runtime state. Metadata properties retain their native primitive/array/object contract; private fields remain optional before initialization. There are no `any` receiver/index signatures, suppressions or casts added to make the widgets pass.

The shared head partial intentionally inherits `pageTitle`, `pageDescription` and `canonicalPath` through the renderer's copied context, rather than `props`. Its type-only `InheritedContext` declares those three optional strings. The owner checker follows actual static page → layout → include paths and checks the leaf caller's server values, layout overrides and explicit include data. A wrong numeric title or missing required field fails at the authored include/layout callsite. Dynamic paths and unresolved/cyclic/deep graphs report an explicit proof gap. No global declaration whitelist replaces these checks.

Source qualification on 2026-11-14 UTC, with installed native Stacks 0.75.579 and the owning stx checker source: `resources/**/*.stx` checked 26 files, 38 script blocks and 1,069 expressions with zero diagnostics. This includes all five custom elements, layouts and the head partial. The installed app is still pinned to stx 0.2.872 until the owner patch is published and consumed; source qualification alone is not the published-package gate.

The owner tests cover property/method errors, metadata defaults, private-state refinement, generic methods across client blocks, lexical nested/object loops, page/server isolation and authored positions. Existing native WebView tests also passed against Chrome for Testing 157.0.8103.50. A standalone Node + TypeScript 5.9.3 language-service fixture loaded the actual bundled editor plugin without Bun and reported only the two intended property/method errors at line 4. The editor uses its supplied TypeScript parser and its actual referenced declaration inventory, without adding duplicate browser globals.

After installing the published owner patch, the release gate is the ordinary complete command, with no native-component exclusions:

```sh
bun run typecheck:views
```
