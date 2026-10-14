const $factory = $nodes.reduce(($acc, $node) => {
  const $slot = createSlot(`Primitive.${$node}`);
  const $comp = React.forwardRef(($props, $ref) => {
    const { asChild, ...$rest } = $props;
    const $tag = asChild ? $slot : $node;
    if (typeof window !== "undefined") {
      window[Symbol.for("radix-ui")] = true;
    }
    return /* @__PURE__ */ $jsx($tag, {
      ...$rest,
      ref: $ref
    });
  });
  $comp.displayName = `Primitive.${$node}`;
  return { ...$acc, [$node]: $comp };
}, {});
