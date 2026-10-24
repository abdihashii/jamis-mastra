# Repository conventions

Keep these instructions concise and focused on project-specific decisions. [1]

## TypeScript file organization

- Keep related code within its owning module. [2] Keep each module directory flat, including tests and fixtures; preserve meaningful module boundaries.
- Use `.test.ts` for tests beside their implementation.
- Use `.fixture.ts` or `.fixture.json` for reusable test fixtures.
- Use `.schema.ts` for shared runtime validators and keep their inferred types beside the schemas. [3]
- Use `.types.ts` for independent shared type definitions. [4]
- Keep private types and validators in their implementation file. Create companion files only when useful. [4]
- Import directly from the owning file; do not add barrel files. [2]
- Apply these conventions to new code. Migrate existing layouts only as an explicitly scoped change.

## Sources

1. [Anthropic: Write an effective CLAUDE.md](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md)
2. [Bulletproof React: Project structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md)
3. [Renovate: Zod schema guideline](https://github.com/renovatebot/renovate/blob/main/docs/development/zod.md#technical-guide)
4. [OpenReplay: Organizing TypeScript type definitions](https://blog.openreplay.com/organize-typescript-type-definitions/)
