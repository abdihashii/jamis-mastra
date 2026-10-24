import antfu from '@antfu/eslint-config';
import commentLength from 'eslint-plugin-comment-length';
import sql from 'eslint-plugin-sql';

const commentFormatting = { maxLength: 120, tabSize: 4, mode: 'overflow-only' };
const sqlFormatting = { language: 'postgresql', useTabs: true, tabWidth: 4 };

export default antfu(
	{
		stylistic: {
			semi: true,
			quotes: 'single',
			indent: 'tab',
			braceStyle: '1tbs',
			overrides: {
				'style/max-len': ['warn', {
					code: 120,
					ignoreComments: true,
					ignoreUrls: true,
					ignoreStrings: true,
					ignoreTemplateLiterals: true,
				}],
			},
		},
		// cloud-init requires the literal `#cloud-config` on line 1. The yaml comment
		// spacing rule rewrites it to `# cloud-config`, which silently disables the file.
		//
		// Plan docs: eslint lints fenced code blocks as source. Their snippets are
		// deliberately partial, so they fail on indentation and missing semicolons
		// that would be wrong to "fix" in prose.
		ignores: ['infra/cloud-init.yaml', 'docs/**/*.md'],
	},
	{
		files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
		// Each rule configuration accepts one SQL tag.
		plugins: { 'comment-length': commentLength, sql, 'sqlTx': sql },
		rules: {
			'perfectionist/sort-imports': ['error', { environment: 'bun' }],
			'comment-length/limit-single-line-comments': ['error', commentFormatting],
			'comment-length/limit-multi-line-comments': ['error', commentFormatting],
			// shortcut: inline SQL loses nesting indentation; use multiline templates to enable formatting.
			'sql/format': ['error', { sqlTag: 'sql' }, sqlFormatting],
			'sqlTx/format': ['error', { sqlTag: 'tx' }, sqlFormatting],
		},
	},
);
