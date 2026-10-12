import antfu from '@antfu/eslint-config';
import sql from 'eslint-plugin-sql';

const sqlFormatting = { language: 'postgresql', useTabs: true, tabWidth: 4 };

export default antfu({
	stylistic: {
		semi: true,
		quotes: 'single',
		indent: 'tab',
		overrides: {
			'style/max-len': ['error', { code: 120, ignoreUrls: true, ignoreTemplateLiterals: true }],
		},
	},
	// cloud-init requires the literal `#cloud-config` on line 1. The yaml comment
	// spacing rule rewrites it to `# cloud-config`, which silently disables the file.
	//
	// Plan docs: eslint lints fenced code blocks as source. Their snippets are
	// deliberately partial, so they fail on indentation and missing semicolons
	// that would be wrong to "fix" in prose.
	ignores: ['infra/cloud-init.yaml', 'docs/**/*.md'],
}, {
	files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
	// Each rule configuration accepts one SQL tag.
	plugins: { sql, sqlTx: sql },
	rules: {
		// shortcut: inline SQL loses nesting indentation; use multiline templates to enable formatting.
		'sql/format': ['error', { sqlTag: 'sql' }, sqlFormatting],
		'sqlTx/format': ['error', { sqlTag: 'tx' }, sqlFormatting],
	},
});
