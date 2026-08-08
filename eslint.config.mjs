// eslint.config.mjs
import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		semi: true,
		quotes: 'single',
		indent: 'tab',
	},
	// cloud-init requires the literal `#cloud-config` on line 1. The yaml comment
	// spacing rule rewrites it to `# cloud-config`, which silently disables the file.
	ignores: ['infra/cloud-init.yaml'],
});
