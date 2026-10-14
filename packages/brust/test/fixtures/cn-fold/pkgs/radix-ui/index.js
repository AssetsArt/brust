// Stand-in for `radix-ui`: reads the host environment when loaded, which the build evaluator forbids, so an
// evaluation that loaded it would fail. F149 rule 3 re-emits `buttonVariants` without loading this module.
export const marker = typeof process.env.HOME === 'string' ? 'radix' : 'radix'
