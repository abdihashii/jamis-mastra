import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		semi: true,
		quotes: 'single',
		indent: 'tab',
	},
	// cloud-init requires the literal `#cloud-config` on line 1. The yaml comment
	// spacing rule rewrites it to `# cloud-config`, which silently disables the file.
	//
	// Plan docs: eslint lints fenced code blocks as source. Their snippets are
	// deliberately partial, so they fail on indentation and missing semicolons
	// that would be wrong to "fix" in prose.
	ignores: ['infra/cloud-init.yaml', 'docs/**/*.md'],
});
